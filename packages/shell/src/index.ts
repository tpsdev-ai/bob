// Bob shell — public surface.
//
// The shell is the wiring that every Bob-shaped agent shares:
// identity (Flair Ed25519 pair), mail consumer, Discord bridge, cron
// glue, and role loader. The "form" — soul, tools, model choice — is
// per-role config that gets fed into the shell at init time.
//
// PR-1 ships the type surface + role loader + a stub mail consumer.
// PR-2 will wire the Discord bridge + cron scheduler.

export type BobRole = "ea" | "writer" | "reviewer" | "coder" | "qa" | "custom";

export interface ProviderConfig {
  name: "ollama-cloud" | "ollama-newton" | "exe-dev-gateway" | "anthropic" | "openai" | "omlx";
  model: string;
  fallbacks?: string[];
}

export interface IdentityConfig {
  flair_url: string;
  key_file: string;
  pub_file: string;
}

export interface ChannelsConfig {
  tps_mail?: {
    inbox: string;
  };
  discord?: {
    bot_token_file: string;
    listen_channel_ids: string[];
    reply_via: "webhook" | "bot";
  };
}

export interface CronEntry {
  name: string;
  schedule: string; // cron expression
  prompt: string;
}

export interface BobConfig {
  agent: {
    id: string;
    name: string;
    role: BobRole;
  };
  provider: ProviderConfig;
  identity: IdentityConfig;
  channels: ChannelsConfig;
  cron?: CronEntry[];
}

export { type AlignOptions, type AlignResult, runAlign } from "./align.js";
export { readBlock, readCapabilities } from "./bob-yaml.js";
export type { BobCapabilityManifest, CatalogEntry } from "./capability.js";
export { BLESSED_CATALOG, lookupCapability } from "./capability-catalog.js";
export {
  type CapabilityResolution,
  capabilityConfigEnv,
  capabilityEnvVar,
  type ResolveCapabilitiesOptions,
  type ResolvedCapability,
  resolveCapabilities,
} from "./capability-loader.js";
export type { DiscordClient, DiscordMessage } from "./discord-types.js";
export {
  type CheckStatus,
  type DoctorCheck,
  type DoctorOptions,
  type DoctorReport,
  formatReport,
  runDoctor,
} from "./doctor.js";
export {
  type FlairPairOptions,
  type FlairPairResult,
  flairPair,
  registerWithFlair,
} from "./flair-pair.js";
export { type InitOptions, type InitResult, initAgent } from "./init.js";
export {
  MailConsumer,
  type MailConsumerOptions,
  type MailConsumerStats,
  type MailMessage,
} from "./mail-consumer.js";
export {
  type OnboardOptions,
  type OnboardResult,
  runOnboard,
  type SpawnFn,
} from "./onboard.js";
export {
  type PersistentHandle,
  type RunPersistentOptions,
  runPersistent,
  startPersistent,
} from "./persistent.js";
export { loadRole, type RoleTemplate } from "./role-loader.js";
export {
  createPiRunSession,
  type ResolvedRunConfig,
  type ResolveRunConfigOptions,
  type RunOptions,
  type RunResult,
  type RunSession,
  type RunSessionConfig,
  type RunSessionFactory,
  resolveRunConfig,
  runAgent,
  type SessionManagerLike,
} from "./run.js";
export {
  down,
  type InstallServiceOptions,
  installService,
  type LaunchctlRunner,
  type LifecycleOptions,
  plistPath,
  type RenderPlistOptions,
  renderPlist,
  restart,
  type ServiceOpsDeps,
  serviceLabel,
  up,
} from "./service.js";
