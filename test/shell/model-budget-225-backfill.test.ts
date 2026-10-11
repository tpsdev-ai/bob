// bob#225 (item 5) — the output backstop counts the end-event backfill.
//
// pi's OpenAI Responses client streams a text block as `text_delta` events and,
// when the response's message item is done, sets the block's text to that item's
// final text and emits `text_end` carrying it. When the item's text is LONGER
// than the deltas streamed for it (the server delivered the rest only in the end
// item), that final text is output the piece-count backstop did not count, so a
// stream that packs its answer into the end event went uncounted.
//
// These tests run the REAL pi-ai Responses stream processor
// (processResponsesStream) to produce a backfilled `text_end`, and the REAL
// backstop (capOutputStream) over it. The OpenAI Responses server is not on this
// host, so the events it would stream are built here in the documented shapes.

import { describe, expect, it } from "bun:test";
import {
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import { processResponsesStream } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { capOutputStream, type StreamFunction } from "../../src/shell/model-budget.js";

const CAP = 3;
const MODEL_ID = "stub-responses-225";
const PROVIDER = "bob-stub-225";

type Model = Parameters<StreamFunction>[0];
type CappedMessage = AssistantMessage & { bobOutputCap?: boolean };

const model = {
  id: MODEL_ID,
  provider: PROVIDER,
  api: "openai-responses",
  input: ["text"],
  maxTokens: CAP,
  contextWindow: 100_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model;

function noUsage(): AssistantMessage["usage"] {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** The Responses events for a message item whose final text is `finalText`,
 *  streamed first as `deltas` (one piece each) and carried again in the item. */
function responsesEvents(deltas: readonly string[], finalText: string): unknown[] {
  return [
    { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1" } },
    ...deltas.map((delta) => ({ type: "response.output_text.delta", output_index: 0, delta })),
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "msg_1", content: [{ type: "output_text", text: finalText }] },
    },
    {
      type: "response.completed",
      response: {
        id: "resp_1",
        status: "completed",
        usage: { input_tokens: 5, output_tokens: 20, total_tokens: 25 },
      },
    },
  ];
}

/** A provider stream that runs the REAL pi-ai Responses processor over `events`
 *  the way pi-ai's own `stream` does: start, process, done, end. */
function responsesStream(events: readonly unknown[]): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: PROVIDER,
    model: MODEL_ID,
    usage: noUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  void (async () => {
    stream.push({ type: "start", partial: output });
    await processResponsesStream(
      (async function* () {
        for (const event of events) yield event;
      })() as never,
      output,
      stream,
      model as never,
    );
    stream.push({ type: "done", reason: "stop", message: output });
    stream.end(output);
  })();
  return stream;
}

/** Drive the REAL backstop over a stream built from `events`; return the message
 *  it ended with. */
async function capped(events: readonly unknown[]): Promise<CappedMessage> {
  const inner = (() => Promise.resolve(responsesStream(events))) as StreamFunction;
  const wrapped = capOutputStream(inner, { log: () => {} });
  const stream = await wrapped(model, { systemPrompt: "", messages: [] } as never, {} as never);
  let message: AssistantMessage | undefined;
  for await (const event of stream as AsyncIterable<AssistantMessageEvent>) {
    if (event.type === "done") message = event.message;
    else if (event.type === "error") message = event.error;
  }
  return message as CappedMessage;
}

const textOf = (message: AssistantMessage) =>
  message.content.map((c) => (c.type === "text" ? c.text : "")).join("");

describe("bob#225 item 5 — the output backstop counts the Responses end-event backfill", () => {
  it("ends a stream whose deltas are at the cap once its text_end carries the item's longer final text", async () => {
    // Three deltas (three pieces — AT the cap, not over it), then the message
    // item carries five more words only in the end event.
    const message = await capped(responsesEvents(["a", "b", "c"], "abcDE FGH IJ KLM"));
    expect(message.stopReason).toBe("length");
    expect(message.bobOutputCap).toBe(true);
    // The cut holds the pieces bob accepted (the three deltas), not the backfill.
    expect(textOf(message)).toBe("abc");
    expect(message.usage.output).toBe(CAP);
  });

  it("does not count a text_end that repeats the streamed deltas: a server within the cap is not cut", async () => {
    // The item's text is exactly the deltas: no backfill, so no further piece.
    const message = await capped(responsesEvents(["a", "b", "c"], "abc"));
    expect(message.stopReason).toBe("stop");
    expect(message.bobOutputCap).toBeUndefined();
    expect(textOf(message)).toBe("abc");
  });
});
