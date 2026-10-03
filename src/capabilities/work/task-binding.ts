// The launcher-supplied task binding for the work capability (bob#275, slice
// S2a).
//
// A builder session may CHOOSE its implementation, but the AUTHORITY to build
// is the launcher's, not the model's. The task identity, the repository and
// workspace, the pinned base commit, the mode, the artifact root, the declared
// paths, the required check commands and the publication destination all come
// from the launcher that started the session. This module carries that binding
// through the ONE session factory (session.ts) and into the work capability as
// data, so no model message, tool argument, repository file or agent-writable
// bob.yaml can supply it.
//
// The channel is the environment, the same hand-off every capability config
// uses (capability-loader.ts capabilityEnvVar): the session factory sets
// TASK_BINDING_ENV from RunSessionConfig.taskBinding before the extensions
// load, and the work extension parses it at load. The resolver never reads a
// task binding from bob.yaml, so a task binding cannot be written by the agent.
//
// This is a narrow session-construction interface, not S4's task manifest or
// CLI: it carries the fields the S2a operations read, and the fields a later
// slice reads (S2b).

export const TASK_BINDING_ENV = "BOB_TASK_BINDING";

export type TaskMode = "build" | "apply";

export interface TaskBinding {
  // The task's identity, from the launcher.
  task_id: string;
  // The publication's identity. Distinct from the task: one task may publish
  // more than once.
  publication_id: string;
  repository: string;
  workspace: string;
  // The full Git commit object ID the candidate is built on.
  base_oid: string;
  // build: the builder may produce the patch artifact. apply: only the
  // authorized artifact, unchanged.
  mode: TaskMode;
  artifact_root: string;
  // The paths the task authorizes changing. Read by publication (S2b), not by
  // apply_patch, which never selects paths.
  declared_paths: string[];
  // The commands publication must run (S2b).
  check_commands: string[];
  // The one ref publication may push to.
  destination: { remote: string; ref: string };
  // The optional PR destination, when the task authorizes PR creation.
  pr?: { base: string; head?: string };
  // bob#185 item 5 — the launcher-owned PR reference, when the task is one
  // round of a PR. It is the ONLY source of a per-PR round memory's identity:
  // the key is derived from (agent id, this canonical repository, this number),
  // never from the brief, model output, branch name or a tool argument. The
  // `repository` is a canonical `host/owner/repo` identity (lowercase host, no
  // scheme, no credentials, no trailing slash), and `number` is a positive
  // safe integer. Optional and additive: it changes no existing field.
  pr_ref?: PrRef;
  // apply mode pins these; apply_patch requires the artifact and its result to
  // match them.
  patch_sha256?: string;
  expected_tree_oid?: string;
}

// The launcher-owned PR reference (bob#185 item 5). See TaskBinding.pr_ref.
export interface PrRef {
  repository: string;
  number: number;
}

// The binding is malformed. Carries the stable refusal reason the capability
// reports: a session holding a bad binding refuses dependent operations, it
// does not fail to load.
export class TaskBindingError extends Error {
  readonly reason = "invalid_binding" as const;
}

// A canonical repository identity: exactly three `/`-separated segments —
// `host/owner/repo` — with a lowercase host and no scheme, credentials,
// whitespace, empty segment, `.`/`..` segment or trailing slash. Rejected by
// name rather than silently normalized, so the caller fixes the source.
const CANONICAL_REPO = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\/[a-zA-Z0-9._-]+\/[a-zA-Z0-9._-]+$/;

function canonicalRepository(value: unknown, what: string): string {
  const s = reqString(value, what);
  if (s.includes("://") || s.includes("@") || s.includes(" ") || s.trim() !== s)
    fail(`${what} must be a canonical host/owner/repo identity, not a URL`);
  if (s.includes("//") || s.endsWith("/")) fail(`${what} must not contain an empty segment`);
  for (const part of s.split("/")) {
    if (part === "" || part === "." || part === "..")
      fail(`${what} must not contain an empty, . or .. segment`);
  }
  if (!CANONICAL_REPO.test(s))
    fail(
      `${what} must be a canonical host/owner/repo identity (lowercase host, no trailing slash)`,
    );
  return s;
}

function prNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0)
    fail(`${what} must be a positive safe integer`);
  return value;
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

function fail(what: string): never {
  throw new TaskBindingError(`task binding is invalid: ${what}`);
}

function reqString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.length === 0) fail(`${what} must be a non-empty string`);
  return value;
}

function reqStringArray(value: unknown, what: string): string[] {
  if (!Array.isArray(value)) fail(`${what} must be an array`);
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0)
      fail(`${what} must hold only non-empty strings`);
  }
  return value as string[];
}

function hex(value: unknown, length: 40 | 64, what: string): string {
  const re = length === 40 ? HEX40 : HEX64;
  if (typeof value !== "string" || !re.test(value)) fail(`${what} must be ${length} lowercase hex`);
  return value;
}

function hexOptional(value: unknown, length: 40 | 64, what: string): string | undefined {
  if (value === undefined) return undefined;
  return hex(value, length, what);
}

// Parse and validate a serialized binding. Returns undefined when the input is
// absent or empty (the session has no task: the "unknown task" case). Throws
// TaskBindingError when it is present but malformed.
export function parseTaskBinding(raw: string | null | undefined): TaskBinding | undefined {
  if (raw === null || raw === undefined || raw.trim() === "") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    fail("it is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    fail("it must be a JSON object");
  const o = parsed as Record<string, unknown>;

  const mode = o.mode;
  if (mode !== "build" && mode !== "apply") fail('mode must be "build" or "apply"');

  if (typeof o.destination !== "object" || o.destination === null || Array.isArray(o.destination))
    fail("destination must be an object");
  const destination = o.destination as Record<string, unknown>;

  const binding: TaskBinding = {
    task_id: reqString(o.task_id, "task_id"),
    publication_id: reqString(o.publication_id, "publication_id"),
    repository: reqString(o.repository, "repository"),
    workspace: reqString(o.workspace, "workspace"),
    base_oid: hex(o.base_oid, 40, "base_oid"),
    mode,
    artifact_root: reqString(o.artifact_root, "artifact_root"),
    declared_paths: reqStringArray(o.declared_paths, "declared_paths"),
    check_commands: reqStringArray(o.check_commands, "check_commands"),
    destination: {
      remote: reqString(destination.remote, "destination.remote"),
      ref: reqString(destination.ref, "destination.ref"),
    },
  };

  if (o.pr !== undefined) {
    if (typeof o.pr !== "object" || o.pr === null || Array.isArray(o.pr))
      fail("pr must be an object");
    const pr = o.pr as Record<string, unknown>;
    binding.pr = {
      base: reqString(pr.base, "pr.base"),
      ...(pr.head !== undefined ? { head: reqString(pr.head, "pr.head") } : {}),
    };
  }

  if (o.pr_ref !== undefined) {
    if (typeof o.pr_ref !== "object" || o.pr_ref === null || Array.isArray(o.pr_ref))
      fail("pr_ref must be an object");
    const ref = o.pr_ref as Record<string, unknown>;
    binding.pr_ref = {
      repository: canonicalRepository(ref.repository, "pr_ref.repository"),
      number: prNumber(ref.number, "pr_ref.number"),
    };
  }

  // apply mode pins the authorized digest and resulting tree: both are
  // required, and apply_patch compares against them.
  if (mode === "apply") {
    binding.patch_sha256 = hex(o.patch_sha256, 64, "patch_sha256 (required in apply mode)");
    binding.expected_tree_oid = hex(
      o.expected_tree_oid,
      40,
      "expected_tree_oid (required in apply mode)",
    );
  } else {
    const patch = hexOptional(o.patch_sha256, 64, "patch_sha256");
    const tree = hexOptional(o.expected_tree_oid, 40, "expected_tree_oid");
    if (patch !== undefined) binding.patch_sha256 = patch;
    if (tree !== undefined) binding.expected_tree_oid = tree;
  }

  return binding;
}
