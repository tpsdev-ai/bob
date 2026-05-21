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
  // Capture stdout from the dispatched session so we can post it as a
  // reply. Default reads from the runFn's result stream — tests inject
  // a value directly. Production wiring captures from --print output.
  //
  // NOTE: this is the simplest workable version. runAgent currently uses
  // stdio:inherit, so output goes to the process stdout, not back to
  // this caller. Production callers should pipe through a stdout capture
  // layer; v1 of this listener may not produce useful replies until that
  // capture layer is wired. Marked as a follow-up in the dispatch comment.
  captureOutput?: (result: RunResult) => Promise<string>;
}

export async function startDiscordListener(opts: DiscordListenerOptions): Promise<DiscordBridge> {
  // Lazy import runAgent so callers who don't need Discord don't pay
  // the import cost (kept consistent with the shell's "pure surface
  // unless you ask for X" pattern).
  const { runAgent } = await import("./run.js");
  const run = opts.runFn ?? runAgent;
  const capture = opts.captureOutput;

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
      });
      if (result.exitCode !== 0) {
        return `[bob] session exited with code ${result.exitCode}`;
      }
      // v1 dispatch capture: callers wire this if they want auto-reply.
      // Without a capture function, the session output went to the
      // serving process stdout (stdio:inherit in runAgent) and isn't
      // available to post back. Returning undefined suppresses the reply.
      if (!capture) return undefined;
      return await capture(result);
    },
  });

  await bridge.start();
  return bridge;
}
