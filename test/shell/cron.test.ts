import { describe, expect, it } from "bun:test";
import { readCron } from "../../src/shell/bob-yaml.js";
import { startCronScheduler, type TimerHandle } from "../../src/shell/cron.js";

// Fake timers: capture scheduled callbacks so a test can fire ticks
// deterministically (no real wall-clock wait).
function fakeTimers() {
  const scheduled: Array<{ id: number; cb: () => void; ms: number }> = [];
  let nextId = 0;
  const setTimer = (cb: () => void, ms: number): TimerHandle => {
    const id = ++nextId;
    scheduled.push({ id, cb, ms });
    return id as unknown as TimerHandle;
  };
  const clearTimer = (h: TimerHandle): void => {
    const i = scheduled.findIndex((s) => s.id === (h as unknown as number));
    if (i >= 0) scheduled.splice(i, 1);
  };
  // Fire every currently-scheduled timer once, then let the serial chain settle.
  const tick = async (): Promise<void> => {
    const due = scheduled.splice(0, scheduled.length);
    for (const s of due) s.cb();
    // Flush the scheduler's promise chain (fire → catch → finally reschedule).
    await new Promise((r) => setTimeout(r, 5));
  };
  return { setTimer, clearTimer, scheduled, tick };
}

describe("startCronScheduler", () => {
  const NOW = 1_700_000_000_000; // fixed ms

  it("schedules an entry, fires it on tick, then reschedules the next run", async () => {
    const fired: string[] = [];
    const t = fakeTimers();
    const h = startCronScheduler({
      entries: [{ name: "brief", schedule: "0 9 * * *", prompt: "compose the brief" }],
      fire: async (e) => {
        fired.push(e.name);
      },
      now: () => NOW,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      log: () => {},
    });

    expect(t.scheduled).toHaveLength(1); // one pending timer for the entry
    expect(t.scheduled[0]?.ms).toBeGreaterThan(0); // some future delay

    await t.tick();
    expect(fired).toEqual(["brief"]); // fired exactly once
    expect(t.scheduled).toHaveLength(1); // and rescheduled the next run

    h.stop();
    expect(t.scheduled).toHaveLength(0); // stop cancels pending timers
  });

  it("skips an entry with an invalid cron expression (never schedules it)", () => {
    const t = fakeTimers();
    const h = startCronScheduler({
      entries: [{ name: "bad", schedule: "not a cron expr", prompt: "x" }],
      fire: async () => {
        throw new Error("must not fire a bad-schedule entry");
      },
      now: () => NOW,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      log: () => {},
    });
    expect(t.scheduled).toHaveLength(0);
    h.stop();
  });

  it("a valid entry still schedules even if a sibling has a bad schedule", () => {
    const t = fakeTimers();
    const h = startCronScheduler({
      entries: [
        { name: "bad", schedule: "@@@", prompt: "x" },
        { name: "good", schedule: "*/5 * * * *", prompt: "y" },
      ],
      fire: async () => {},
      now: () => NOW,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      log: () => {},
    });
    expect(t.scheduled).toHaveLength(1); // only the good one
    h.stop();
  });

  it("a fire error doesn't stop future runs (reschedules anyway)", async () => {
    let calls = 0;
    const t = fakeTimers();
    const h = startCronScheduler({
      entries: [{ name: "flaky", schedule: "* * * * *", prompt: "p" }],
      fire: async () => {
        calls++;
        throw new Error("transient");
      },
      now: () => NOW,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
      log: () => {},
    });
    await t.tick();
    expect(calls).toBe(1);
    expect(t.scheduled).toHaveLength(1); // rescheduled despite the throw
    h.stop();
  });
});

describe("readCron", () => {
  it("parses a block-sequence of cron maps", () => {
    const yaml = [
      "agent:",
      "  id: pulse",
      "cron:",
      "  - name: daily_intel",
      '    schedule: "0 16 * * *"',
      '    prompt: "Run the daily intel check."',
      "  - name: weekly",
      '    schedule: "0 9 * * 5"',
      '    prompt: "Weekly sweep."',
      "channels:",
      "  tps_mail:",
      "    inbox: ~/x",
    ].join("\n");
    const entries = readCron(yaml);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      name: "daily_intel",
      schedule: "0 16 * * *",
      prompt: "Run the daily intel check.",
    });
    expect(entries[1]?.name).toBe("weekly");
  });

  it("returns [] when there is no cron block", () => {
    expect(readCron("agent:\n  id: pulse\n")).toEqual([]);
  });

  it("ignores comments + blank lines inside the block", () => {
    const yaml = [
      "cron:",
      "  # a comment",
      "",
      "  - name: x",
      "    schedule: '* * * * *'",
      "    prompt: 'go'",
    ].join("\n");
    const entries = readCron(yaml);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("x");
  });
});
