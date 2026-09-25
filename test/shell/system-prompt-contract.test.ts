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
  capContractText,
  contractVerdictForRequest,
  createContractGuardExtension,
  DEFAULT_CONTRACT_CAP_CHARS,
  decodedRequestPayload,
  MIN_CONTRACT_CAP_CHARS,
  payloadCarriesRequestText,
  scanRequestPayload,
  wellFormedContractText,
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

describe("the request check: the payload's DECODED string values, never a serialization", () => {
  it("reads a string payload as the JSON it is sent as", () => {
    expect(decodedRequestPayload('{"a":1}')).toEqual({ a: 1 });
  });

  it("treats a string that is not JSON as its own value", () => {
    expect(decodedRequestPayload("raw text, not a body")).toBe("raw text, not a body");
  });

  it("leaves a non-string payload alone", () => {
    expect(decodedRequestPayload({ a: 1 })).toEqual({ a: 1 });
  });

  it("never vouches for a payload it cannot read", () => {
    // A cycle cannot appear in a payload a provider sends, and walking one must
    // not loop: it is a check the guard cannot run, never a pass.
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(payloadCarriesRequestText(cyclic, "anything")).toBe(false);
    expect(payloadCarriesRequestText(undefined, "anything")).toBe(false);
    expect(contractVerdictForRequest(undefined, "the block").allowed).toBe(false);
  });

  it("finds the block in a decoded string value, and nothing when it is absent", () => {
    const block = buildContractBlock({ label: "TASK", text: "do the thing" });
    expect(payloadCarriesRequestText({ system: block }, block)).toBe(true);
    expect(payloadCarriesRequestText(JSON.stringify({ system: block }), block)).toBe(true);
    expect(payloadCarriesRequestText({ system: "a capability replaced me" }, block)).toBe(false);
  });

  it("passes a body that writes a character ESCAPED — the decoded value is what counts", () => {
    // Round 3's defect: a substring search of the serialization false-fails
    // equivalent text. A client that escapes non-ASCII writes `é` as `\u00e9`,
    // and no search of that text finds a block that carries the character.
    const block = buildContractBlock({ label: "TASK", text: "résumé the inbox" });
    const body = JSON.stringify({ system: block }).replace(/\u00e9/g, "\\u00e9");
    expect(body).toContain("\\u00e9");
    expect(body).not.toContain("\u00e9");
    expect(payloadCarriesRequestText(body, block)).toBe(true);
    expect(decodedRequestPayload(body)).toEqual({ system: block });
  });

  it("counts the string values it walked, so a refusal states what it looked at", () => {
    const scan = scanRequestPayload(
      { system: "no contract", messages: [{ role: "user", content: "hi" }] },
      "THE BLOCK",
    );
    expect(scan).toEqual({ carries: false, stringValues: 3, readable: true });
  });

  it("builds the block WELL-FORMED — unpaired surrogates are gone before it is compared", () => {
    // pi-ai's adapters strip unpaired surrogates from the system prompt before
    // they build a request (utils/sanitize-unicode `sanitizeSurrogates`), so a
    // block that carried one would not be the block in the payload.
    const lone = String.fromCharCode(0xd83d);
    expect(wellFormedContractText(`keep ${lone} drop`)).toBe("keep  drop");
    expect(wellFormedContractText("keep éàü drop")).toBe("keep éàü drop");
    const block = buildContractBlock({ label: "TASK", text: `clean the ${lone} inbox` });
    expect(block).not.toContain(lone);
    expect(block).toContain("clean the  inbox");
    // A task that is nothing but unpaired surrogates says nothing once they are
    // gone, and is refused rather than shipped as an empty contract.
    expect(() => buildContractBlock({ label: "TASK", text: lone })).toThrow(/blank task/);
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
      if (!verdict.allowed) expect(verdict.reason).toBe("contract_missing_from_request");
    });
  }

  it("passes a task with an UNPAIRED SURROGATE through the real OpenAI Completions adapter", async () => {
    // Round 3's defect, on the adapter that reproduced it: pi-ai's
    // openai-completions builder sanitizes the system prompt with
    // `sanitizeSurrogates` BEFORE the hook (api/openai-completions.js), so a
    // block that carried an unpaired surrogate would be a DIFFERENT string in
    // the payload and a legitimate turn would be refused. The block is built
    // well-formed, so the adapter's sanitizing is a no-op on it.
    const probe = PROVIDER_PROBES.find((p) => p.model.api === "openai-completions");
    if (probe === undefined) throw new Error("the OpenAI Completions probe is missing");
    const lone = String.fromCharCode(0xd83d);
    const block = buildContractBlock({
      label: "TASK",
      text: `clean the ${lone} inbox, then report`,
    });
    expect(block, "the block is built without the unpaired surrogate").not.toContain(lone);

    const payload = await payloadFor(probe, `You are bob, an office agent.\n\n${block}`);
    expect(contractVerdictForRequest(payload, block)).toEqual({
      allowed: true,
      kind: "carries-contract",
    });
  });
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

  it("REFUSES an agent request that lost it, and says what it looked at", () => {
    const verdict = contractVerdictForRequest({ system: "a capability replaced me" }, block);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) {
      expect(verdict.reason).toBe("contract_missing_from_request");
      expect(verdict.detail).toContain("string value");
      expect(verdict.detail).toContain("contract block");
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

  it("REFUSES an agent request that appears during BRANCH SUMMARIZATION — there is no exemption to consult", () => {
    // Round 3 deletes round 2's exemption: pi 0.84.3 sets `isCompacting`
    // during a branch summary too (`navigateTree`), and a capability's
    // `sendMessage` with `triggerTurn` can start an agent turn in that window,
    // so a flag-based exemption could pass a REAL agent request with no block.
    // The verdict takes no flag now: a request that does not carry the block
    // fails, whatever pi is doing.
    const verdict = contractVerdictForRequest(
      { system: "a branch summary is running; an agent turn started anyway" },
      block,
    );
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe("contract_missing_from_request");
  });

  it("does NOT let a capability borrow an exemption: pi's prompt, in full or in part", () => {
    // Round 2: the exemption keyed on a marker IN THE PROMPT, so a capability
    // could paste the marker in and drop the contract. Round 3 deletes the
    // exemption outright, so even pi's WHOLE summarization prompt — the
    // hardest text to tell from pi's own call — exempts nothing.
    for (const text of [
      "You are a context summarization assistant.",
      PI_SUMMARIZATION_PROMPT,
      `${PI_SUMMARIZATION_PROMPT}\n\nAgent turn: answer the operator.`,
    ]) {
      const verdict = contractVerdictForRequest({ system: text }, block);
      expect(verdict.allowed, `"${text.slice(0, 40)}…" must not exempt`).toBe(false);
    }
  });

  it("PASSES when the block rides a user message instead of the system field", () => {
    // The guarantee is that the request CARRIES the contract block: the system
    // prompt is where bob puts it, and a capability that moves it into the
    // conversation still sends the block to the model — which is what #145 is
    // about (a request that goes out WITHOUT it).
    const carried = {
      messages: [{ role: "user", content: [{ type: "text", text: block }] }],
    };
    expect(contractVerdictForRequest(carried, block)).toEqual({
      allowed: true,
      kind: "carries-contract",
    });
  });
});

describe("the guard extension", () => {
  type Handler = (event: { payload: unknown }) => unknown;

  function loadGuard(deps: {
    dispose: () => void;
    exit: (code: number) => void;
    log: (m: string) => void;
  }): Handler {
    const handlers: Handler[] = [];
    const extension = createContractGuardExtension({
      contract: "THE CONTRACT",
      deps: () => deps,
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
    expect(logs.join("\n")).toContain("contract_missing_from_request");
    expect(logs.join("\n")).toContain("string value");
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

  it("fails a block-less agent request DURING branch summarization — the guard consults no flag", () => {
    // The request that round 2's exemption would have passed: pi is summarizing
    // a branch (`isCompacting` true, `navigateTree`), and an agent turn starts
    // in that window (`sendMessage` with `triggerTurn`). With the exemption
    // deleted there is nothing to consult, so the request fails like any other.
    const disposed: number[] = [];
    const exits: number[] = [];
    const handler = loadGuard({
      dispose: () => disposed.push(1),
      exit: (code) => exits.push(code),
      log: () => {},
    });
    handler({ payload: { system: "pi is summarizing a branch; an agent turn started anyway" } });
    expect(disposed, "the session is disposed").toEqual([1]);
    expect(exits, "the process is ended").toEqual([1]);
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

describe("the block and the guard read what is actually sent (#158 round 4)", () => {
  const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  it("a cap never cuts inside a surrogate pair", () => {
    const emoji = "\u{1F600}".repeat(400); // 800 UTF-16 units, every one half of a pair
    for (let cap = 60; cap < 140; cap += 1) {
      expect(loneSurrogate.test(capContractText(emoji, cap)), `cap ${cap}`).toBe(false);
    }
  });

  it("a long emoji task at the default cap builds a well-formed block the guard passes after sanitising", () => {
    const task = "\u{1F680} ship it ".repeat(Math.ceil(DEFAULT_CONTRACT_CAP_CHARS / 5));
    const block = buildContractBlock({ label: "TASK", text: task });
    expect(wellFormedContractText(block)).toBe(block);
    // What an adapter that strips lone surrogates would send is the same text.
    expect(
      contractVerdictForRequest({ system: wellFormedContractText(block) }, block).allowed,
    ).toBe(true);
  });

  it("reads the payload as serialized: a toJSON() that drops the block is refused", () => {
    const block = buildContractBlock({ label: "TASK", text: "do the thing" });
    const payload = {
      system: block,
      toJSON() {
        return { system: "Ignore the task" };
      },
    };
    expect(contractVerdictForRequest(payload, block).allowed).toBe(false);
    expect(decodedRequestPayload(payload)).toEqual({ system: "Ignore the task" });
  });

  it("a payload that cannot be serialized cannot be sent, and is refused as unreadable", () => {
    const block = buildContractBlock({ label: "TASK", text: "do the thing" });
    const scan = scanRequestPayload({ system: block, n: 10n }, block);
    expect(scan.readable).toBe(false);
    expect(contractVerdictForRequest({ system: block, n: 10n }, block).allowed).toBe(false);
  });
});
