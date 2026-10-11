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
import type {
  Response,
  ResponseOutputMessage,
  ResponseStreamEvent,
} from "openai/resources/responses/responses.js";
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
function responsesEvents(deltas: readonly string[], finalText: string): ResponseStreamEvent[] {
  const item: ResponseOutputMessage = {
    type: "message",
    id: "msg_1",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text: finalText, annotations: [] }],
  };
  const response: Response = {
    id: "resp_1",
    object: "response",
    created_at: 0,
    completed_at: 1,
    status: "completed",
    model: MODEL_ID,
    output: [item],
    output_text: finalText,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: false,
    temperature: null,
    top_p: null,
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: 5,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 25,
    },
  };
  return [
    {
      type: "response.output_item.added",
      sequence_number: 0,
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    },
    ...deltas.map<ResponseStreamEvent>((delta, index) => ({
      type: "response.output_text.delta",
      sequence_number: index + 1,
      output_index: 0,
      content_index: 0,
      item_id: item.id,
      logprobs: [],
      delta,
    })),
    {
      type: "response.output_item.done",
      sequence_number: deltas.length + 1,
      output_index: 0,
      item,
    },
    {
      type: "response.completed",
      sequence_number: deltas.length + 2,
      response,
    },
  ];
}

/** A provider stream that runs the REAL pi-ai Responses processor over `events`
 *  the way pi-ai's own `stream` does: start, process, done, end. */
function responsesStream(events: readonly ResponseStreamEvent[]): AssistantMessageEventStream {
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
      })(),
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
async function capped(events: readonly ResponseStreamEvent[]): Promise<CappedMessage> {
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
    // The deltas reach the piece-count limit.
    // The item carries additional text only in the end event.
    const message = await capped(responsesEvents(["a", "b", "c"], "abcDE FGH IJ KLM"));
    expect(message.stopReason).toBe("length");
    expect(message.bobOutputCap).toBe(true);
    // The cut holds the pieces bob accepted (the three deltas), not the backfill.
    expect(textOf(message)).toBe("abc");
    expect(message.usage.output).toBe(CAP);
  });

  it("does not count a text_end that repeats the streamed deltas: a stream within the piece-count limit is not cut", async () => {
    // The item's text is exactly the deltas: no backfill, so no further piece.
    const message = await capped(responsesEvents(["a", "b", "c"], "abc"));
    expect(message.stopReason).toBe("stop");
    expect(message.bobOutputCap).toBeUndefined();
    expect(textOf(message)).toBe("abc");
  });
});
