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
// CLI: it carries exactly the fields the S2a operations read.

export const TASK_BINDING_ENV = "BOB_TASK_BINDING";

export type TaskMode = "build" | "apply";

export interface TaskBinding {
  // The task's identity, from the launcher.
  task_id: string;
  // The publication's identity. Distinct from the task: one task may publish
  // more than once.
  publication_id: string;
  // The git repository the base is read from and the candidate's objects are
  // written to. Absolute.
  repository: string;
  // The agent's workspace. Absolute.
  workspace: string;
  // The full Git commit object ID the candidate is built on.
  base_oid: string;
  // build: the builder may produce the patch artifact. apply: only the
  // authorized artifact, unchanged.
  mode: TaskMode;
  // The directory the patch artifact must lie under. Absolute.
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
  // apply mode pins these; apply_patch requires the artifact and its result to
  // match them.
  patch_sha256?: string;
  expected_tree_oid?: string;
}

// The binding is malformed. Carries the stable refusal reason the capability
// reports: a session holding a bad binding refuses dependent operations, it
// does not fail to load.
export class TaskBindingError extends Error {
  readonly reason = "invalid_binding" as const;
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
