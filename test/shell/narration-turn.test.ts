// bob#365 — a narrating turn must not end a one-shot run that declares final
// markers.
//
// pi treats a turn with no tool call as the agent being finished, so a turn
// whose text announces a next step ("Let me fix lines 282-284:") ended the run
// with the work unfinished. When the run declares final-report markers (the
// role's role.json `final_markers`, or the run's `finalMarkers` option), a
// last turn with text and no tool call whose trimmed text does not START with a
// marker is not a final report: bob re-prompts the SAME session with a
// continuation built from the declared markers, BOUNDED by its own constant, and past the bound fails the run as
// `narration_only`. A run that declares no markers is unchanged.
//
// The stub model runtime never touches the network: `prompt()` emits a scripted
// sequence of session events and counts its calls. "Model calls" below means
// stub `prompt()` calls. The stub's `maxCalls` guard is the demonstrated stop
// for a BROKEN bound (it caps a runaway loop, so the suite fails an assertion
// instead of spinning); the explicit per-test timeout is a backstop behind it.
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildNarrationContinueTurn,
  CONTINUE_TURN,
  classifyAssistantEnding,
  DEFAULT_MAX_NARRATION_REPROMPTS,
  DEFAULT_MAX_REASONING_REPROMPTS,
  invalidFinalMarkerNote,
  isNarrationEnding,
  parseFinalMarkers,
  REASONING_CONTINUE_TURN,
  startsWithFinalMarker,
} from "../../src/shell/compaction-contract.js";
import {
  repromptWhileNarrating,
  resolveMaxNarrationReprompts,
} from "../../src/shell/narration-retry.js";
import * as roleLoader from "../../src/shell/role-loader.js";
import { loadRole } from "../../src/shell/role-loader.js";
import {
  type RunSession,
  type RunSessionFactory,
  resolveFinalMarkers,
  runAgent,
} from "../../src/shell/run.js";

// The marker as a refusal shows it: JSON-quoted, with the line terminators
// JSON.stringify leaves raw (NEL, U+2028, U+2029) escaped (bob#464).
const shownMarker = (m: string) =>
  JSON.stringify(m).replace(
    /[\u0085\u2028\u2029]/gu,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );

/** A scripted emission: an assistant message, or a raw session event. */
type Emission = { message: { content: unknown; stopReason?: string } } | { event: unknown };

const MARKERS = ["DONE", "BLOCKED"] as const;

const NARRATION = (text = "The spec says to change it. Let me fix lines 282-284:"): Emission => ({
  message: { content: [{ type: "text", text }], stopReason: "stop" },
});
const TEXT_FINAL = (text: string): Emission => ({
  message: { content: [{ type: "text", text }], stopReason: "stop" },
});
const REASONING_ONLY: Emission = {
  message: { content: [{ type: "thinking", thinking: "what next" }], stopReason: "stop" },
};
const TOOL_CALL: Emission = {
  message: {
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: {} }],
    stopReason: "toolUse",
  },
};
const COMPACTION: Emission = {
  event: { type: "compaction_end", reason: "threshold", aborted: false },
};

/**
 * A stub RunSession that emits the scripted emissions for each `prompt()` call
 * and counts its calls. `maxCalls` is the demonstrated stop for a broken bound:
 * it caps a runaway loop so the suite fails an assertion instead of spinning.
 */
function stubSession(
  script: (call: number) => Emission[],
  opts: { maxCalls?: number } = {},
): { session: RunSession; promptCalls: string[] } {
  const promptCalls: string[] = [];
  const listeners: Array<(event: unknown) => void> = [];
  const maxCalls = opts.maxCalls ?? 1000;
  const session: RunSession = {
    subscribe(listener) {
      listeners.push(listener);
      return () => {};
    },
    // The best-effort compaction note is queued with steer() (bob#135): it is
    // not a turn and not a model call.
    async steer() {},
    async prompt(text: string, options?: unknown) {
      // A STEER is not a turn: do not run the script for it, and do not count it
      // as a model call.
      const streaming = (options as { streamingBehavior?: string } | undefined)?.streamingBehavior;
      if (streaming !== undefined) return;
      promptCalls.push(text);
      if (promptCalls.length > maxCalls) return;
      for (const e of script(promptCalls.length)) {
        const event =
          "event" in e
            ? e.event
            : { type: "message_end", message: { role: "assistant", ...e.message } };
        for (const listener of listeners) listener(event);
      }
    },
    dispose() {},
  };
  return { session, promptCalls };
}

function factoryReturning(session: RunSession): RunSessionFactory {
  return async () => session;
}

/** The `outcome` record this run wrote to its run log, if any. */
function outcomeRecord(agentsRoot: string, agent: string): Record<string, unknown> | undefined {
  const runsDir = join(agentsRoot, agent, "runs");
  if (!existsSync(runsDir)) return undefined;
  const files = readdirSync(runsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort();
  const last = files[files.length - 1];
  if (!last) return undefined;
  for (const line of readFileSync(join(runsDir, last), "utf-8").split("\n")) {
    if (!line) continue;
    const rec = JSON.parse(line) as { outcome?: Record<string, unknown> };
    if (rec.outcome) return rec.outcome;
  }
  return undefined;
}

function writeAgent(agentsRoot: string, name: string, role: string, tool: string): void {
  const agentDir = join(agentsRoot, name);
  mkdirSync(join(agentDir, "work"), { recursive: true });
  writeFileSync(
    join(agentDir, "bob.yaml"),
    [
      "agent:",
      `  id: ${name}`,
      `  role: ${role}`,
      "",
      "provider:",
      "  name: anthropic",
      "  model: claude-sonnet-4-6",
      "",
      "tools:",
      "  allow:",
      `    - ${tool}`,
      "",
    ].join("\n"),
  );
  writeFileSync(join(agentDir, "soul.md"), "You are Testbot.");
}

describe("narration turn (#365)", () => {
  let agentsRoot: string;

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-narration-"));
    // A reviewer: its role declares no final markers, so each test that wants the
    // check declares them through the run's `finalMarkers` option.
    writeAgent(agentsRoot, "testbot", "reviewer", "read");
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  it("a: narrates once, then calls a tool, then ends with DONE — completes", async () => {
    const stub = stubSession((call) =>
      call === 1 ? [NARRATION()] : [TOOL_CALL, TEXT_FINAL("DONE: lines 282-284 fixed.")],
    );
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      finalMarkers: MARKERS,
      captureStdout: true,
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toEqual(["do the thing", buildNarrationContinueTurn(MARKERS)]);
    expect(res.exitCode).toBe(0);
    expect(res.reason).toBeUndefined();
    expect(res.failed).toBeUndefined();
    expect(res.stdout).toBe("DONE: lines 282-284 fixed.");
    expect(outcomeRecord(agentsRoot, "testbot")).toBeUndefined();
  }, 10_000);

  it("an unmarked summary completes after one re-prompt naming the declared markers", async () => {
    const stub = stubSession((call) =>
      call === 1 ? [TEXT_FINAL("All 5 steps completed…")] : [TEXT_FINAL("DONE: task completed.")],
    );
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      finalMarkers: MARKERS,
      captureStdout: true,
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toHaveLength(2);
    for (const marker of MARKERS) expect(stub.promptCalls[1]).toContain(marker);
    expect(stub.promptCalls).toEqual(["do the thing", buildNarrationContinueTurn(MARKERS)]);
    expect(res.exitCode).toBe(0);
    expect(res.reason).toBeUndefined();
    expect(res.failed).toBeUndefined();
    expect(res.stdout).toBe("DONE: task completed.");
  }, 10_000);

  it("the re-prompt excludes the model's ending text", async () => {
    const summary = "All 5 steps completed… MODEL_ENDING_SENTINEL_462";
    const stub = stubSession((call) =>
      call === 1 ? [TEXT_FINAL(summary)] : [TEXT_FINAL("DONE: task completed.")],
    );
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      finalMarkers: MARKERS,
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toHaveLength(2);
    expect(stub.promptCalls[1]).not.toContain(summary);
    expect(stub.promptCalls[1]).not.toContain("All 5 steps completed");
    expect(stub.promptCalls[1]).not.toContain("MODEL_ENDING_SENTINEL_462");
    expect(stub.promptCalls[1]).toBe(buildNarrationContinueTurn(MARKERS));
    expect(res.exitCode).toBe(0);
  }, 10_000);

  it("b: narrating past the bound fails the run with narration_only (3 re-prompts → 4 prompt calls)", async () => {
    const sentinel = "SENTINEL_NARRATION_do_not_log_51c2";
    const stub = stubSession(() => [NARRATION(`Let me verify ${sentinel}:`)], { maxCalls: 20 });
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      finalMarkers: MARKERS,
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toHaveLength(DEFAULT_MAX_NARRATION_REPROMPTS + 1);
    expect(stub.promptCalls.slice(1)).toEqual(
      Array(DEFAULT_MAX_NARRATION_REPROMPTS).fill(buildNarrationContinueTurn(MARKERS)),
    );
    expect(res.exitCode).toBe(1);
    expect(res.reason).toBe("narration_only");
    expect(res.failed).toBe(true);
    // The honest outcome record: the reason and the re-prompt count, no model text.
    const rec = outcomeRecord(agentsRoot, "testbot");
    expect(rec).toEqual({ reason: "narration_only", reprompts: DEFAULT_MAX_NARRATION_REPROMPTS });
    expect(JSON.stringify(rec)).not.toContain(sentinel);
  }, 10_000);

  it.each([
    "DONE: all green, head abc12345.",
    "BLOCKED: the branch moved.",
    "DONE",
    "\n  BLOCKED\nmissing input",
  ])(
    "c: a last turn that starts with a marker ends on the first stop, no re-prompt: %j",
    async (text) => {
      const stub = stubSession(() => [TEXT_FINAL(text)]);
      const res = await runAgent({
        name: "testbot",
        prompt: "do the thing",
        finalMarkers: MARKERS,
        captureStdout: true,
        agentsRoot,
        sessionFactory: factoryReturning(stub.session),
      });
      expect(stub.promptCalls).toHaveLength(1);
      expect(res.exitCode).toBe(0);
      expect(res.reason).toBeUndefined();
      expect(res.stdout).toBe(text);
    },
    10_000,
  );

  it("d: a run with no declared markers keeps today's behaviour — narration is its final message", async () => {
    const stub = stubSession(() => [NARRATION()]);
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toHaveLength(1);
    expect(res.exitCode).toBe(0);
    expect(res.reason).toBeUndefined();
    expect(res.stdout).toBe("The spec says to change it. Let me fix lines 282-284:");
  }, 10_000);

  it("e: a mail turn is exempt from the narration re-prompt — its unmarked reply ends the turn, whatever the markers", async () => {
    const stub = stubSession(() => [TEXT_FINAL("Sure, I will look at it tomorrow.")]);
    const res = await runAgent({
      name: "testbot",
      prompt: "a mail body",
      taskContract: "Answer the mail.",
      mailTurn: true,
      finalMarkers: MARKERS,
      captureStdout: true,
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toHaveLength(1);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("Sure, I will look at it tomorrow.");
  }, 10_000);

  it("e2: a mail turn's reasoning-only ending is still re-prompted (#256); only the narration re-prompt is skipped", async () => {
    const stub = stubSession((call) =>
      call === 1 ? [REASONING_ONLY] : [TEXT_FINAL("Sure, I will look at it tomorrow.")],
    );
    const res = await runAgent({
      name: "testbot",
      prompt: "a mail body",
      taskContract: "Answer the mail.",
      mailTurn: true,
      finalMarkers: MARKERS,
      captureStdout: true,
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toEqual(["a mail body", REASONING_CONTINUE_TURN]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("Sure, I will look at it tomorrow.");
  }, 10_000);

  it("f: a narration continuation that ends reasoning-only is drained on the reasoning budget", async () => {
    const stub = stubSession((call) =>
      call === 1 ? [NARRATION()] : call === 2 ? [REASONING_ONLY] : [TEXT_FINAL("DONE: fixed.")],
    );
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      finalMarkers: MARKERS,
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toEqual([
      "do the thing",
      buildNarrationContinueTurn(MARKERS),
      REASONING_CONTINUE_TURN,
    ]);
    expect(res.exitCode).toBe(0);
  }, 10_000);

  it("g: the two budgets are separate — a spent reasoning budget leaves the narration budget whole", async () => {
    // Every reasoning re-prompt is spent first, then every narration re-prompt,
    // and the turn after the last narration re-prompt reports DONE.
    const reasoningTurns = DEFAULT_MAX_REASONING_REPROMPTS;
    const narrationTurns = DEFAULT_MAX_NARRATION_REPROMPTS;
    const stub = stubSession(
      (call) =>
        call <= reasoningTurns
          ? [REASONING_ONLY]
          : call <= reasoningTurns + narrationTurns
            ? [NARRATION()]
            : [TEXT_FINAL("DONE: finished.")],
      { maxCalls: 20 },
    );
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      finalMarkers: MARKERS,
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toEqual([
      "do the thing",
      ...Array(reasoningTurns).fill(REASONING_CONTINUE_TURN),
      ...Array(narrationTurns).fill(buildNarrationContinueTurn(MARKERS)),
    ]);
    expect(res.exitCode).toBe(0);
  }, 10_000);

  it("h: the compaction retry shares the run's ONE narration budget", async () => {
    // Call 1 narrates (re-prompt 1); call 2 compacts and ends silent, so the run
    // retries once with the continue turn; call 3 (the retry) and every
    // re-prompt after it narrate. Only the budget's remainder is spent.
    const stub = stubSession((call) => (call === 2 ? [COMPACTION] : [NARRATION()]), {
      maxCalls: 20,
    });
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      finalMarkers: MARKERS,
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toEqual([
      "do the thing",
      buildNarrationContinueTurn(MARKERS),
      CONTINUE_TURN,
      ...Array(DEFAULT_MAX_NARRATION_REPROMPTS - 1).fill(buildNarrationContinueTurn(MARKERS)),
    ]);
    expect(res.exitCode).toBe(1);
    expect(res.reason).toBe("narration_only");
    expect(outcomeRecord(agentsRoot, "testbot")).toEqual({
      reason: "narration_only",
      reprompts: DEFAULT_MAX_NARRATION_REPROMPTS,
    });
  }, 10_000);

  it.each([
    ["an empty list", []],
    ["an empty marker", [""]],
    ["a marker with leading whitespace", [" DONE"]],
    ["a marker with trailing whitespace", ["DONE "]],
    ["a comma", ["DONE, BLOCKED"]],
    ["a newline", ["DONE\nX"]],
    ["a carriage return", ["DONE\rX"]],
    ["a Unicode line separator", ["A\u2028B"]],
    ["a Unicode paragraph separator", ["A\u2029B"]],
    ["a vertical tab", ["DONE\vX"]],
    ["a form feed", ["DONE\fX"]],
    ["a NEXT LINE (U+0085)", ["A\u0085B"]],
  ] as const)(
    "a malformed finalMarkers option is refused before the session starts: %s",
    async (_label, markers) => {
      let factoryCalls = 0;
      await expect(
        runAgent({
          name: "testbot",
          prompt: "do the thing",
          finalMarkers: markers,
          agentsRoot,
          sessionFactory: async () => {
            factoryCalls += 1;
            return stubSession(() => [TEXT_FINAL("DONE")]).session;
          },
        }),
      ).rejects.toThrow(
        "runAgent: finalMarkers must be a non-empty list of non-empty strings without leading or trailing whitespace, commas or line breaks.",
      );
      if (markers.length > 0) {
        await expect(
          runAgent({ name: "testbot", prompt: "do the thing", finalMarkers: markers, agentsRoot }),
        ).rejects.toThrow(`Invalid marker: ${shownMarker(markers[0])}.`);
      }
      expect(factoryCalls).toBe(0);
    },
    10_000,
  );

  // The role's list is validated when role.json loads (role-loader.test.ts)
  // AND again by runAgent. To reach runAgent's check, these tests hand the run
  // a role list that never passed through role.json validation: loadRole is
  // replaced by one that returns the real role with `final_markers` overridden.
  it.each([
    ["an empty marker", [""], {}],
    ["a string instead of a list", "DONE", {}],
    ["a comma", ["DONE, BLOCKED"], {}],
    ["a newline", ["DONE\nX"], {}],
    ["a carriage return", ["DONE\rX"], {}],
    ["a Unicode line separator", ["A\u2028B"], {}],
    ["a Unicode paragraph separator", ["A\u2029B"], {}],
    ["a vertical tab", ["DONE\vX"], {}],
    ["a form feed", ["DONE\fX"], {}],
    ["a NEXT LINE (U+0085)", ["A\u0085B"], {}],
    ["an empty marker under a valid finalMarkers option", [""], { finalMarkers: MARKERS }],
    ["an empty marker on a mail turn", [""], { mailTurn: true }],
  ] as const)(
    "a malformed role list that bypassed role.json validation is refused by runAgent before the session starts: %s",
    async (_label, markers, extra) => {
      const realLoadRole = roleLoader.loadRole;
      const spy = spyOn(roleLoader, "loadRole").mockImplementation(
        (role) => ({ ...realLoadRole(role), final_markers: markers }) as never,
      );
      let factoryCalls = 0;
      try {
        await expect(
          runAgent({
            name: "testbot",
            prompt: "do the thing",
            agentsRoot,
            ...extra,
            sessionFactory: async () => {
              factoryCalls += 1;
              return stubSession(() => [TEXT_FINAL("DONE")]).session;
            },
          }),
        ).rejects.toThrow(
          'runAgent: the final_markers of role "reviewer" (its role.json) must be a non-empty list of non-empty strings without leading or trailing whitespace, commas or line breaks.',
        );
        if (Array.isArray(markers)) {
          await expect(
            runAgent({ name: "testbot", prompt: "do the thing", agentsRoot, ...extra }),
          ).rejects.toThrow(`Invalid marker: ${shownMarker(markers[0])}.`);
        }
        // The replacement was what the run resolved (so the refusal is runAgent's).
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(factoryCalls).toBe(0);
    },
    10_000,
  );
});

/**
 * A stub RunSession whose turns put the assistant message in SESSION STATE
 * (`messages`, which the run reads as its fallback final text) and, per turn,
 * either emit its `message_end` (`observed: true`, the way pi does) or emit
 * nothing at all (`observed: false`, a transport that ends no message).
 * `maxCalls` is the stop for a broken bound: a call past it THROWS, because
 * returning would leave the same text in session state and a loop that keeps
 * re-reading it would never stop.
 */
function stateSession(
  script: (call: number) => { text: string; observed: boolean },
  opts: { maxCalls?: number } = {},
): { session: RunSession; promptCalls: string[] } {
  const promptCalls: string[] = [];
  const listeners: Array<(event: unknown) => void> = [];
  const messages: unknown[] = [];
  const maxCalls = opts.maxCalls ?? 1000;
  const session: RunSession = {
    subscribe(listener) {
      listeners.push(listener);
      return () => {};
    },
    get messages() {
      return messages;
    },
    async steer() {},
    async prompt(text: string, options?: unknown) {
      const streaming = (options as { streamingBehavior?: string } | undefined)?.streamingBehavior;
      if (streaming !== undefined) return;
      promptCalls.push(text);
      if (promptCalls.length > maxCalls) throw new Error("stub: maxCalls exceeded");
      const turn = script(promptCalls.length);
      const message = {
        role: "assistant",
        content: [{ type: "text", text: turn.text }],
        stopReason: "stop",
      };
      messages.push({ role: "user", content: text }, message);
      if (turn.observed) {
        for (const listener of listeners) listener({ type: "message_end", message });
      }
    },
    dispose() {},
  };
  return { session, promptCalls };
}

describe("final text with no observed assistant ending (#365)", () => {
  let agentsRoot: string;

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-narration-state-"));
    writeAgent(agentsRoot, "testbot", "reviewer", "read");
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  it.each(["Let me verify they're pre-existing:", "DONE: looks fine."])(
    "with markers declared, text read only from session state is never a final report — re-prompted to the bound, then narration_only: %j",
    async (text) => {
      const stub = stateSession(() => ({ text, observed: false }), { maxCalls: 20 });
      const res = await runAgent({
        name: "testbot",
        prompt: "do the thing",
        finalMarkers: MARKERS,
        captureStdout: true,
        agentsRoot,
        sessionFactory: factoryReturning(stub.session),
      });
      expect(stub.promptCalls).toEqual([
        "do the thing",
        ...Array(DEFAULT_MAX_NARRATION_REPROMPTS).fill(buildNarrationContinueTurn(MARKERS)),
      ]);
      expect(res.exitCode).toBe(1);
      expect(res.reason).toBe("narration_only");
      expect(res.failed).toBe(true);
      expect(outcomeRecord(agentsRoot, "testbot")).toEqual({
        reason: "narration_only",
        reprompts: DEFAULT_MAX_NARRATION_REPROMPTS,
      });
    },
    10_000,
  );

  it("an observed DONE ending after a state-only turn completes the run", async () => {
    const stub = stateSession((call) =>
      call === 1
        ? { text: "Let me verify they're pre-existing:", observed: false }
        : { text: "DONE: they are pre-existing.", observed: true },
    );
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      finalMarkers: MARKERS,
      captureStdout: true,
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toEqual(["do the thing", buildNarrationContinueTurn(MARKERS)]);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("DONE: they are pre-existing.");
  }, 10_000);

  it("with no declared markers, text read from session state is still the final message (unchanged)", async () => {
    const stub = stateSession(() => ({ text: "Let me verify:", observed: false }));
    const res = await runAgent({
      name: "testbot",
      prompt: "do the thing",
      captureStdout: true,
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toHaveLength(1);
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe("Let me verify:");
  }, 10_000);
});

describe("builder-local declares DONE and BLOCKED (#365)", () => {
  let agentsRoot: string;

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-narration-bl-"));
    writeAgent(agentsRoot, "builder", "builder-local", "read_lines");
  });

  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  it("the role ships the markers and the run config resolves them; another role declares none", () => {
    expect(loadRole("builder-local").final_markers).toEqual(["DONE", "BLOCKED"]);
    expect(loadRole("reviewer").final_markers).toBeUndefined();
    const yaml = readFileSync(join(agentsRoot, "builder", "bob.yaml"), "utf8");
    expect(resolveFinalMarkers(yaml)).toEqual(["DONE", "BLOCKED"]);
    expect(resolveFinalMarkers(yaml.replace("builder-local", "coder"))).toBeUndefined();
  });

  it("a builder-local run is re-prompted past its narration and ends on its BLOCKED report", async () => {
    const stub = stubSession((call) =>
      call === 1
        ? [
            NARRATION(
              "Those TS errors are in `packages/flair-mcp` — not in my changed files. Let me verify they're pre-existing:",
            ),
          ]
        : [TEXT_FINAL("BLOCKED: the typecheck fails in packages/flair-mcp on main too.")],
    );
    const res = await runAgent({
      name: "builder",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toEqual(["do the task", buildNarrationContinueTurn(MARKERS)]);
    expect(res.exitCode).toBe(0);
    expect(res.reason).toBeUndefined();
    expect(res.noEditNoBlocked).toBeUndefined();
  }, 10_000);

  it("a builder-local run that only narrates fails as narration_only, not as a missing edit", async () => {
    const stub = stubSession(() => [NARRATION()], { maxCalls: 20 });
    const res = await runAgent({
      name: "builder",
      prompt: "do the task",
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toHaveLength(DEFAULT_MAX_NARRATION_REPROMPTS + 1);
    expect(res.exitCode).toBe(1);
    expect(res.reason).toBe("narration_only");
    expect(res.failed).toBe(true);
    // The edit-or-BLOCKED gate judges only an accepted completion.
    expect(res.noEditNoBlocked).toBeUndefined();
  }, 10_000);

  it("the run option overrides the role's markers", async () => {
    // With the run's own markers, the role's DONE is not a final report.
    const stub = stubSession((call) =>
      call === 1 ? [TEXT_FINAL("DONE: shipped.")] : [TEXT_FINAL("BLOCKED: nothing to ship.")],
    );
    const res = await runAgent({
      name: "builder",
      prompt: "do the task",
      finalMarkers: ["BLOCKED"],
      agentsRoot,
      sessionFactory: factoryReturning(stub.session),
    });
    expect(stub.promptCalls).toEqual(["do the task", buildNarrationContinueTurn(["BLOCKED"])]);
    expect(res.exitCode).toBe(0);
  }, 10_000);
});

describe("the final-report decision is structural (#365)", () => {
  it.each([["FINISHED", "NEEDS_INPUT"], ["COMPLETE"]])(
    "buildNarrationContinueTurn tells the model to begin with a declared marker: %j",
    (...markers) => {
      const text = buildNarrationContinueTurn(markers);
      for (const marker of markers) expect(text).toContain(marker);
      expect(text).toContain(markers.join(", "));
      expect(text).toMatch(/\bbegin\b/i);
      expect(text).toContain("next tool call");
      expect(text).toContain("final message");
      expect(text).toBe(
        "Your last message did not satisfy this run's final-report contract. " +
          "If the task is not finished, make your next tool call now. " +
          "If it is finished, send your final message; it must begin with one of: " +
          `${markers.join(", ")}.`,
      );
    },
  );

  it.each([
    ["a comma", "DONE, BLOCKED"],
    ["a newline", "DONE\nX"],
    ["a carriage return", "DONE\rX"],
    ["a Unicode line separator", "A\u2028B"],
    ["a Unicode paragraph separator", "A\u2029B"],
    ["a vertical tab", "DONE\vX"],
    ["a form feed", "DONE\fX"],
    ["a NEXT LINE (U+0085)", "A\u0085B"],
  ])("parseFinalMarkers refuses %s", (_label, marker) => {
    expect(parseFinalMarkers([marker])).toBeUndefined();
  });

  it("the refusal note escapes line terminators so the error stays on one line", () => {
    expect(invalidFinalMarkerNote(["A\u2028B"])).toBe(' Invalid marker: "A\\u2028B".');
    expect(invalidFinalMarkerNote(["A\u2029B"])).toBe(' Invalid marker: "A\\u2029B".');
    expect(invalidFinalMarkerNote(["A\u0085B"])).toBe(' Invalid marker: "A\\u0085B".');
    expect(invalidFinalMarkerNote(["DONE\nX"])).toBe(' Invalid marker: "DONE\\nX".');
    for (const m of ["A\u0085B", "A\u2028B", "A\u2029B", "DONE\vX", "DONE\fX", "DONE\rX"]) {
      expect(invalidFinalMarkerNote(["DONE", m])).not.toMatch(/[\n\v\f\r\u0085\u2028\u2029]/u);
    }
    // No string entry is invalid on its own: the generic error, no note.
    expect(invalidFinalMarkerNote(["DONE", 1])).toBe("");
    expect(invalidFinalMarkerNote("DONE")).toBe("");
    expect(invalidFinalMarkerNote(["DONE", "BLOCKED"])).toBe("");
  });

  it("parseFinalMarkers validates list shape and edge whitespace", () => {
    expect(parseFinalMarkers(["DONE", "BLOCKED"])).toEqual(["DONE", "BLOCKED"]);
    expect(parseFinalMarkers(["DONE:"])).toEqual(["DONE:"]);
    for (const bad of [undefined, null, "DONE", [], [""], [" DONE"], ["DONE\n"], [3], [["DONE"]]]) {
      expect(parseFinalMarkers(bad)).toBeUndefined();
    }
  });

  it("startsWithFinalMarker is a case-sensitive prefix test on the trimmed text", () => {
    expect(startsWithFinalMarker("DONE: x", MARKERS)).toBe(true);
    expect(startsWithFinalMarker("  \nBLOCKED", MARKERS)).toBe(true);
    expect(startsWithFinalMarker("done: x", MARKERS)).toBe(false);
    expect(startsWithFinalMarker("All DONE.", MARKERS)).toBe(false);
    expect(startsWithFinalMarker("**DONE**", MARKERS)).toBe(false);
  });

  it("isNarrationEnding: text, no tool call, no marker — and never without declared markers", () => {
    const text = (t: string) => classifyAssistantEnding([{ type: "text", text: t }]);
    expect(isNarrationEnding(text("Let me check:"), MARKERS)).toBe(true);
    expect(isNarrationEnding(text("DONE: checked."), MARKERS)).toBe(false);
    expect(isNarrationEnding(text("Let me check:"), undefined)).toBe(false);
    // A tool call, empty or whitespace text, a reasoning-only ending, and no
    // ending at all are not narration (each is handled as it was).
    expect(
      isNarrationEnding(
        classifyAssistantEnding([
          { type: "text", text: "Let me check:" },
          { type: "toolCall", id: "c", name: "read", arguments: {} },
        ]),
        MARKERS,
      ),
    ).toBe(false);
    expect(isNarrationEnding(text("   "), MARKERS)).toBe(false);
    expect(
      isNarrationEnding(classifyAssistantEnding([{ type: "thinking", thinking: "x" }]), MARKERS),
    ).toBe(false);
    expect(isNarrationEnding(undefined, MARKERS)).toBe(false);
  });

  it("resolveMaxNarrationReprompts rejects a non-integer or non-positive budget and caps at the ceiling", () => {
    expect(resolveMaxNarrationReprompts(undefined)).toBe(DEFAULT_MAX_NARRATION_REPROMPTS);
    expect(resolveMaxNarrationReprompts(1)).toBe(1);
    expect(resolveMaxNarrationReprompts(99)).toBe(DEFAULT_MAX_NARRATION_REPROMPTS);
    for (const bad of [Number.POSITIVE_INFINITY, Number.NaN, 0, -1, 0.5, 1.5]) {
      expect(() => resolveMaxNarrationReprompts(bad)).toThrow(/invalid maxReprompts/);
    }
  });

  it.each([
    [undefined, DEFAULT_MAX_NARRATION_REPROMPTS],
    [2, 2],
    [99, DEFAULT_MAX_NARRATION_REPROMPTS],
  ])(
    "repromptWhileNarrating stops at its bound even when the caller's classifier never stops matching (maxReprompts %p → %p sends)",
    async (maxReprompts, expected) => {
      const sent: string[] = [];
      const res = await repromptWhileNarrating({
        session: {} as RunSession,
        continuation: buildNarrationContinueTurn(MARKERS),
        narrating: () => true,
        ...(maxReprompts !== undefined ? { maxReprompts } : {}),
        send: async (text) => {
          sent.push(text);
          // A runaway loop stops here instead of spinning, so the assertion fails.
          if (sent.length > 20) throw new Error("unbounded narration loop");
        },
      });
      expect(sent).toEqual(Array(expected).fill(buildNarrationContinueTurn(MARKERS)));
      expect(res).toEqual({ reprompts: expected, endedNarrating: true });
    },
  );
});
