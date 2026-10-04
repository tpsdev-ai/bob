// Bob capability: work — the managed `run` tool (bob#211), a pi extension.
//
// A Bob capability IS a pi extension: a default-export factory
// `(pi: ExtensionAPI) => void | Promise<void>`. This file is the thin adapter:
// validate the (empty) config → read the launcher-supplied task binding
// (bob#275, S2a) from the environment → wire run / run_status / run_cancel /
// apply_patch (wireWork) → wait for the boot sweep, which cancels and reports
// jobs left behind by a bob run whose supervisor died.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wireWork } from "./capability.js";
import { loadConfigFromEnv } from "./config.js";
import { parseTaskBinding, TASK_BINDING_ENV, TaskBindingError } from "./task-binding.js";

export default async function (pi: ExtensionAPI): Promise<void> {
  // Validate the (empty) config block so a bad bob.yaml block fails at load.
  loadConfigFromEnv();
  // The launcher-supplied task binding, set by the ONE session factory
  // (session.ts) before this extension loads. It is DATA, not authority the
  // model can write: an absent or malformed binding is carried to the
  // capability, which refuses the dependent operation by name rather than
  // failing to load.
  const raw = process.env[TASK_BINDING_ENV];
  let taskBinding: ReturnType<typeof parseTaskBinding>;
  let taskBindingError: string | undefined;
  try {
    taskBinding = parseTaskBinding(raw);
  } catch (err) {
    if (err instanceof TaskBindingError) taskBindingError = err.message;
    else throw err;
  }
  const { bootSweep } = wireWork({
    pi: pi as unknown as Parameters<typeof wireWork>[0]["pi"],
    ...(taskBinding !== undefined ? { taskBinding } : {}),
    ...(taskBindingError !== undefined ? { taskBindingError } : {}),
  });
  await bootSweep;
}

export {
  type ApplyPatchDeps,
  type ApplyPatchOutcome,
  type ApplyPatchParams,
  type ApplyPatchRefusal,
  type ApplyPatchSuccess,
  type ApplyRefusalReason,
  applyPatch,
  type CandidateRecord,
  candidateRecordPath,
  type GitInvocation,
  type GitResult,
  type GitRunner,
} from "./apply-patch.js";
export {
  terminalText,
  type WireWorkOptions,
  type WorkPiLike,
  type WorkSession,
  wireWork,
} from "./capability.js";
export { CONFIG_ENV_VAR, CONFIG_SCHEMA, loadConfigFromEnv, type WorkConfig } from "./config.js";
export { workManifest } from "./manifest.js";
export {
  type CheckReport,
  type CheckRunner,
  type PublishDeps,
  type PublishInput,
  type PublishParams,
  type PublishPhase,
  type PublishPrRequest,
  type PublishRefusalReason,
  type PublishResult,
  type PublishStatus,
  type PushState,
  publish,
  publishJournalPath,
} from "./publish.js";
export {
  bodyWithMarker,
  type CreatePullRequestInput,
  ghPullRequestService,
  githubRepositorySlug,
  type PullRequestRecord,
  type PullRequestService,
  publicationMarker,
} from "./pull-request.js";
export {
  type BootReap,
  CAPTURE_MAX_BYTES,
  type CleanupState,
  DEFAULT_TIMEOUT_S,
  DRAIN_GRACE_MS,
  defaultStateRoot,
  EXCERPT_MAX_BYTES,
  EXCERPT_MAX_LINES,
  GROUP_PRIMITIVES,
  HEARTBEAT_MS,
  HEARTBEAT_STALE_MS,
  type IdentityRead,
  type IdentityReader,
  identityFromProc,
  JobManager,
  type JobManagerOptions,
  type JobReport,
  KILL_GRACE_MS,
  LIMITS_TEXT,
  MAX_LIVE_JOBS,
  MAX_TIMEOUT_S,
  type Outcome,
  PI_PRIMITIVES,
  type ProcIdentity,
  processInstanceId,
  REAP_LIMIT_MS,
  REGISTRY_RETENTION_MS,
  type RegistryEntry,
  RunRefusal,
  readExcerpt,
  readProcIdentity,
  sameIdentity,
} from "./run.js";
export {
  parseTaskBinding,
  TASK_BINDING_ENV,
  type TaskBinding,
  TaskBindingError,
  type TaskMode,
} from "./task-binding.js";
