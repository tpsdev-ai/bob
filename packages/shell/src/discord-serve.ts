// TODO(phase1): superseded by cap-discord (packages/cap-discord). This module
// is the per-message subprocess path — each inbound message cold-spawns a fresh
// `pi -p` via runAgent (no warm session, no conversational continuity). The
// discord capability replaces it with a pi extension that drives a persistent
// session via pi.sendUserMessage. Kept until PR4 lands persistent-run; then
// this + discord-bridge.ts come out.
//
// Discord listener wiring — bridges incoming Discord messages into
// `bob run`-style sessions and replies with the output.
//
// This module is what `bob serve --discord` activates. It assembles three
// pre-existing pieces:
//   1. DiscordJsClient (from @tpsdev-ai/bob-discord) — gateway connection
//   2. DiscordBridge (shell/src/discord-bridge.ts) — channel + mention filter,
//      stats, dispatch flow
//   3. runAgent (shell/src/run.ts) — invokes the agent's launcher with the
//      message content as prompt, returns the agent's reply
//
// Why factor this out of bob serve's CLI: testability. The CLI side just
// reads flags and config; this module owns the wiring + the dispatch
// closure. Tests inject a fake DiscordClient and a fake runFn and verify
// the wiring connects correctly without launching real pi or hitting
// the Discord gateway.

import { DiscordBridge, type DiscordClient, type DiscordMessage } from "./discord-bridge.js";
import type { RunOptions, RunResult } from "./run.js";

export interface DiscordListenerOptions {
  // Agent name (used to look up the launcher in runAgent).
  agentName: string;
  // Channel IDs to listen on. Other channels are silently dropped.
  listenChannelIds: string[];
  // DiscordClient implementation — pass DiscordJsClient in production,
  // a fake in tests.
  client: DiscordClient;
  // If true, dispatch ALL messages on listenChannelIds (not just bot-mentions).
  // EA-style "follow the room" pattern. Default false.
  dispatchAll?: boolean;
  // Optional model override for the dispatched session (overrides the
  // agent's bob.yaml default). E.g., route Discord conversations through
  // a faster cheaper model and reserve opus for cron strategy work.
  model?: string;
  // Inject runAgent in tests; default uses the real one.
  runFn?: (opts: RunOptions) => Promise<RunResult>;
  // Translate a runAgent result into a Discord reply string. The default
  // reads result.stdout (captured via runAgent's captureStdout=true) and
  // trims it for Discord's 2000-char message limit. Tests override to
  // inject canned replies. Return undefined to suppress the reply.
  captureOutput?: (result: RunResult) => Promise<string | undefined>;
}

// Discord message limit (per channels.send). Replies longer than this
// get truncated with a marker. Real-world usage is well under this
// for EA-style brief replies; the cap is defensive against the model
// occasionally returning a wall of text.
const DISCORD_MAX_REPLY_CHARS = 1900;

export function defaultCaptureOutput(result: RunResult): string | undefined {
  const raw = (result.stdout ?? "").trim();
  if (raw.length === 0) return undefined;
  if (raw.length <= DISCORD_MAX_REPLY_CHARS) return raw;
  return `${raw.slice(0, DISCORD_MAX_REPLY_CHARS)}…\n\n[reply truncated at ${DISCORD_MAX_REPLY_CHARS} chars]`;
}

export async function startDiscordListener(opts: DiscordListenerOptions): Promise<DiscordBridge> {
  // Lazy import runAgent so callers who don't need Discord don't pay
  // the import cost (kept consistent with the shell's "pure surface
  // unless you ask for X" pattern).
  const { runAgent } = await import("./run.js");
  const run = opts.runFn ?? runAgent;
  const capture = opts.captureOutput ?? defaultCaptureOutput;

  const bridge = new DiscordBridge({
    listenChannelIds: opts.listenChannelIds,
    client: opts.client,
    dispatchAll: opts.dispatchAll,
    dispatch: async (msg: DiscordMessage): Promise<string | undefined> => {
      // Strip the leading @-mention prefix when present — the agent
      // doesn't need to see its own ID in the prompt. Discord renders
      // <@123456> as the literal in `content`.
      const cleaned = msg.content.replace(/<@!?\d+>\s*/g, "").trim();
      if (cleaned.length === 0) return undefined;

      const result = await run({
        name: opts.agentName,
        prompt: cleaned,
        model: opts.model,
        // PR-19: capture the agent's stdout so we can post it as a reply.
        // Without this, runAgent uses stdio:inherit and we have nothing
        // to reply with.
        captureStdout: true,
      });
      if (result.exitCode !== 0) {
        return `[bob] session exited with code ${result.exitCode}`;
      }
      return await capture(result);
    },
  });

  await bridge.start();
  return bridge;
}
