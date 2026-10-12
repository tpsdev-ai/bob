// bob#225 item 5 — real Responses processor fixtures through the output backstop.

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
  ResponseFunctionToolCallItem,
  ResponseOutputMessage,
  ResponseReasoningItem,
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

type Fixture = { kind: "text" | "thinking" | "toolCall"; deltas: readonly string[]; end: string };

function responsesEvents(...blocks: Fixture[]): ResponseStreamEvent[] {
  const items = blocks.map(
    (
      block,
      index,
    ): ResponseOutputMessage | ResponseReasoningItem | ResponseFunctionToolCallItem => {
      if (block.kind === "thinking") {
        return {
          type: "reasoning",
          id: `rs_${index}`,
          summary: [{ type: "summary_text", text: block.end }],
        };
      }
      if (block.kind === "toolCall") {
        return {
          type: "function_call",
          id: `fc_${index}`,
          call_id: `call_${index}`,
          name: "lookup",
          arguments: block.end,
          status: "completed",
        };
      }
      return {
        type: "message",
        id: `msg_${index}`,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: block.end, annotations: [] }],
      };
    },
  );
  const response: Response = {
    id: "resp_1",
    object: "response",
    created_at: 0,
    completed_at: 1,
    status: "completed",
    model: MODEL_ID,
    output: items,
    output_text: blocks
      .filter((b) => b.kind === "text")
      .map((b) => b.end)
      .join(""),
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
  const events: ResponseStreamEvent[] = [];
  for (const [output_index, item] of items.entries()) {
    const block = blocks[output_index];
    events.push({
      type: "response.output_item.added",
      sequence_number: events.length,
      output_index,
      item:
        item.type === "message"
          ? { ...item, status: "in_progress", content: [] }
          : item.type === "reasoning"
            ? { ...item, summary: [] }
            : { ...item, status: "in_progress", arguments: "" },
    });
    for (const delta of block.deltas) {
      const common = { sequence_number: events.length, output_index, item_id: item.id, delta };
      if (block.kind === "thinking") {
        events.push({ ...common, type: "response.reasoning_summary_text.delta", summary_index: 0 });
      } else if (block.kind === "toolCall") {
        events.push({ ...common, type: "response.function_call_arguments.delta" });
      } else {
        events.push({
          ...common,
          type: "response.output_text.delta",
          content_index: 0,
          logprobs: [],
        });
      }
    }
    events.push({
      type: "response.output_item.done",
      sequence_number: events.length,
      output_index,
      item,
    });
  }
  events.push({ type: "response.completed", sequence_number: events.length, response });
  return events;
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
    stream.push({ type: "done", reason: output.stopReason as "stop" | "toolUse", message: output });
    stream.end(output);
  })();
  return stream;
}

/** Drive the REAL backstop over a stream built from `events`; return the message
 *  it ended with. */
async function capped(events: readonly ResponseStreamEvent[], cap = CAP): Promise<CappedMessage> {
  const inner = (() => Promise.resolve(responsesStream(events))) as StreamFunction;
  const wrapped = capOutputStream(inner, { log: () => {} });
  const stream = await wrapped(model, { systemPrompt: "", messages: [] } as never, {
    maxTokens: cap,
  });
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
    const message = await capped(
      responsesEvents({ kind: "text", deltas: ["a", "b", "c"], end: "abcDE FGH IJ KLM" }),
    );
    expect(message.stopReason).toBe("length");
    expect(message.bobOutputCap).toBe(true);
    // The cut holds the pieces bob accepted (the three deltas), not the backfill.
    expect(textOf(message)).toBe("abc");
    expect(message.usage.output).toBe(CAP);
  });

  it("does not count a text_end that repeats the streamed deltas: a stream within the piece-count limit is not cut", async () => {
    // The item's text is exactly the deltas: no backfill, so no further piece.
    const message = await capped(
      responsesEvents({ kind: "text", deltas: ["a", "b", "c"], end: "abc" }),
    );
    expect(message.stopReason).toBe("stop");
    expect(message.bobOutputCap).toBeUndefined();
    expect(textOf(message)).toBe("abc");
  });

  it("counts a later text block's backfill even when shorter than block zero", async () => {
    const message = await capped(
      responsesEvents(
        { kind: "text", deltas: ["a", "b", "c"], end: "abc" },
        { kind: "text", deltas: [], end: "XY" },
      ),
    );
    expect(message.stopReason).toBe("length");
    expect(message.bobOutputCap).toBe(true);
    expect(textOf(message)).toBe("abc");
  });

  it("counts a long text backfill once at the cap boundary", async () => {
    const end = `ab${"many words ".repeat(10)}`;
    const message = await capped(responsesEvents({ kind: "text", deltas: ["a", "b"], end }));
    expect(message.stopReason).toBe("stop");
    expect(message.bobOutputCap).toBeUndefined();
    expect(textOf(message)).toBe(end);
  });

  for (const kind of ["thinking", "toolCall"] as const) {
    const deltas = kind === "thinking" ? ["a", "b", "c"] : ['{"a":', "1,", '"b":'];
    const end =
      kind === "thinking"
        ? `abc${"many words ".repeat(10)}`
        : `{"a":1,"b":"${"many words ".repeat(10)}"}`;

    it(`counts a ${kind} end-item backfill before forwarding it`, async () => {
      const message = await capped(responsesEvents({ kind, deltas, end }));
      expect(message.stopReason).toBe("length");
      expect(message.bobOutputCap).toBe(true);
      const block = message.content[0];
      if (kind === "thinking") expect(block).toMatchObject({ type: "thinking", thinking: "abc" });
      else expect(block).toMatchObject({ type: "toolCall", arguments: { a: 1 } });
    });

    it(`counts a long ${kind} backfill once at the cap boundary`, async () => {
      const message = await capped(responsesEvents({ kind, deltas: deltas.slice(0, 2), end }));
      expect(message.stopReason).toBe(kind === "thinking" ? "stop" : "toolUse");
      expect(message.bobOutputCap).toBeUndefined();
      if (kind === "thinking")
        expect(message.content[0]).toMatchObject({ type: "thinking", thinking: end });
      else
        expect(message.content[0]).toMatchObject({ type: "toolCall", arguments: JSON.parse(end) });
    });

    it(`does not count a ${kind} end event repeating accepted output`, async () => {
      const repeated = kind === "thinking" ? "abc" : '{"a":1,"b":2}';
      const repeatedDeltas = kind === "thinking" ? deltas : ['{"a":', "1,", '"b":2}'];
      const message = await capped(
        responsesEvents({ kind, deltas: repeatedDeltas, end: repeated }),
      );
      expect(message.stopReason).toBe(kind === "thinking" ? "stop" : "toolUse");
      expect(message.bobOutputCap).toBeUndefined();
    });

    it(`compares a later ${kind} backfill with that block's accepted output`, async () => {
      const repeated = kind === "thinking" ? "abc" : '{"a":1,"b":2}';
      const repeatedDeltas = kind === "thinking" ? deltas : ['{"a":', "1,", '"b":2}'];
      const message = await capped(
        responsesEvents(
          { kind, deltas: repeatedDeltas, end: repeated },
          { kind, deltas: [], end: kind === "thinking" ? "XY" : repeated },
        ),
      );
      expect(message.stopReason).toBe("length");
      expect(message.bobOutputCap).toBe(true);
      expect(message.content[1]).toMatchObject(
        kind === "thinking"
          ? { type: "thinking", thinking: "" }
          : { type: "toolCall", arguments: {} },
      );
    });
  }

  it("does not count tool-call JSON formatting changes without changed parsed arguments", async () => {
    const message = await capped(
      responsesEvents({
        kind: "toolCall",
        deltas: ['{"a":1,', '"b":2', "}"],
        end: '{ "b": 2, "a": 1 }',
      }),
    );
    expect(message.stopReason).toBe("toolUse");
    expect(message.bobOutputCap).toBeUndefined();
    expect(message.content[0]).toMatchObject({ type: "toolCall", arguments: { a: 1, b: 2 } });
  });
});
