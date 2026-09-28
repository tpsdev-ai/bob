import { describe, expect, it } from "bun:test";
import { createTurnAdmission } from "../../src/shell/turn-admission.js";
import { approvedOrigin, isValidOrigin, type TurnOrigin } from "../../src/shell/turn-origin.js";

const valid: TurnOrigin[] = [
  { kind: "run" },
  { kind: "mail", from: "flint" },
  { kind: "cron", job: "daily-brief" },
  { kind: "discord", channelId: "123456789" },
  { kind: "mail", from: "a".repeat(64) },
  { kind: "cron", job: "a".repeat(64) },
  { kind: "discord", channelId: "1".repeat(20) },
];
const invalid: TurnOrigin[] = [
  { kind: "mail", from: "a".repeat(300) },
  { kind: "cron", job: "a".repeat(300) },
  { kind: "discord", channelId: "1".repeat(300) },
  { kind: "discord", channelId: "1".repeat(21) },
  { kind: "mail", from: "SECRET" },
  { kind: "cron", job: "Cron-Job" },
  { kind: "mail", from: "flint the boss" },
  { kind: "mail", from: "flint:x" },
  { kind: "discord", channelId: "12abc" },
  { kind: "discord", channelId: "12-34" },
  { kind: "mail", from: "" },
  { kind: "discord", channelId: "" },
  { kind: "mail", from: "a".repeat(65) },
  { kind: "cron", job: "" },
];

describe("admission origin projection", () => {
  it.each(valid)("accepts and copies approved metadata: %j", (origin) => {
    expect(isValidOrigin(origin)).toBe(true);
    expect(approvedOrigin(origin)).toEqual(origin);
    expect(approvedOrigin(origin)).not.toBe(origin);
  });
  it.each(invalid)("rejects invalid metadata: %j", (origin) => {
    expect(isValidOrigin(origin)).toBe(false);
    expect(approvedOrigin(origin)).toEqual({ kind: "run" });
  });

  it("copies approved fields before queuing and discards extra fields", async () => {
    const admission = createTurnAdmission();
    const seen: TurnOrigin[] = [];
    admission.bind({
      subscribe: () => () => {},
      dispose() {},
      async prompt() {
        seen.push(admission.readOrigin());
      },
    });
    const input = { kind: "mail" as const, from: "flint", extra: "PROMPT_SECRET" };
    const done = admission.admitTurn(input, "prompt");
    input.from = "SECRET";
    await done;
    expect(seen).toEqual([{ kind: "mail", from: "flint" }]);
    expect(JSON.stringify(seen)).not.toContain("PROMPT_SECRET");
    expect(admission.readOrigin()).toEqual({ kind: "run" });
  });

  it("a rejected prompt releases the FIFO and cannot taint the next admission", async () => {
    const admission = createTurnAdmission();
    const seen: TurnOrigin[] = [];
    admission.bind({
      subscribe: () => () => {},
      dispose() {},
      async prompt(text) {
        if (text === "reject") throw new Error("preflight failed");
        seen.push(admission.readOrigin());
      },
    });
    const failed = admission.admitTurn({ kind: "cron", job: "stale" }, "reject");
    const next = admission.admitTurn({ kind: "run" }, "next");
    await expect(failed).rejects.toThrow("preflight failed");
    await next;
    expect(seen).toEqual([{ kind: "run" }]);
  });

  it("close cancels already queued work as well as new admissions", async () => {
    const admission = createTurnAdmission();
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const prompts: string[] = [];
    admission.bind({
      subscribe: () => () => {},
      dispose() {},
      async prompt(text) {
        prompts.push(text);
        entered();
        await barrier;
      },
    });
    const first = admission.admitTurn({ kind: "run" }, "first");
    const next = admission.admitTurn({ kind: "cron", job: "queued" }, "next");
    await started;
    admission.close();
    release();
    await first;
    await expect(next).rejects.toThrow("admission is closed");
    await expect(admission.admitTurn({ kind: "run" }, "late")).rejects.toThrow(
      "admission is closed",
    );
    await admission.drain();
    expect(prompts).toEqual(["first"]);
  });
});
