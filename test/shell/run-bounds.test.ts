// run-bounds.test.ts — bob#135. The pure pieces behind the one-shot run bounds:
// the bob.yaml `run:` reader, the layered limit resolution, the abort guard, the
// per-call race, and the operator messages.
import { describe, expect, it } from "bun:test";
import { BobYamlError, readRunLimits } from "../../src/shell/bob-yaml.js";
import {
  boundMessage,
  createRunBounds,
  DEFAULT_RUN_LIMITS,
  RunAbortedError,
  raceTimeout,
  resolveRunLimits,
  TIMED_OUT,
} from "../../src/shell/run-bounds.js";

describe("readRunLimits — the bob.yaml run: block", () => {
  it("reads the four keys, in seconds", () => {
    const yaml = [
      "run:",
      "  wall_clock_seconds: 1800",
      "  no_progress_seconds: 600",
      "  call_timeout_seconds: 300",
      "  call_retries: 2",
      "",
      "provider:",
      "  name: anthropic",
      "",
    ].join("\n");
    expect(readRunLimits(yaml)).toEqual({
      wallClockSeconds: 1800,
      noProgressSeconds: 600,
      callTimeoutSeconds: 300,
      callRetries: 2,
    });
  });

  it("returns {} when the block is absent", () => {
    expect(readRunLimits("provider:\n  name: anthropic\n")).toEqual({});
  });

  it("allows call_retries: 0", () => {
    expect(readRunLimits("run:\n  call_retries: 0\n")).toEqual({ callRetries: 0 });
  });

  it("refuses an unknown key by name", () => {
    expect(() => readRunLimits("run:\n  wall_clock: 60\n")).toThrow(BobYamlError);
    expect(() => readRunLimits("run:\n  wall_clock: 60\n")).toThrow(/unknown key "wall_clock"/);
  });

  it("refuses a non-positive or non-integer value", () => {
    expect(() => readRunLimits("run:\n  wall_clock_seconds: 0\n")).toThrow(/positive whole number/);
    expect(() => readRunLimits("run:\n  no_progress_seconds: -5\n")).toThrow(
      /positive whole number/,
    );
    expect(() => readRunLimits("run:\n  call_retries: -1\n")).toThrow(/0 or more/);
  });

  it("refuses the inline form", () => {
    expect(() => readRunLimits("run: {wall_clock_seconds: 60}")).toThrow(/inline form/);
  });
});

describe("resolveRunLimits — defaults, bob.yaml, then flags", () => {
  it("uses the defaults when nothing is set", () => {
    expect(resolveRunLimits({})).toEqual(DEFAULT_RUN_LIMITS);
  });

  it("converts the block's seconds to milliseconds", () => {
    expect(resolveRunLimits({ wallClockSeconds: 90, callRetries: 3 })).toMatchObject({
      wallClockMs: 90_000,
      callRetries: 3,
    });
  });

  it("lets a per-invocation override win over the block", () => {
    expect(resolveRunLimits({ wallClockSeconds: 90 }, { wallClockMs: 1_000 })).toMatchObject({
      wallClockMs: 1_000,
    });
  });

  it("ignores an undefined override", () => {
    expect(resolveRunLimits({}, { wallClockMs: undefined })).toEqual(DEFAULT_RUN_LIMITS);
  });
});

describe("createRunBounds — the abort guard", () => {
  it("rejects a guarded call once a bound fires", async () => {
    const bounds = createRunBounds({
      wallClockMs: 60_000,
      noProgressMs: 60_000,
      callTimeoutMs: 60_000,
      callRetries: 0,
    });
    try {
      bounds.fire("wall_clock");
      expect(bounds.reason()).toBe("wall_clock");
      await expect(bounds.guard(new Promise(() => {}))).rejects.toThrow(RunAbortedError);
    } finally {
      bounds.stop();
    }
  });

  it("keeps the first fired reason", () => {
    const bounds = createRunBounds({
      wallClockMs: 60_000,
      noProgressMs: 60_000,
      callTimeoutMs: 60_000,
      callRetries: 0,
    });
    try {
      bounds.fire("no_progress");
      bounds.fire("wall_clock");
      expect(bounds.reason()).toBe("no_progress");
    } finally {
      bounds.stop();
    }
  });

  it("refuses a non-positive limit", () => {
    expect(() =>
      createRunBounds({
        wallClockMs: 0,
        noProgressMs: 60_000,
        callTimeoutMs: 60_000,
        callRetries: 0,
      }),
    ).toThrow(/positive number/);
  });
});

describe("raceTimeout", () => {
  it("returns the value when it arrives first", async () => {
    expect(await raceTimeout(Promise.resolve(42), 1_000)).toBe(42);
  });

  it("returns the sentinel when the deadline wins", async () => {
    expect(await raceTimeout(new Promise(() => {}), 20)).toBe(TIMED_OUT);
  });
});

describe("boundMessage", () => {
  it("names the bound and how to raise it", () => {
    const wall = boundMessage("a", "wall_clock", DEFAULT_RUN_LIMITS);
    expect(wall).toContain("WALL-CLOCK TIMEOUT");
    expect(wall).toContain("--timeout");
    expect(wall).toContain("run.wall_clock_seconds");

    const progress = boundMessage("a", "no_progress", DEFAULT_RUN_LIMITS);
    expect(progress).toContain("NO-PROGRESS WATCHDOG");
    expect(progress).toContain("--no-progress-timeout");
    expect(progress).toContain("run.no_progress_seconds");

    const call = boundMessage("a", "call_timeout", DEFAULT_RUN_LIMITS);
    expect(call).toContain("PER-CALL TIMEOUT");
    expect(call).toContain("--call-timeout");
    expect(call).toContain("run.call_timeout_seconds");
  });

  it("reports a sub-second bound in milliseconds, never a rounded 0s", () => {
    const msg = boundMessage("a", "wall_clock", {
      wallClockMs: 60,
      noProgressMs: 60_000,
      callTimeoutMs: 60_000,
      callRetries: 0,
    });
    expect(msg).toContain("60ms");
    expect(msg).not.toContain("0s");
  });
});
