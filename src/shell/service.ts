// Service install + lifecycle (`bob install-service` / `up` / `down` / `restart`).
//
// The agent owns its runtime (spec §3): each agent runs as its OWN OS service
// unit hosting the persistent process (`bob run <agent>` → runPersistent). Bob
// installs the unit; Bob does NOT babysit the process — the init system restarts
// it on crash (launchd KeepAlive / systemd Restart=always) and starts it on
// login/boot.
//
// TWO BACKENDS, ONE API:
//   * macOS → launchd user-agent (~/Library/LaunchAgents/<label>.plist), driven
//     by launchctl bootstrap/bootout/kickstart.
//   * Linux → systemd USER unit (~/.config/systemd/user/bob-<name>.service),
//     driven by `systemctl --user`. A USER unit (not system) keeps install
//     sudo-free and mirrors launchd's user-agent model. NOTE: for an agent to
//     stay up across logout / reboot on a headless host, enable lingering once:
//     `loginctl enable-linger <user>` (a one-time host setup, not bob's job).
// installService / up / down / restart dispatch on the host platform, override-
// able via ServiceOpsDeps.platform (CI runs on Linux, so tests pin it).
//
// SECURITY (Sherlock): the generated unit NEVER embeds the bot token or any
// secret. Capabilities read their secrets from FILE PATHS in bob.yaml at
// runtime. The unit references only the agent NAME + the bob binary.
//
// TESTABILITY: every OS interaction is injected (writeFile + the launchctl /
// systemctl runners + uid + platform), so tests never touch real dirs or the
// real init system.

import { spawnSync } from "node:child_process";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, sep } from "node:path";

// Strict class init.ts/run.ts use — agent names are filesystem paths AND get
// embedded in the unit Label / file name / ExecStart, so this doubles as path,
// XML, and unit-injection defense (no `..`, `/`, `<`, whitespace, newlines).
const AGENT_NAME = /^[a-z0-9-]+$/;

export type ServicePlatform = "launchd" | "systemd";

// Resolve which backend to use. darwin → launchd; everything else → systemd.
// Injectable for tests via ServiceOpsDeps.platform.
export function detectPlatform(override?: ServicePlatform): ServicePlatform {
  if (override) return override;
  return process.platform === "darwin" ? "launchd" : "systemd";
}

function assertName(name: string): void {
  if (!AGENT_NAME.test(name)) {
    throw new Error(`invalid agent name: ${JSON.stringify(name)} (must match ${AGENT_NAME})`);
  }
}

// The Node version range the package requires. Mirrors package.json's
// `engines.node`; the install-time refusal below names it as the remedy.
const NODE_ENGINES_FLOOR = ">=22.19.0";

// Ownership and mode of a directory, symlinks followed: what the trust screen
// reads. The default source is fs.statSync.
export interface PathOwnership {
  uid: number;
  gid: number;
  mode: number;
}

export interface NodeResolutionDeps {
  // The installing process's own interpreter. Defaults to process.execPath.
  execPath?: string;
  // The installing process's PATH. Defaults to process.env.PATH.
  pathEnv?: string;
  // Whether a candidate path is a REGULAR EXECUTABLE file. Defaults to an fs
  // check (regular file + X_OK); injected in tests.
  isExecutable?: (file: string) => boolean;
  // The installer's uid. The trust screen accepts directories owned by this uid
  // or by root. Defaults to process.getuid().
  getUid?: () => number;
  // Ownership and mode of a directory (symlinks followed). Defaults to
  // fs.statSync. A throw makes the candidate UNTRUSTED. Injected in tests.
  statPath?: (path: string) => PathOwnership;
  // The host's administrators group. A directory owned by the installer or by
  // root, and writable by its owner and this group but by no one else, is
  // accepted: a policy that TRUSTS this group.
  // Defaults to 80 (`admin`) on macOS, for Homebrew prefixes that are
  // admin-writable (observed: /opt/homebrew/bin as drwxrwxr-x <user> admin),
  // and to null elsewhere (then group write passes only in a sticky ancestor).
  // Injected in tests.
  adminGid?: number | null;
}

// The group-write and other-write permission bits, the other-write bit alone,
// and the sticky bit.
const GROUP_OR_OTHER_WRITE = 0o022;
const OTHER_WRITE = 0o002;
const STICKY = 0o1000;
// Symlink hops followed while screening one candidate (Linux's MAXSYMLINKS).
const MAX_SYMLINK_HOPS = 40;
// macOS's `admin` group.
const DARWIN_ADMIN_GID = 80;

interface TrustContext {
  uid: number;
  adminGid: number | null;
  statPath: (path: string) => PathOwnership;
}

// Whether one directory on the way to a candidate interpreter is trusted. Every
// directory must be owned by the installer or by root; a failed stat is
// untrusted. A HOLDER, a directory whose entry the resolution depends on
// directly (it holds a symlink met on the way, or the final name of the
// candidate or of a symlink target), must be writable by no one but its owner,
// except that write by the host's administrators group is accepted (a policy
// that trusts that group) in any directory that is not other-writable. An
// ANCESTOR, any other directory traversed, may also be group- or other-writable
// when it has the sticky bit (as /tmp does), which stops others renaming
// entries they do not own.
function directoryTrusted(dir: string, role: "holder" | "ancestor", ctx: TrustContext): boolean {
  let st: PathOwnership;
  try {
    st = ctx.statPath(dir);
  } catch {
    return false;
  }
  if (st.uid !== ctx.uid && st.uid !== 0) return false;
  if ((st.mode & GROUP_OR_OTHER_WRITE) === 0) return true;
  if ((st.mode & OTHER_WRITE) === 0 && ctx.adminGid !== null && st.gid === ctx.adminGid) {
    return true;
  }
  return role === "ancestor" && (st.mode & STICKY) !== 0;
}

// One name for the walk to look up, and whether the directory it is looked up
// in must pass the HOLDER rule: true for the final name of the candidate and
// for the final name of every symlink target (the entry the link lands on).
interface WalkStep {
  name: string;
  holder: boolean;
}

// A path's names, its final one marked HOLDER. Trailing "." names are dropped;
// a path left with no name, or whose final name is "..", names no entry for a
// directory to hold, so it yields undefined and the candidate is untrusted.
function walkSteps(path: string): WalkStep[] | undefined {
  const names = path
    .slice(parse(path).root.length)
    .split(sep)
    .filter((n) => n.length > 0);
  while (names.length > 0 && names[names.length - 1] === ".") names.pop();
  if (names.length === 0 || names[names.length - 1] === "..") return undefined;
  return names.map((name, i) => ({ name, holder: i === names.length - 1 }));
}

// Whether a candidate interpreter path is trusted: every directory traversed to
// reach the file passes directoryTrusted. The walk resolves the path one name at
// a time and follows each symlink hop. It applies the HOLDER rule to the
// directory holding each symlink met on the way (intermediate directory links
// included), to the directory holding each symlink target's final name, and to
// the directory holding the candidate's own final name; every other directory
// traversed gets the ANCESTOR rule. So a symlink in an other-writable
// directory, sticky or not, or in one writable by any group but the trusted
// administrators group, is never trusted, whatever it points to: its owner
// could retarget it after the unit is written. A candidate the walk cannot
// follow (a failed lstat or readlink, more than MAX_SYMLINK_HOPS hops, a
// symlink target that names no entry, a non-directory on the way, or a final
// entry that is not a regular file) is untrusted, and so is a relative path.
function interpreterPathTrusted(file: string, ctx: TrustContext): boolean {
  if (!isAbsolute(file)) return false;
  let dir = parse(file).root;
  if (!directoryTrusted(dir, "ancestor", ctx)) return false;
  let pending = walkSteps(file);
  if (pending === undefined) return false;
  let hops = 0;
  while (pending.length > 0) {
    const step = pending.shift() as WalkStep;
    if (step.name === ".") continue;
    if (step.name === "..") {
      dir = dirname(dir);
      continue;
    }
    const last = pending.length === 0;
    if (step.holder && !directoryTrusted(dir, "holder", ctx)) return false;
    const entry = join(dir, step.name);
    let target: string | undefined;
    try {
      const st = lstatSync(entry);
      if (st.isSymbolicLink()) target = readlinkSync(entry);
      else if (last) return st.isFile();
      else if (!st.isDirectory()) return false;
    } catch {
      return false;
    }
    if (target === undefined) {
      dir = entry;
      if (!directoryTrusted(dir, "ancestor", ctx)) return false;
      continue;
    }
    // A symlink met anywhere on the way must sit in a HOLDER-grade directory.
    if (!directoryTrusted(dir, "holder", ctx)) return false;
    hops += 1;
    if (hops > MAX_SYMLINK_HOPS) return false;
    const targetSteps = walkSteps(target);
    if (targetSteps === undefined) return false;
    if (isAbsolute(target)) {
      dir = parse(target).root;
      if (!directoryTrusted(dir, "ancestor", ctx)) return false;
    }
    pending = [...targetSteps, ...pending];
  }
  return false;
}

function defaultIsExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false;
    accessSync(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// The basename of an executable path, without a Windows extension.
function executableBasename(file: string): string {
  const base = basename(file);
  return process.platform === "win32" ? base.replace(/\.exe$/i, "") : base;
}

// A path's realpath (symlinks followed), or undefined when it does not resolve.
// Used only to decide whether a PATH entry names the SAME binary as execPath; a
// path that does not resolve yields no match, and the caller falls back.
function realpathOrUndefined(file: string): string | undefined {
  try {
    return realpathSync(file);
  } catch {
    return undefined;
  }
}

// Whether a path's final component is a symlink. A Homebrew entry such as
// /opt/homebrew/bin/node is a symlink to the versioned target; a versioned
// Cellar entry (…/Cellar/node/<version>/bin/node) is a real file. Detected by
// lstat, so a symlinked PARENT directory does not count as a symlink here.
function isSymlink(file: string): boolean {
  try {
    return lstatSync(file).isSymbolicLink();
  } catch {
    return false;
  }
}

// Resolve an ABSOLUTE Node executable for the unit, at install time.
//
// The unit must run bob under NODE — bin/bob's shebang and package.json's
// `engines` say so — whatever runtime ran install-service. The branch is chosen
// by execPath's BASENAME: `node`, compared case-insensitively, with `.exe`
// dropped on Windows. A "PATH `node`" below is an executable regular file named
// `node` in an absolute PATH entry; nothing checks that it is actually Node.
//
// When execPath's basename is NOT `node` (e.g. a developer runs install-service
// under bun) we use the first trusted PATH `node`; with none, installation is
// REFUSED (the throw names the remedy, and each executable `node` from an
// absolute PATH entry that the trust screen rejected) rather than writing a
// unit that would run bob under a non-Node runtime.
//
// When execPath's basename IS `node` we use execPath itself, with one
// exception. On a Homebrew install execPath can be a versioned target
// (observed: …/Cellar/node/<version>/bin/node), and writing that into the unit
// breaks the service after `brew upgrade node` removes that directory. So the
// first TRUSTED PATH `node`, in PATH order, whose FINAL entry is a symlink with
// the same realpath as execPath is written instead (e.g. /opt/homebrew/bin/node),
// even when a direct match comes earlier on PATH. That path keeps working only
// while whatever maintains the symlink keeps it pointing at a working Node.
// With no trusted matching symlink anywhere on PATH, or when execPath has no
// realpath, we fall back to execPath, which may itself be stable or versioned.
//
// TRUST SCREEN: both branches consider only PATH candidates that pass it. A PATH
// entry that is empty or not absolute (`bin`, `.`) is skipped. A candidate is
// kept only when interpreterPathTrusted accepts the whole path to its file,
// following EVERY symlink on the way (a symlinked PATH directory included):
// every directory owned by the installer or by root; the directory holding each
// symlink met, each symlink target's final name and the candidate's own final
// name writable by no one else (write by the host's administrators group
// excepted); any other directory group- or other-writable only with the sticky
// bit (or, besides its owner, writable only by that administrators group).
// A candidate that fails is skipped, and the resolution continues through PATH
// as if it were absent. The fallback in the `node` branch, execPath itself, is
// the running interpreter and is not screened.
export function resolveNodeExecutable(deps: NodeResolutionDeps = {}): string {
  const execPath = deps.execPath ?? process.execPath;
  const pathEnv = deps.pathEnv ?? process.env.PATH ?? "";
  const isExecutable = deps.isExecutable ?? defaultIsExecutable;
  const delimiter = process.platform === "win32" ? ";" : ":";
  const trust: TrustContext = {
    uid: (deps.getUid ?? (() => process.getuid?.() ?? 0))(),
    adminGid:
      deps.adminGid !== undefined
        ? deps.adminGid
        : process.platform === "darwin"
          ? DARWIN_ADMIN_GID
          : null,
    statPath: deps.statPath ?? ((path) => statSync(path)),
  };

  // Every executable, trusted `node` on the installer's PATH, in PATH order.
  // Only ABSOLUTE entries count, so the unit never depends on the installer's
  // working directory; defaultIsExecutable requires a regular file (a directory
  // named `node` is skipped), and the trust screen above applies.
  const candidates: string[] = [];
  const untrusted: string[] = [];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir || !isAbsolute(dir)) continue;
    const candidate = join(dir, "node");
    if (!isExecutable(candidate)) continue;
    if (interpreterPathTrusted(candidate, trust)) candidates.push(candidate);
    else untrusted.push(candidate);
  }

  if (executableBasename(execPath).toLowerCase() === "node") {
    // execPath's basename is `node`: prefer a trusted PATH `node` whose FINAL
    // entry is a SYMLINK resolving to the SAME file, so a versioned target is
    // written as that symlink path. A direct (non-symlink) match does not help —
    // a versioned Cellar binary on PATH is still versioned — so without a
    // trusted matching symlink anywhere on PATH we fall back to the running
    // interpreter's own path, which can be versioned. A PATH `node` symlinked to
    // a DIFFERENT file is not a match; the first trusted matching symlink in
    // PATH order wins.
    const execReal = realpathOrUndefined(execPath);
    if (execReal !== undefined) {
      for (const candidate of candidates) {
        if (realpathOrUndefined(candidate) !== execReal) continue;
        if (isSymlink(candidate)) return candidate;
      }
    }
    return execPath;
  }

  // execPath's basename is not `node`: use the first trusted PATH `node`.
  if (candidates.length > 0) return candidates[0];
  const skipped =
    untrusted.length > 0
      ? ` Skipped as untrusted: ${untrusted.join(", ")} (to be trusted, every directory on the way must be owned by you or root; the directory holding node and every directory holding a symlink or the entry a symlink points to must not be writable by group or others, and any other directory may be only if it has the sticky bit; on macOS, write access for the admin group, but not for others, is allowed).`
      : "";
  throw new Error(
    `bob install-service: no Node executable found. The service unit must run bob under Node (engines: ${NODE_ENGINES_FLOOR}), not under whichever runtime ran install-service. Install Node ${NODE_ENGINES_FLOOR} and put it on PATH, then re-run.${skipped}`,
  );
}

// The renderers take the resolution deps too: when `interpreter` is not given,
// they resolve it with these (resolveNodeExecutable), so a caller or a test can
// pin the resolution instead of reading the host's PATH and filesystem.
export interface RenderServiceOptions extends NodeResolutionDeps {
  name: string;
  // Absolute path to the `bob` binary the unit runs. Both init systems use a
  // minimal PATH, so this MUST be absolute (the caller resolves it). Required.
  bobBin: string;
  // Absolute path to the interpreter that runs `bobBin`. The unit must run bob
  // under NODE (bin/bob's shebang + package.json engines), whatever runtime ran
  // install-service, so this defaults to the resolved Node executable
  // (resolveNodeExecutable) — never to the installer's own interpreter when
  // that is not Node. Both init systems launch the unit with a minimal PATH, so
  // the interpreter is started by ABSOLUTE path with the bob script as its
  // first argument and PATH is never consulted. installService resolves it once
  // and passes it in; this option is also the direct-renderer / test override.
  // When it is absent, the resolution deps above (NodeResolutionDeps) apply.
  interpreter?: string;
  // Optional model override passed through to `bob run` (→ runPersistent).
  model?: string;
  // The agent's home dir for log paths + WorkingDirectory. Defaults to ~. The
  // agent's working dir is <home>/agents/<name>/work.
  home?: string;
}

// Back-compat alias (the launchd renderer historically took RenderPlistOptions).
export type RenderPlistOptions = RenderServiceOptions;

// The exact argv the unit runs: the resolved interpreter, the bob script, the
// `run` subcommand and any model override. BOTH renderers AND the CLI's printed
// "runs:" line read this ONE list, so the displayed command can never drift from
// what the unit actually executes (e.g. the CLI dropping `--model`).
export function serviceCommandArgs(
  opts: Pick<RenderServiceOptions, "interpreter" | "bobBin" | "name" | "model"> &
    NodeResolutionDeps,
): string[] {
  const args = [opts.interpreter ?? resolveNodeExecutable(opts), opts.bobBin, "run", opts.name];
  if (opts.model) args.push("--model", opts.model);
  return args;
}

// =========================================================================
// launchd (macOS)
// =========================================================================

function guiDomain(uid: number): string {
  return `gui/${uid}`;
}

// The launchd Label for an agent's unit. Stable + unique per agent.
export function serviceLabel(name: string): string {
  return `ai.tpsdev.bob.${name}`;
}

// The plist file path for an agent's unit (per-user LaunchAgents).
export function plistPath(name: string, home: string = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${serviceLabel(name)}.plist`);
}

// Render the per-agent launchd plist. KeepAlive (restart on crash) + RunAtLoad
// (start on login). ProgramArguments run `<interpreter> <bob> run <name>`, so
// the interpreter is resolved by absolute path and the unit never depends on
// launchd's minimal PATH. NO secret.
export function renderPlist(opts: RenderServiceOptions): string {
  assertName(opts.name);
  const home = opts.home ?? homedir();
  const label = serviceLabel(opts.name);
  const workDir = join(home, "agents", opts.name, "work");
  const logDir = join(home, "agents", opts.name);

  const args = serviceCommandArgs(opts);
  const programArgs = args.map((a) => `    <string>${xmlEscape(a)}</string>`).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Generated by 'bob install-service ${xmlEscape(opts.name)}'. Don't edit — re-run to update. -->
<!-- The agent runs itself: KeepAlive restarts on crash, RunAtLoad starts on login. -->
<!-- No credentials here by design: capabilities read theirs from file paths in bob.yaml. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(workDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logDir, "service.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logDir, "service.err.log"))}</string>
</dict>
</plist>
`;
}

// XML-escape a value for safe embedding in the plist. Defense in depth.
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// =========================================================================
// systemd (Linux) — USER unit
// =========================================================================

// The systemd unit name for an agent. Stable + unique per agent.
export function systemdUnitName(name: string): string {
  return `bob-${name}.service`;
}

// The user-unit file path. Lives under ~/.config/systemd/user so install needs
// no sudo (matches launchd's per-user LaunchAgents).
export function systemdUnitPath(name: string, home: string = homedir()): string {
  return join(home, ".config", "systemd", "user", systemdUnitName(name));
}

// Render the per-agent systemd USER unit. Restart=always (restart on crash);
// WantedBy=default.target (start on login/boot when enabled). ExecStart runs
// `<interpreter> <bob> run <name>`, so the interpreter is resolved by absolute
// path and the unit never depends on systemd's minimal PATH. NO secret env, NO
// inline token — see the security note.
// `name` already passed the strict regex, so ExecStart has no whitespace/newline
// injection surface; interpreter/bobBin/model are trusted (an absolute
// interpreter + resolved binary path + a flag).
export function renderSystemdUnit(opts: RenderServiceOptions): string {
  assertName(opts.name);
  const home = opts.home ?? homedir();
  const workDir = join(home, "agents", opts.name, "work");
  const logDir = join(home, "agents", opts.name);

  const args = serviceCommandArgs(opts);
  for (const arg of args) {
    if (arg.includes("\n") || arg.includes("\r") || arg.includes("\0")) {
      throw new Error(
        `refusing ExecStart argument with line breaks or NUL: ${JSON.stringify(arg)} (use a path without line breaks)`,
      );
    }
  }
  const exec = args.map((a) => {
    // systemd syntax: double-quote every argument; backslash-escape \ and "
    // inside; replace % with %% and $ with $$ so systemd passes them
    // through literally (systemd.service: %% is %, $$ is $).
    return `"${a.replace(/%/g, "%%").replace(/\$/g, "$$$$").replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  });

  return `# Generated by 'bob install-service ${opts.name}'. Don't edit — re-run to update.
# The agent runs itself: Restart=always restarts on crash; enable it (bob up) to
# start on login/boot. No credentials here: capabilities read theirs from file
# paths in bob.yaml at runtime.
[Unit]
Description=Bob agent ${opts.name} (self-running persistent session)
After=network-online.target

[Service]
Type=simple
ExecStart=${exec.join(" ")}
WorkingDirectory=${workDir}
Restart=always
RestartSec=5
StandardOutput=append:${join(logDir, "service.out.log")}
StandardError=append:${join(logDir, "service.err.log")}

[Install]
WantedBy=default.target
`;
}

// =========================================================================
// Shared: paths, runners, install + lifecycle (platform-dispatched)
// =========================================================================

// The unit file path for an agent on the resolved platform.
export function servicePath(
  name: string,
  opts: { platform?: ServicePlatform; home?: string } = {},
): string {
  return detectPlatform(opts.platform) === "launchd"
    ? plistPath(name, opts.home)
    : systemdUnitPath(name, opts.home);
}

// Shells out to a command. Injected in tests so we never run real launchctl /
// systemctl. Returns the exit code + stderr; non-zero throws in the wrappers
// (never any secret — there are none in these commands).
export type CommandRunner = (
  cmd: string,
  args: string[],
) => Promise<{ code: number; stderr: string }>;
// Back-compat: the launchd-only runner shape used by existing callers/tests.
export type LaunchctlRunner = (args: string[]) => Promise<{ code: number; stderr: string }>;

// The Node resolution deps (NodeResolutionDeps) resolve the unit's interpreter:
// injected in tests, defaulting to the current process's own interpreter, PATH
// and uid.
export interface ServiceOpsDeps extends NodeResolutionDeps {
  // Write the unit to disk (install-service). Injected in tests.
  writeFile?: (path: string, contents: string) => void;
  // Run launchctl (macOS). Injected in tests.
  runLaunchctl?: LaunchctlRunner;
  // Run systemctl (Linux). Injected in tests.
  runSystemctl?: LaunchctlRunner;
  // Resolve the current uid for the launchd gui domain target. Injected in
  // tests. It is also the installer uid the resolution's trust screen uses.
  getUid?: () => number;
  // Home dir override (tests).
  home?: string;
  // Force a backend (tests; CI runs on Linux). Defaults to the host platform.
  platform?: ServicePlatform;
}

export interface InstallServiceOptions extends RenderServiceOptions, ServiceOpsDeps {}

const defaultWrite = (p: string, c: string) => {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, c, "utf8");
};

const defaultRunLaunchctl: LaunchctlRunner = async (args: string[]) => {
  const r = spawnSync("launchctl", args, { encoding: "utf8" });
  return { code: r.status ?? 1, stderr: r.stderr ?? "" };
};

const defaultRunSystemctl: LaunchctlRunner = async (args: string[]) => {
  const r = spawnSync("systemctl", args, { encoding: "utf8" });
  return { code: r.status ?? 1, stderr: r.stderr ?? "" };
};

async function runOrThrow(runner: LaunchctlRunner, bin: string, args: string[]): Promise<void> {
  const { code, stderr } = await runner(args);
  if (code !== 0) {
    throw new Error(
      `${bin} ${args.join(" ")} failed (exit ${code})${stderr ? `: ${stderr.trim()}` : ""}`,
    );
  }
}

function resolveUid(deps: ServiceOpsDeps): number {
  return (deps.getUid ?? (() => process.getuid?.() ?? 0))();
}

// Write the agent's unit file to disk. Does NOT start it (that's `bob up`). For
// systemd, also runs `systemctl --user daemon-reload` so the new/updated unit is
// picked up. Install + start are separate so re-installing an updated unit while
// it's running is a `down` → `install` → `up` (or `restart`).
export async function installService(
  opts: InstallServiceOptions,
): Promise<{ path: string; interpreter: string; argv: string[] }> {
  const platform = detectPlatform(opts.platform);
  const write = opts.writeFile ?? defaultWrite;
  // Resolve the interpreter ONCE, up front, so a refused install (no Node) writes
  // NOTHING. The renderers receive the resolved absolute path.
  const interpreter = opts.interpreter ?? resolveNodeExecutable(opts);
  const renderOpts: RenderServiceOptions = { ...opts, interpreter };
  // The one command list the renderer writes and the CLI prints.
  const argv = serviceCommandArgs(renderOpts);
  if (platform === "launchd") {
    const path = plistPath(opts.name, opts.home);
    write(path, renderPlist(renderOpts));
    return { path, interpreter, argv };
  }
  const path = systemdUnitPath(opts.name, opts.home);
  write(path, renderSystemdUnit(renderOpts));
  await runOrThrow(opts.runSystemctl ?? defaultRunSystemctl, "systemctl", [
    "--user",
    "daemon-reload",
  ]);
  return { path, interpreter, argv };
}

export interface LifecycleOptions extends ServiceOpsDeps {
  name: string;
}

// `bob up <agent>` — load + start the unit (and enable it to start on boot).
// launchd: bootstrap into the gui domain (RunAtLoad starts it). systemd:
// `enable --now` (start now + start on boot; persistence across logout needs
// `loginctl enable-linger`, a one-time host setup).
export async function up(opts: LifecycleOptions): Promise<void> {
  if (detectPlatform(opts.platform) === "launchd") {
    const path = plistPath(opts.name, opts.home);
    const domain = guiDomain(resolveUid(opts));
    await runOrThrow(opts.runLaunchctl ?? defaultRunLaunchctl, "launchctl", [
      "bootstrap",
      domain,
      path,
    ]);
    return;
  }
  await runOrThrow(opts.runSystemctl ?? defaultRunSystemctl, "systemctl", [
    "--user",
    "enable",
    "--now",
    systemdUnitName(opts.name),
  ]);
}

// `bob down <agent>` — stop + unload the unit. launchd: bootout. systemd:
// `disable --now` (stop + don't start on boot).
export async function down(opts: LifecycleOptions): Promise<void> {
  if (detectPlatform(opts.platform) === "launchd") {
    const path = plistPath(opts.name, opts.home);
    const domain = guiDomain(resolveUid(opts));
    await runOrThrow(opts.runLaunchctl ?? defaultRunLaunchctl, "launchctl", [
      "bootout",
      domain,
      path,
    ]);
    return;
  }
  await runOrThrow(opts.runSystemctl ?? defaultRunSystemctl, "systemctl", [
    "--user",
    "disable",
    "--now",
    systemdUnitName(opts.name),
  ]);
}

// `bob restart <agent>` — GRACEFUL restart. Both send SIGTERM (our persistent
// runtime disposes the session on SIGTERM — awaits in-flight, session.dispose())
// then relaunch. launchd: `kickstart -k`. systemd: `restart`. The session's
// durable on-disk state + Flair memory mean the agent comes back warm. Also the
// "apply changes" step for the evolve loop (align / new capability → restart).
export async function restart(opts: LifecycleOptions): Promise<void> {
  if (detectPlatform(opts.platform) === "launchd") {
    const domain = guiDomain(resolveUid(opts));
    const target = `${domain}/${serviceLabel(opts.name)}`;
    await runOrThrow(opts.runLaunchctl ?? defaultRunLaunchctl, "launchctl", [
      "kickstart",
      "-k",
      target,
    ]);
    return;
  }
  await runOrThrow(opts.runSystemctl ?? defaultRunSystemctl, "systemctl", [
    "--user",
    "restart",
    systemdUnitName(opts.name),
  ]);
}
