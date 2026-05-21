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
export {
  DiscordBridge,
  type DiscordBridgeOptions,
  type DiscordBridgeStats,
  type DiscordClient,
  type DiscordMessage,
} from "./discord-bridge.js";
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
export { loadRole, type RoleTemplate } from "./role-loader.js";
