// Confined `read` for resident roles.
//
// pi's built-in read tool reads any path the agent's OS user can read. A
// resident agent runs unattended behind its service unit and answers a chat
// surface, so that reach includes the agent's OWN credentials — its Flair
// identity key, a chat bot token file, a capability key file, and the provider
// login store. A resident role that opts into `read` gets a confined one
// instead: bob hands pi a custom tool named `read` (pi's tool registry is keyed
// by name and a later tool wins), so pi's unconfined read is never reachable.
//
// What the confined read refuses:
//   * any path that does not resolve inside the agent's workspace root — the
//     request and the root are both resolved by realpath, so a symlink is
//     followed and a `..` segment is resolved away before the check;
//   * any file bob.yaml names as a key or token file, plus the provider login
//     store — refused even when it sits inside the workspace.
//
// The check-then-delegate shape (validate the path, then run pi's read) has the
// same cross-process race anchored-edit documents: a symlink swapped between the
// check and the read is not caught. Closing that needs an OS boundary, which is
// tracked separately; nothing here replaces it.

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve as resolvePath,
  sep,
} from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";

// The bob.yaml/capability-config keys that name a key or token FILE. The
// authority is the shipped capability config schemas — discord.tokenFile,
// flair.keyFile, presence.keyFile, observatory.officeKeyFile — plus bob.yaml's
// own `identity.key_file` and top-level `flair.keyFile` (bob init writes both
// spellings). A future capability that adds a path-bearing credential key must
// add it here.
export const CREDENTIAL_FILE_KEYS: ReadonlySet<string> = new Set([
  "tokenFile",
  "keyFile",
  "officeKeyFile",
  "token_file",
  "key_file",
  "office_key_file",
]);

// The provider login store pi writes under the agent's .pi-agent dir. It holds
// the provider API keys, so it is a credential even though bob.yaml never names
// it.
export const PROVIDER_LOGIN_STORE = "auth.json";

// Every key/token file bob.yaml names, read straight from the text (bob.yaml's
// `identity:`, top-level `flair:` and every capability block are all covered by
// scanning for the known keys), plus the provider login store. Values may be
// absolute or `~`-relative; the caller resolves them.
export function credentialPathsFromYaml(yamlText: string): string[] {
  const out: string[] = [];
  for (const rawLine of yamlText.split(/\r?\n/)) {
    // Drop a trailing comment, but only when it is separated by whitespace, so a
    // `#` inside a value is left alone.
    const line = rawLine.replace(/\s+#.*$/, "");
    const m = /^\s*(?:-\s*)?([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/.exec(line);
    if (!m || !CREDENTIAL_FILE_KEYS.has(m[1])) continue;
    const value = stripQuotes(m[2].trim());
    if (value.length > 0) out.push(value);
  }
  return out;
}

function stripQuotes(s: string): string {
  if (
    s.length >= 2 &&
    ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
  ) {
    return s.slice(1, -1);
  }
  return s;
}

// The credential paths for a session: everything bob.yaml names, plus the
// provider login store. `piAgentDir` is `<agentDir>/.pi-agent`.
export function sessionCredentialPaths(yamlText: string, piAgentDir: string): string[] {
  const paths = new Set<string>([join(piAgentDir, PROVIDER_LOGIN_STORE)]);
  for (const p of credentialPathsFromYaml(yamlText)) paths.add(p);
  return [...paths];
}

export interface ConfineReadOptions {
  // The agent's workspace root (the session cwd). Reads must land inside it.
  workspaceRoot: string;
  // Key/token files + the provider login store. Refused even inside the root.
  credentialPaths: readonly string[];
}

// Resolve a requested path the way pi's read does: `~` expands to the home dir,
// an absolute path is used as-is, and a relative path resolves against the
// workspace root.
function resolveRequestedPath(p: string, cwd: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return isAbsolute(p) ? p : resolvePath(cwd, p);
}

// A path's realpath when it resolves; otherwise the realpath of its existing
// parent with the basename reattached (a dangling symlink or a not-yet-existing
// target), falling back to the plain resolved path. This keeps the check total
// instead of throwing on a path that does not exist yet.
function realpathOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    // fall through
  }
  try {
    return join(realpathSync(dirname(p)), basename(p));
  } catch {
    return resolvePath(p);
  }
}

// Throw unless the requested path is an allowed read. Returns the resolved
// target so a caller can reuse it.
export function assertReadAllowed(requested: unknown, opts: ConfineReadOptions): string {
  if (typeof requested !== "string" || requested.trim() === "") {
    throw new Error("bob: refusing to read: a path is required.");
  }
  let root: string;
  try {
    root = realpathSync(opts.workspaceRoot);
  } catch {
    throw new Error(
      `bob: refusing to read "${requested}": the agent's workspace root is not readable.`,
    );
  }
  const target = realpathOrResolved(resolveRequestedPath(requested, root));
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(
      `bob: refusing to read "${requested}": it resolves outside the agent's workspace.`,
    );
  }
  for (const cred of opts.credentialPaths) {
    if (realpathOrResolved(resolveRequestedPath(cred, root)) === target) {
      throw new Error(
        `bob: refusing to read "${requested}": it is a credential path (a key or token file bob.yaml names, or the provider login store).`,
      );
    }
  }
  return target;
}

// A pi read tool definition confined to `workspaceRoot`, with `credentialPaths`
// refused even inside it. Same shape as pi's own read, with the check run before
// the read.
export function createConfinedReadToolDefinition(
  workspaceRoot: string,
  credentialPaths: readonly string[],
): ToolDefinition {
  const base = createReadToolDefinition(workspaceRoot);
  const opts: ConfineReadOptions = { workspaceRoot, credentialPaths };
  const confined: typeof base = {
    ...base,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      assertReadAllowed(params.path, opts);
      return base.execute(toolCallId, params, signal, onUpdate, ctx);
    },
  };
  return confined as unknown as ToolDefinition;
}

// The custom tools a session needs. A resident session that allows `read` gets
// the confined read; anything else (a non-resident `bob run`, the setup session,
// a resident role that dropped read) gets none — pi's own read is fine there.
// bob#230: the setup session is deliberately NOT confined — it must read the
// seed soul at `<agentDir>/soul.md`, which is outside its workspace root, and it
// runs locally before any chat surface exists.
export function confinedReadCustomTools(
  policy: { resident: boolean; tools: readonly string[]; excludeTools: readonly string[] },
  config: { cwd: string; credentialPaths: readonly string[] },
): ToolDefinition[] {
  if (!policy.resident) return [];
  if (!policy.tools.includes("read")) return [];
  if (policy.excludeTools.includes("read")) return [];
  return [createConfinedReadToolDefinition(config.cwd, config.credentialPaths)];
}
