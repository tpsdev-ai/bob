// bob#254 — the Flair session bootstrap. On runtime launch, for an agent whose
// resolved capabilities include `flair`, the shell asks Flair for the agent's
// bootstrap context and appends it to the system prompt AFTER soul.md. The
// context MAY carry sections Flair renders — an Identity section, "## Active
// Skills", predicted context — and Flair chooses which soul entries go in it,
// so it need not match the local soul.md; bob appends soul.md first and Flair's
// block second.
//
// The block bob appends is bounded LOCALLY (heading included), because Flair
// admits its skill lines outside its own selection budget. Over the bound, and
// on a request, response, timeout or budget failure, the session STARTS with ONE
// line saying the context could not be loaded (a bounded, secret-free reason),
// plus a log line. An identity mismatch is not one of these: it refuses launch
// (flairBootstrapTarget). Never invent context.

import { FlairBootstrapError, FlairHttpClient } from "../capabilities/flair/client.js";
import { type ConfigViewInput, configHoldsWeb } from "./data-class.js";

// The heading the bootstrap context sits under, so it is distinct from soul.md
// (which pi appends first, and unheaded).
export const FLAIR_BOOTSTRAP_HEADING = "## Context from Flair (loaded at session start)";

// The default budget — bob.yaml's `flair.bootstrap_tokens` — when absent.
export const DEFAULT_FLAIR_BOOTSTRAP_TOKENS = 2000;

// Tokens are ESTIMATED from characters, not counted. Flair's `tokenEstimate`
// measures the whole response Flair serialized (its `context` and skill lines
// included), so it does not measure the block bob appends, which bob bounds
// itself. The estimate (the usual ~4 chars/token convention) is APPROXIMATE — a
// block of unusually short tokens estimates under its true count — and it bounds
// the text BOB appends, heading included.
export const FLAIR_BOOTSTRAP_CHARS_PER_TOKEN = 4;

export function estimateFlairBootstrapTokens(text: string): number {
  return Math.ceil(text.length / FLAIR_BOOTSTRAP_CHARS_PER_TOKEN);
}

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
// somehow incomplete.
//
// `launchedAgentId` is the identity bob runs the session as. A session signs
// Flair requests as `flair.agentId` with `flair.keyFile`, so a config naming
// another principal would fetch THAT principal's context into this agent's
// system prompt — refused here, at resolution.
export function flairBootstrapTarget(
  capabilities: ReadonlyArray<{ name: string; config: Record<string, unknown> }>,
  launchedAgentId: string,
): FlairBootstrapTarget | undefined {
  const flair = capabilities.find((c) => c.name === "flair");
  if (flair === undefined) return undefined;
  const cfg = flair.config;
  const url = typeof cfg.url === "string" ? cfg.url : "";
  const agentId = typeof cfg.agentId === "string" ? cfg.agentId : "";
  const keyFile = typeof cfg.keyFile === "string" ? cfg.keyFile : "";
  if (url === "" || agentId === "" || keyFile === "") return undefined;
  if (agentId !== launchedAgentId) {
    throw new Error(
      `bob: refusing to load the Flair bootstrap for agent "${launchedAgentId}": bob.yaml flair.agentId is "${agentId}". ` +
        `A session signs Flair requests as flair.agentId using flair.keyFile, so a bootstrap fetched under another id would carry that principal's context into this agent's system prompt. ` +
        `Set flair.agentId to "${launchedAgentId}", or remove the flair capability.`,
    );
  }
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
  // Request bounds (tests). Omitted → the client's defaults.
  timeoutMs?: number;
  maxResponseBytes?: number;
}

// The bounded, secret-free reason for a failed load.
function bootstrapFailureReason(err: unknown): string {
  if (err instanceof FlairBootstrapError) {
    if (err.failure === "unreachable") return "Flair was unreachable";
    if (err.failure === "timeout") return "Flair did not answer in time";
    if (err.failure === "too_large") return "Flair's response exceeded the size bound";
    if (err.failure === "http_error") return `Flair returned HTTP ${err.status ?? "an error"}`;
    return "Flair's response carried no context";
  }
  return "the bootstrap call failed";
}

function failureNote(reason: string): string {
  return `Flair session context could not be loaded at session start (${reason}). Continuing without it.`;
}

// Load the bootstrap context and return the text to append, or "" when there is
// nothing to append. A web session appends nothing: the web composition rule
// requires its assembled system prompt to be exactly bob's reviewed prompt (plus
// the contract), so the skip is logged, not written into the prompt.
export async function loadFlairBootstrapContext(opts: LoadFlairBootstrapOptions): Promise<string> {
  const log = opts.log ?? ((m: string) => console.error(m));
  const agent = opts.target.agentId;
  if (configHoldsWeb(opts.gate)) {
    log(
      `[bob] Flair bootstrap context not loaded for ${agent}: this session holds web, which takes no private startup context`,
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
    ...(opts.timeoutMs !== undefined ? { bootstrapTimeoutMs: opts.timeoutMs } : {}),
    ...(opts.maxResponseBytes !== undefined
      ? { bootstrapMaxResponseBytes: opts.maxResponseBytes }
      : {}),
  });
  let context: string;
  try {
    const boot = await client.bootstrap({ maxTokens: opts.target.maxTokens });
    context = boot.context;
  } catch (err) {
    const reason = bootstrapFailureReason(err);
    log(`[bob] Flair bootstrap context not loaded for ${agent}: ${reason}`);
    return failureNote(reason);
  }
  if (context.trim() === "") return "";
  const block = `${FLAIR_BOOTSTRAP_HEADING}\n${context}`;
  const estimated = estimateFlairBootstrapTokens(block);
  if (estimated > opts.target.maxTokens) {
    const reason = `Flair's context exceeded the flair.bootstrap_tokens budget (about ${estimated} estimated tokens > ${opts.target.maxTokens})`;
    log(`[bob] Flair bootstrap context not loaded for ${agent}: ${reason}`);
    return failureNote(reason);
  }
  return block;
}
