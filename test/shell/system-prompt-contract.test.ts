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
  MIN_CONTRACT_CAP_CHARS,
  PI_SUMMARIZATION_MARKER,
  systemPromptFromRequestPayload,
} from "../../src/shell/system-prompt-contract.js";

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

describe("systemPromptFromRequestPayload", () => {
  it("reads Anthropic's system blocks", () => {
    expect(systemPromptFromRequestPayload({ system: [{ type: "text", text: "hello" }] })).toBe(
      "hello",
    );
  });

  it("reads a plain string system prompt", () => {
    expect(systemPromptFromRequestPayload({ system: "hello" })).toBe("hello");
  });

  it("reads Google's systemInstruction and the Responses APIs' instructions", () => {
    expect(systemPromptFromRequestPayload({ systemInstruction: "g" })).toBe("g");
    expect(systemPromptFromRequestPayload({ instructions: "r" })).toBe("r");
  });

  it("reads OpenAI chat-completions, where the payload IS the messages", () => {
    const messages = [
      { role: "system", content: "sys" },
      { role: "user", content: "hi" },
    ];
    expect(systemPromptFromRequestPayload(messages)).toBe("sys");
    expect(systemPromptFromRequestPayload({ messages })).toBe("sys");
    expect(
      systemPromptFromRequestPayload({ messages: [{ role: "developer", content: "dev" }] }),
    ).toBe("dev");
  });

  it("returns undefined for a payload it cannot read", () => {
    expect(systemPromptFromRequestPayload(null)).toBeUndefined();
    expect(systemPromptFromRequestPayload("a string")).toBeUndefined();
    expect(
      systemPromptFromRequestPayload({ messages: [{ role: "user", content: "hi" }] }),
    ).toBeUndefined();
  });
});

describe("contractVerdictForRequest", () => {
  const block = buildContractBlock({ label: "TASK", text: "do the thing" });

  it("allows an agent request that carries the contract", () => {
    const verdict = contractVerdictForRequest(
      { system: [{ type: "text", text: `persona\n\n${block}` }] },
      block,
    );
    expect(verdict).toEqual({ allowed: true, kind: "carries-contract" });
  });

  it("REFUSES an agent request whose system prompt lost it", () => {
    const verdict = contractVerdictForRequest({ system: "a capability replaced me" }, block);
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.reason).toBe("contract_missing_from_system_prompt");
  });

  it("REFUSES a payload whose system prompt it cannot read at all", () => {
    // "I could not see it" is not "it is there".
    const verdict = contractVerdictForRequest(
      { messages: [{ role: "user", content: "hi" }] },
      block,
    );
    expect(verdict.allowed).toBe(false);
  });

  it("EXCLUDES pi's own summarization request, by name", () => {
    const verdict = contractVerdictForRequest(
      { system: `${PI_SUMMARIZATION_MARKER}\n\nProduce the structured summary.` },
      block,
    );
    expect(verdict).toEqual({ allowed: true, kind: "pi-summarization" });
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
    expect(logs.join("\n")).toContain("contract_missing_from_system_prompt");
    expect(logs.join("\n")).toContain("the request's system prompt");
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
