// Milton shell — public surface.
//
// The shell is the wiring that every Milton-shaped agent shares:
// identity (Flair Ed25519 pair), mail consumer, Discord bridge, cron
// glue, and role loader. The "form" — soul, tools, model choice — is
// per-role config that gets fed into the shell at init time.
//
// PR-1 ships the type surface + role loader + a stub mail consumer.
// PR-2 will wire the Discord bridge + cron scheduler.

export type MiltonRole = "ea" | "writer" | "reviewer" | "coder" | "qa" | "custom";

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

export interface MiltonConfig {
  agent: {
    id: string;
    name: string;
    role: MiltonRole;
  };
  provider: ProviderConfig;
  identity: IdentityConfig;
  channels: ChannelsConfig;
  cron?: CronEntry[];
}

export { loadRole, type RoleTemplate } from "./role-loader.js";
