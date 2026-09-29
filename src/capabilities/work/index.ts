// Bob capability: work — the managed `run` tool (bob#211), a pi extension.
//
// A Bob capability IS a pi extension: a default-export factory
// `(pi: ExtensionAPI) => void | Promise<void>`. This file is the thin adapter:
// validate the (empty) config → wire run / run_status / run_cancel
// (wireWork) → wait for the boot sweep, which cancels and reports jobs left
// behind by a bob run whose supervisor died. All logic and tests live in
// run.ts / capability.ts.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wireWork } from "./capability.js";
import { loadConfigFromEnv } from "./config.js";

export default async function (pi: ExtensionAPI): Promise<void> {
  // Validate the (empty) config block so a bad bob.yaml block fails at load.
  loadConfigFromEnv();
  const { bootSweep } = wireWork({
    pi: pi as unknown as Parameters<typeof wireWork>[0]["pi"],
  });
  await bootSweep;
}

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
  type BootReap,
  CAPTURE_MAX_BYTES,
  type CleanupState,
  DEFAULT_TIMEOUT_S,
  DRAIN_GRACE_MS,
  defaultStateRoot,
  EXCERPT_MAX_BYTES,
  EXCERPT_MAX_LINES,
  GROUP_PRIMITIVES,
  JobManager,
  type JobManagerOptions,
  type JobReport,
  KILL_GRACE_MS,
  LIMITS_TEXT,
  MAX_LIVE_JOBS,
  MAX_TIMEOUT_S,
  type Outcome,
  PI_PRIMITIVES,
  REAP_LIMIT_MS,
  REGISTRY_RETENTION_MS,
  type RegistryEntry,
  RunRefusal,
  readExcerpt,
  readLeaderStart,
} from "./run.js";
