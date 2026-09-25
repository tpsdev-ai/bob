// The system-prompt contract, unit by unit (issue #145).
//
// The shape this file pins: the contract is LITERAL TEXT appended through the
// loader's override (never a path source), bounded by a cap that is visible in
// the block itself, and enforced at the request boundary by a guard that sees
// the payload LAST and fails the turn like a failed audit.
import { describe, expect, it } from "bun:test";
import { isolatedLoaderOptions } from "../../src/shell/session.js";
import {
  appendContractOverride,
  buildContractBlock,
  CONTRACT_SENTINEL_PREFIX,
  contractVerdictForRequest,
  createContractGuardExtension,
  DEFAULT_CONTRACT_CAP_CHARS,
  jsonEscapedRequestText,
  MIN_CONTRACT_CAP_CHARS,
  payloadCarriesRequestText,
  serializeRequestPayload,
} from "../../src/shell/system-prompt-contract.js";

/** pi's own summarization system prompt, VERBATIM (pi 0.84.3,
 *  core/compaction/utils.js `SUMMARIZATION_SYSTEM_PROMPT`). pi does not export
 *  it, so it is copied here for ONE purpose: the test that proves an exemption
 *  can no longer be BORROWED by pasting text into the prompt — the short marker
 *  first (round 2's defect), and the whole prompt as the harder case. */
const PI_SUMMARIZATION_PROMPT =
  "You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.";

type StreamSimple = (
  model: unknown,
  context: unknown,
  options?: Record<string, unknown>,
) => { result?: () => Promise<unknown> };

/** A model descriptor with only the fields a pi-ai adapter reads. */
function stubModel(
  api: string,
  baseUrl: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: "probe-model",
    name: "Probe",
    api,
    provider: "probe",
    baseUrl,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 100,
    ...extra,
  };
}

interface ProviderProbe {
  name: string;
  model: Record<string, unknown>;
  /** pi-ai's OWN module for this API: the payload below is whatever that
   *  adapter builds, not a shape this test invented. */
  load: () => Promise<{ streamSimple: StreamSimple }>;
  apiKey?: string;
  /** Google's adapter refuses `options.fetch` outright
   *  (pi-ai 0.84.3 api/google-generative-ai.js), so that probe patches
   *  globalThis.fetch instead of passing one. */
  globalFetch?: boolean;
  options?: Record<string, unknown>;
}

/** A synthetic provider token with the account claim the Codex adapter parses
 *  out of the API key before it builds its body (no credential, no network). */
const CODEX_PROBE_TOKEN = `eyJhbGciOiJub25lIn0.${Buffer.from(
  JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "probe-account" } }),
).toString("base64")}.sig`;

/**
 * The payload pi-ai 0.84.3 really builds for one provider API, captured at
 * `onPayload` — the seam pi routes to `before_provider_request`, which is
 * exactly where bob's guard sits. The request is allowed to fail (a stub fetch
 * answers 400); only the payload matters here.
 */
async function payloadFor(probe: ProviderProbe, systemPrompt: string): Promise<unknown> {
  const api = await probe.load();
  const context = {
    systemPrompt,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
  };
  const fetchStub = async (): Promise<Response> =>
    new Response("{}", { status: 400, headers: { "content-type": "application/json" } });
  let captured: unknown;
  const options: Record<string, unknown> = {
    apiKey: probe.apiKey ?? "probe-key",
    maxTokens: 16,
    onPayload: async (payload: unknown) => {
      captured = payload;
    },
    ...probe.options,
  };
  const realFetch = globalThis.fetch;
  if (probe.globalFetch === true) globalThis.fetch = fetchStub as unknown as typeof fetch;
  else options.fetch = fetchStub;
  try {
    const stream = api.streamSimple(probe.model, context, options);
    await stream.result?.().catch(() => undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
  if (captured === undefined) throw new Error(`${probe.name}: pi-ai built no payload`);
  return captured;
}

/** Every provider API pi-ai 0.84.3 ships a payload builder for. */
const PROVIDER_PROBES: ProviderProbe[] = [
  {
    name: "Anthropic Messages (`system` blocks)",
    model: stubModel("anthropic-messages", "https://api.anthropic.com"),
    load: async () =>
      (await import("@earendil-works/pi-ai/api/anthropic-messages")) as unknown as {
        streamSimple: StreamSimple;
      },
  },
  {
    name: "OpenAI Chat Completions (`messages` with a system entry)",
    model: stubModel("openai-completions", "https://api.openai.com/v1"),
    load: async () =>
      (await import("@earendil-works/pi-ai/api/openai-completions")) as unknown as {
        streamSimple: StreamSimple;
      },
  },
  {
    name: "OpenAI Responses (`input` messages)",
    model: stubModel("openai-responses", "https://api.openai.com/v1"),
    load: async () =>
      (await import("@earendil-works/pi-ai/api/openai-responses")) as unknown as {
        streamSimple: StreamSimple;
      },
  },
  {
    name: "Google Generative AI (`config.systemInstruction`)",
    model: stubModel("google-generative-ai", "https://generativelanguage.googleapis.com"),
    load: async () =>
      (await import("@earendil-works/pi-ai/api/google-generative-ai")) as unknown as {
        streamSimple: StreamSimple;
      },
    globalFetch: true,
  },
  {
    name: "Bedrock Converse (`system` blocks)",
    model: stubModel("bedrock-converse-stream", "https://bedrock-runtime.us-east-1.amazonaws.com"),
    load: async () =>
      (await (
        await import("@earendil-works/pi-ai/api/bedrock-converse-stream.lazy")
      ).bedrockConverseStreamApi()) as unknown as { streamSimple: StreamSimple },
    options: {
      env: { AWS_REGION: "us-east-1", AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y" },
    },
  },
  {
    name: "Mistral Conversations (`messages` with a system entry)",
    model: stubModel("mistral-conversations", "https://api.mistral.ai/v1"),
    load: async () =>
      (await import("@earendil-works/pi-ai/api/mistral-conversations")) as unknown as {
        streamSimple: StreamSimple;
      },
  },
  {
    name: "Codex Responses (`instructions`)",
    model: stubModel("openai-codex-responses", "https://chatgpt.com/backend-api/codex", {
      reasoning: true,
    }),
    load: async () =>
      (await import("@earendil-works/pi-ai/api/openai-codex-responses")) as unknown as {
        streamSimple: StreamSimple;
      },
    apiKey: CODEX_PROBE_TOKEN,
    options: { transport: "sse" },
  },
];

describe("buildContractBlock", () => {
  it("carries the sentinel, the label and the task text", () => {
    const block = buildContractBlock({ label: "TASK", text: "commit the fixture, then report" });
    expect(block.startsWith(`${CONTRACT_SENTINEL_PREFIX}TASK`)).toBe(true);
    expect(block).toContain("commit the fixture, then report");
    expect(block.length).toBeLessThanOrEqual(DEFAULT_CONTRACT_CAP_CHARS);
  });

  it("labels the persistent runtime's block STANDING CONTRACT", () => {
    const block = buildContractBlock({
      label: "STANDING CONTRACT",
      text: "You are testbot, on duty as ea.",
    });
    expect(block.startsWith(`${CONTRACT_SENTINEL_PREFIX}STANDING CONTRACT`)).toBe(true);
    expect(block).toContain("You are testbot, on duty as ea.");
  });

  it("bounds the block at the cap and marks the cut VISIBLY, with how much was elided", () => {
    const text = "x".repeat(20_000);
    const block = buildContractBlock({ label: "TASK", text, capChars: 1000 });
    expect(block.length).toBeLessThanOrEqual(1000);
    // The cut is visible and states its size; the heading is never the part cut.
    expect(block).toContain("[truncated:");
    expect(block).toContain("chars elided]");
    expect(block.startsWith(`${CONTRACT_SENTINEL_PREFIX}TASK`)).toBe(true);
    // The marker's number is the length actually dropped.
    const elided = Number(block.match(/\[truncated: (\d+) chars elided\]/)?.[1]);
    expect(block.length - block.indexOf("[truncated:")).toBeLessThanOrEqual(1000);
    expect(elided).toBeGreaterThan(0);
  });

  it("keeps a short contract whole (no marker)", () => {
    const block = buildContractBlock({ label: "TASK", text: "short task" });
    expect(block).not.toContain("[truncated");
  });

  it('refuses a cap below the minimum, and there is no "no cap"', () => {
    for (const cap of [0, -1, 10, MIN_CONTRACT_CAP_CHARS - 1, Number.NaN]) {
      expect(() => buildContractBlock({ label: "TASK", text: "a task", capChars: cap })).toThrow(
        /cap/,
      );
    }
  });

  it("refuses a blank task and a blank standing contract", () => {
    expect(() => buildContractBlock({ label: "TASK", text: "   \n  " })).toThrow(/blank task/);
    expect(() => buildContractBlock({ label: "STANDING CONTRACT", text: "" })).toThrow(
      /blank standing contract/,
    );
  });
});

describe("appendContractOverride", () => {
  it("appends the block to whatever pi resolved, as LITERAL text", () => {
    const block = buildContractBlock({ label: "TASK", text: "the task" });
    const append = appendContractOverride(block);
    const result = append(["soul.md contents"]);
    expect(result).toEqual(["soul.md contents", block]);
    // Nothing is resolved from disk here: the block is returned as text, so a
    // block that HAPPENS to name an existing path cannot become that file.
    expect(result[1]).toContain("the task");
  });

  it("appends to an empty base too (a session with no soul)", () => {
    const append = appendContractOverride("BLOCK");
    expect(append([])).toEqual(["BLOCK"]);
  });
});

describe("the loader options the factory builds", () => {
  it("hand the contract to the loader as an OVERRIDE, never as a source pi would resolve", () => {
    const block = buildContractBlock({ label: "TASK", text: "the task" });
    const options = isolatedLoaderOptions({
      appendSystemPrompt: "soul text",
      extensionSources: [],
      piAgentDir: "/tmp/does-not-matter",
      contractBlock: block,
    });
    // The override is how the contract reaches the prompt: pi calls it after it
    // has turned its append SOURCES into text, so the block stays text.
    expect(typeof options.appendSystemPromptOverride).toBe("function");
    expect(options.appendSystemPromptOverride?.(["soul text"])).toEqual(["soul text", block]);
    // And the block is NOT a source: pi resolves every entry of
    // `appendSystemPrompt` — reading a FILE when the string names one — so the
    // contract must not be in that list.
    expect(options.appendSystemPrompt).toEqual(["soul text"]);
  });

  it("leaves the loader options untouched when there is no contract", () => {
    const options = isolatedLoaderOptions({
      appendSystemPrompt: "soul text",
      extensionSources: [],
      piAgentDir: "/tmp/does-not-matter",
    });
    expect(options.appendSystemPromptOverride).toBeUndefined();
    expect(options.extensionFactories).toBeUndefined();
  });

  it("loads bob's guard as an INLINE extension (pi appends inline extensions last)", () => {
    const options = isolatedLoaderOptions(
      {
        appendSystemPrompt: "",
        extensionSources: ["/some/capability"],
        piAgentDir: "/tmp/does-not-matter",
        contractBlock: "block",
      },
      { guard: { name: "bob-contract-guard", factory: () => {}, hidden: true } },
    );
    expect(options.extensionFactories).toHaveLength(1);
    expect(typeof options.extensionFactories?.[0]).not.toBe("string");
  });
});

describe("the request check: a serialized payload, no provider shapes", () => {
  it("serializes an object payload as the JSON it is sent as", () => {
    expect(serializeRequestPayload({ a: 1 })).toBe('{"a":1}');
  });

  it("treats a string payload as the serialization it already is", () => {
    expect(serializeRequestPayload('{"a":1}')).toBe('{"a":1}');
  });

  it("refuses to vouch for a payload it cannot serialize", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(serializeRequestPayload(cyclic)).toBeUndefined();
    expect(serializeRequestPayload(undefined)).toBeUndefined();
    expect(payloadCarriesRequestText(cyclic, "anything")).toBe(false);
  });

  it("escapes text the way JSON escapes it inside a payload", () => {
    expect(jsonEscapedRequestText('a\nb"c')).toBe('a\\nb\\"c');
  });

  it("finds a block in a payload escaped or not, and nothing when it is absent", () => {
    const block = buildContractBlock({ label: "TASK", text: "do the thing" });
    expect(payloadCarriesRequestText({ system: block }, block)).toBe(true);
    expect(payloadCarriesRequestText(JSON.stringify({ system: block }), block)).toBe(true);
    expect(payloadCarriesRequestText({ system: "a capability replaced me" }, block)).toBe(false);
  });
});

describe("the guard across the payload of EVERY provider pi-ai 0.84.3 ships", () => {
  // Real payloads, built by pi-ai's own adapter for each API and captured at
  // `onPayload` — the seam pi routes to `before_provider_request`, which is
  // where bob's guard sits. This is the round-2 defect pinned: a guard that
  // READ a few shapes failed a legitimate request the moment a provider
  // differed (the Responses APIs put the prompt in `input`, Google in
  // `config.systemInstruction`, and neither was a shape it read).
  for (const probe of PROVIDER_PROBES) {
    it(`${probe.name}: carries the block → passed, without it → refused`, async () => {
      const block = buildContractBlock({
        label: "TASK",
        text: "commit the fixture, then report",
      });
      const carrying = await payloadFor(probe, `You are bob, an office agent.\n\n${block}`);
      expect(contractVerdictForRequest(carrying, block)).toEqual({
        allowed: true,
        kind: "carries-contract",
      });

      const missing = await payloadFor(probe, "You are bob. A capability replaced the contract.");
      expect(JSON.stringify(missing), "no part of the block in the payload").not.toContain(
        CONTRACT_SENTINEL_PREFIX,
      );
      const verdict = contractVerdictForRequest(missing, block);
      expect(verdict.allowed, `${probe.name} without the block is refused`).toBe(false);
      if (!verdict.allowed) expect(verdict.reason).toBe("contract_missing_from_system_prompt");
    });
  }
});

describe("contractVerdictForRequest", () => {
  const block = buildContractBlock({ label: "TASK", text: "do the thing" });

  it("allows an agent request whose payload carries the block", () => {
    const verdict = contractVerdictForRequest(
      { system: [{ type: "text", text: `persona\n\n${block}` }] },
      block,
    );
    expect(verdict).toEqual({ allowed: true, kind: "carries-contract" });
  });

  it("REFUSES an agent request whose payload lost it, and says what it looked at", () => {
    const verdict = contractVerdictForRequest({ system: "a capability replaced me" }, block);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toBe("contract_missing_from_system_prompt");
      expect(verdict.detail).toContain("payload");
    }
  });

  it("REFUSES a payload it cannot read at all", () => {
    // "I could not see it" is not "it is there".
    const verdict = contractVerdictForRequest(
      { messages: [{ role: "user", content: "hi" }] },
      block,
    );
    expect(verdict.allowed).toBe(false);
  });

  it("EXEMPTS pi's own summarization request — on pi's compaction flag, not on text", () => {
    const summarizationPayload = { system: [{ type: "text", text: PI_SUMMARIZATION_PROMPT }] };
    const verdict = contractVerdictForRequest(summarizationPayload, block, {
      compacting: () => true,
    });
    expect(verdict).toEqual({ allowed: true, kind: "pi-summarization" });
  });

  it("does NOT let a capability borrow the exemption: the marker, or pi's WHOLE prompt", () => {
    // Round 2: the exemption keyed on a marker IN THE PROMPT, so a capability
    // could paste the marker in and drop the contract. Now the flag decides, and
    // an agent request is never made while pi is compacting — so both texts are
    // refused when the flag is false.
    for (const text of [
      "You are a context summarization assistant.",
      PI_SUMMARIZATION_PROMPT,
      `${PI_SUMMARIZATION_PROMPT}\n\nAgent turn: answer the operator.`,
    ]) {
      const verdict = contractVerdictForRequest({ system: text }, block, {
        compacting: () => false,
      });
      expect(verdict.allowed, `"${text.slice(0, 40)}…" must not exempt`).toBe(false);
    }
  });

  it("exempts nothing when the flag is absent or false", () => {
    for (const opts of [{}, { compacting: () => false }]) {
      expect(contractVerdictForRequest({ system: "no contract here" }, block, opts).allowed).toBe(
        false,
      );
    }
  });
});

describe("the guard extension", () => {
  type Handler = (event: { payload: unknown }) => unknown;

  function loadGuard(
    deps: {
      dispose: () => void;
      exit: (code: number) => void;
      log: (m: string) => void;
    },
    compacting?: () => boolean,
  ): Handler {
    const handlers: Handler[] = [];
    const extension = createContractGuardExtension({
      contract: "THE CONTRACT",
      deps: () => deps,
      ...(compacting !== undefined ? { compacting } : {}),
    });
    const factory = typeof extension === "function" ? extension : extension.factory;
    factory({
      on(event: string, handler: Handler) {
        if (event === "before_provider_request") handlers.push(handler);
      },
    } as never);
    expect(handlers).toHaveLength(1);
    return handlers[0];
  }

  it("fails the turn like a failed audit when the request lost the contract", () => {
    const disposed: number[] = [];
    const exits: number[] = [];
    const logs: string[] = [];
    const handler = loadGuard({
      dispose: () => disposed.push(1),
      exit: (code) => exits.push(code),
      log: (m) => logs.push(m),
    });

    handler({ payload: { system: "no contract here" } });

    expect(disposed, "the session is disposed").toEqual([1]);
    expect(exits, "the process is ended with a failure code").toEqual([1]);
    expect(logs.join("\n")).toContain("contract_missing_from_system_prompt");
    expect(logs.join("\n")).toContain("payload");
  });

  it("does nothing when the request carries the contract", () => {
    const disposed: number[] = [];
    const exits: number[] = [];
    const handler = loadGuard({
      dispose: () => disposed.push(1),
      exit: (code) => exits.push(code),
      log: () => {},
    });
    handler({ payload: { system: "prefix THE CONTRACT suffix" } });
    expect(disposed).toEqual([]);
    expect(exits).toEqual([]);
  });

  it("does nothing while pi is compacting — its own summarization request", () => {
    const disposed: number[] = [];
    const exits: number[] = [];
    const handler = loadGuard(
      { dispose: () => disposed.push(1), exit: (code) => exits.push(code), log: () => {} },
      () => true,
    );
    handler({ payload: { system: "pi's summarization prompt, no contract" } });
    expect(disposed).toEqual([]);
    expect(exits).toEqual([]);
  });

  it("is a HIDDEN inline extension, so pi appends it last without listing it", () => {
    const extension = createContractGuardExtension({
      contract: "x",
      deps: () => ({ dispose: () => {}, exit: () => {}, log: () => {} }),
    });
    expect(typeof extension).not.toBe("function");
    if (typeof extension !== "function") {
      expect(extension.name).toBe("bob-contract-guard");
      expect(extension.hidden).toBe(true);
    }
  });
});
