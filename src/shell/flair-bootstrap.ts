// bob#254 — the Flair session bootstrap. At session start, for an agent whose
// bob.yaml configures the `flair` capability, the shell asks Flair for the
// agent's bootstrap context (its soul as Flair holds it, the "Active Skills"
// manifest, predicted context) and appends it to the system prompt AFTER
// soul.md. soul.md stays the persona's source of truth for AUTHORING; this
// adds what only Flair holds (skills assigned to the agent, org skills, recent
// context).
//
// Failure stance matches the other Flair calls: the session STARTS anyway with
// ONE line saying the context could not be loaded (and a bounded, secret-free
// reason), and a log line. Never invent context.

import { FlairBootstrapError, FlairHttpClient } from "../capabilities/flair/client.js";
import { type ConfigViewInput, configHoldsWeb } from "./data-class.js";

// The heading the bootstrap context sits under, so it is distinct from soul.md
// (which pi appends first, and unheaded).
export const FLAIR_BOOTSTRAP_HEADING = "## Context from Flair (loaded at session start)";

// The default `maxTokens` — Flair's CONTENT SELECTION cap — when bob.yaml's
// `flair.bootstrap_tokens` is absent.
export const DEFAULT_FLAIR_BOOTSTRAP_TOKENS = 2000;

// The resolved coordinates needed to call Flair as the agent, plus the budget.
// Resolved from bob.yaml by resolveRunConfig; absent when the agent does not
// configure the flair capability.
export interface FlairBootstrapTarget {
  url: string;
  agentId: string;
  keyFile: string;
  maxTokens: number;
}

// Test seams, mirroring FlairHttpClientOptions. Production passes none.
export interface FlairBootstrapSeams {
  fetchImpl?: ConstructorParameters<typeof FlairHttpClient>[0]["fetchImpl"];
  now?: () => number;
  uuid?: () => string;
  readFile?: (path: string) => Buffer;
}

// Where to call Flair, from the resolved capability list: the agent's
// schema-validated flair config, plus the budget from bob.yaml
// `flair.bootstrap_tokens` (default DEFAULT_FLAIR_BOOTSTRAP_TOKENS). Undefined
// when the agent does not configure the flair capability, or the config is
// somehow incomplete (the schema makes that unreachable, but a caller that
// hands unvalidated config gets no bootstrap rather than a crash).
export function flairBootstrapTarget(
  capabilities: ReadonlyArray<{ name: string; config: Record<string, unknown> }>,
): FlairBootstrapTarget | undefined {
  const flair = capabilities.find((c) => c.name === "flair");
  if (flair === undefined) return undefined;
  const cfg = flair.config;
  const url = typeof cfg.url === "string" ? cfg.url : "";
  const agentId = typeof cfg.agentId === "string" ? cfg.agentId : "";
  const keyFile = typeof cfg.keyFile === "string" ? cfg.keyFile : "";
  if (url === "" || agentId === "" || keyFile === "") return undefined;
  const tokens = cfg.bootstrap_tokens;
  return {
    url,
    agentId,
    keyFile,
    maxTokens: typeof tokens === "number" && tokens > 0 ? tokens : DEFAULT_FLAIR_BOOTSTRAP_TOKENS,
  };
}

export interface LoadFlairBootstrapOptions {
  target: FlairBootstrapTarget;
  // The data-class gate input: the same config the session factory composes. A
  // session that holds web takes no private startup context, so the bootstrap
  // is dropped rather than appended (and the session is not refused for it).
  gate: Pick<ConfigViewInput, "extensionSources" | "capabilityBySource" | "tools" | "excludeTools">;
  log?: (message: string) => void;
  seams?: FlairBootstrapSeams;
}

// The bounded, secret-free reason for a failed load.
function bootstrapFailureReason(err: unknown): string {
  if (err instanceof FlairBootstrapError) {
    if (err.failure === "unreachable") return "Flair was unreachable";
    if (err.failure === "http_error") return `Flair returned HTTP ${err.status ?? "an error"}`;
    return "Flair's response carried no context";
  }
  return "the bootstrap call failed";
}

// Load the bootstrap context and return the text to append, or "" when there is
// nothing to append. A web session appends nothing: the web composition rule
// requires its assembled system prompt to be exactly bob's reviewed prompt (plus
// the contract), so the skip is logged, not written into the prompt.
export async function loadFlairBootstrapContext(opts: LoadFlairBootstrapOptions): Promise<string> {
  const log = opts.log ?? ((m: string) => console.error(m));
  if (configHoldsWeb(opts.gate)) {
    log(
      `[bob] Flair bootstrap context not loaded for ${opts.target.agentId}: this session holds web, which takes no private startup context`,
    );
    return "";
  }
  const client = new FlairHttpClient({
    url: opts.target.url,
    agentId: opts.target.agentId,
    keyFile: opts.target.keyFile,
    ...(opts.seams?.fetchImpl ? { fetchImpl: opts.seams.fetchImpl } : {}),
    ...(opts.seams?.now ? { now: opts.seams.now } : {}),
    ...(opts.seams?.uuid ? { uuid: opts.seams.uuid } : {}),
    ...(opts.seams?.readFile ? { readFile: opts.seams.readFile } : {}),
  });
  let context: string;
  try {
    const boot = await client.bootstrap({ maxTokens: opts.target.maxTokens });
    context = boot.context;
  } catch (err) {
    const reason = bootstrapFailureReason(err);
    log(`[bob] Flair bootstrap context not loaded for ${opts.target.agentId}: ${reason}`);
    return `Flair session context could not be loaded at session start (${reason}). Continuing without it.`;
  }
  if (context.trim() === "") return "";
  return `${FLAIR_BOOTSTRAP_HEADING}\n${context}`;
}
