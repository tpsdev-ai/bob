// run-bounds.test.ts — bob#135. The pure pieces behind the one-shot run bounds:
// the bob.yaml `run:` reader, the layered limit resolution, the abort guard, the
// turn race, and the operator messages.
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
  it("reads the three keys, in seconds", () => {
    const yaml = [
      "run:",
      "  wall_clock_seconds: 1800",
      "  no_progress_seconds: 600",
      "  turn_timeout_seconds: 300",
      "",
      "provider:",
      "  name: anthropic",
      "",
    ].join("\n");
    expect(readRunLimits(yaml)).toEqual({
      wallClockSeconds: 1800,
      noProgressSeconds: 600,
      turnTimeoutSeconds: 300,
    });
  });

  it("returns {} when the block is absent", () => {
    expect(readRunLimits("provider:\n  name: anthropic\n")).toEqual({});
  });

  it("refuses an unknown key by name", () => {
    expect(() => readRunLimits("run:\n  wall_clock: 60\n")).toThrow(BobYamlError);
    expect(() => readRunLimits("run:\n  wall_clock: 60\n")).toThrow(/unknown key "wall_clock"/);
    // A turn timeout ends the run; there is no retry count to set.
    expect(() => readRunLimits("run:\n  turn_retries: 1\n")).toThrow(/unknown key "turn_retries"/);
  });

  it("refuses a value outside the accepted range", () => {
    expect(() => readRunLimits("run:\n  wall_clock_seconds: 0\n")).toThrow(
      /whole number of seconds between 1 and/,
    );
    expect(() => readRunLimits("run:\n  no_progress_seconds: -5\n")).toThrow(
      /whole number of seconds between 1 and/,
    );
  });

  it("refuses a seconds value past the runtime timer range", () => {
    // 2147484 s → 2147484000 ms, past Node's 2^31-1 timer clamp (armed as 1 ms).
    expect(() => readRunLimits("run:\n  wall_clock_seconds: 2147484\n")).toThrow(
      /seconds between 1 and 2147483/,
    );
    expect(() => readRunLimits("run:\n  turn_timeout_seconds: 2147484\n")).toThrow(
      /seconds between 1 and 2147483/,
    );
    // A whole number in YAML but past Number.MAX_SAFE_INTEGER is refused too.
    expect(() => readRunLimits("run:\n  wall_clock_seconds: 1e+21\n")).toThrow(BobYamlError);
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
    expect(resolveRunLimits({ wallClockSeconds: 90, turnTimeoutSeconds: 3 })).toMatchObject({
      wallClockMs: 90_000,
      turnTimeoutMs: 3_000,
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
      turnTimeoutMs: 60_000,
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
      turnTimeoutMs: 60_000,
    });
    try {
      bounds.fire("no_progress");
      bounds.fire("wall_clock");
      expect(bounds.reason()).toBe("no_progress");
    } finally {
      bounds.stop();
    }
  });

  it("refuses a limit past the timer range", () => {
    const base = { wallClockMs: 60_000, noProgressMs: 60_000, turnTimeoutMs: 60_000 };
    expect(() => createRunBounds({ ...base, wallClockMs: 2_147_483_648 })).toThrow(
      /at most 2147483647/,
    );
  });

  it("refuses a non-positive limit", () => {
    expect(() =>
      createRunBounds({
        wallClockMs: 0,
        noProgressMs: 60_000,
        turnTimeoutMs: 60_000,
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

    const call = boundMessage("a", "turn_timeout", DEFAULT_RUN_LIMITS);
    expect(call).toContain("TURN TIMEOUT");
    expect(call).toContain("--turn-timeout");
    expect(call).toContain("run.turn_timeout_seconds");
  });

  it("reports a sub-second bound in milliseconds, never a rounded 0s", () => {
    const msg = boundMessage("a", "wall_clock", {
      wallClockMs: 60,
      noProgressMs: 60_000,
      turnTimeoutMs: 60_000,
    });
    expect(msg).toContain("60ms");
    expect(msg).not.toContain("0s");
  });
});
