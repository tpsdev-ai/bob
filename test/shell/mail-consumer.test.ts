// The tps-mail inbox consumer (bob#200). Temp maildirs, throwaway keys, and
// injected turn/reply seams — or a fake launcher script where the real spawn
// path is the thing under test. Never real mail, never the real tps.
//
// ACCEPTANCE (each shown RED without its control in the PR's mutation record):
//   (a2) a sender outside the allow-list lands in refused/ and never reaches a session
//   (a4) kill the runtime mid-turn: re-delivered, exactly one reply
//   (a5) kill it after the reply and before the ack: no second reply (marker)
//   (a6) a tool-only turn sends no reply
//   (a7) a turn past the timeout is killed and stays in new/
//   (a8) the lock is not taken from a live pid
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MailTurnInput } from "../../src/capabilities/tps-mail/prompt.js";
import type { ReplyRequest, ReplyResult } from "../../src/capabilities/tps-mail/reply.js";
import {
  type DurableIo,
  durableWrite,
  launcherTurnRunner,
  MailConsumer,
  type MailConsumerOptions,
  type TurnOutcome,
} from "../../src/shell/mail-consumer.js";
import {
  keyResolver,
  mailRecord,
  signTestEnvelope,
  type TestKey,
  testKey,
  writeRecord,
} from "../capabilities/tps-mail/helpers.js";

let root: string;
let inbox: string;
let lockFile: string;
let statsFile: string;
let flint: TestKey;
let mallory: TestKey;
let clock: number;
const children: ChildProcess[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-mail-"));
  inbox = join(root, "inbox");
  lockFile = join(root, "lock", "testbot.lock");
  statsFile = join(root, "stats.json");
  flint = testKey();
  mallory = testKey();
  clock = 1_000_000;
});

afterEach(() => {
  for (const c of children.splice(0)) c.kill("SIGKILL");
  rmSync(root, { recursive: true, force: true });
});

// A signed mail from `from` (key `key`) to testbot, written into new/.
function deliver(
  file: string,
  opts: { from?: string; key?: TestKey; body?: string; messageId?: string; record?: object } = {},
): string {
  const from = opts.from ?? "flint";
  const env = signTestEnvelope(
    {
      from,
      to: "testbot",
      body: opts.body ?? "SMOKE: reply SMOKE-OK",
      messageId: opts.messageId ?? `id-${file}`,
    },
    opts.key ?? flint,
  );
  return writeRecord(inbox, file, { ...mailRecord(env), ...(opts.record ?? {}) });
}

interface Harness {
  consumer: MailConsumer;
  turns: MailTurnInput[];
  replies: ReplyRequest[];
  logs: string[];
}

function harness(
  overrides: Partial<MailConsumerOptions> & {
    turn?: (input: MailTurnInput, signal: AbortSignal) => Promise<TurnOutcome>;
    reply?: (r: ReplyRequest) => Promise<ReplyResult>;
  } = {},
): Harness {
  const turns: MailTurnInput[] = [];
  const replies: ReplyRequest[] = [];
  const logs: string[] = [];
  const { turn, reply, ...rest } = overrides;
  const consumer = new MailConsumer({
    name: "testbot",
    identity: "testbot",
    inboxRoot: inbox,
    senders: ["flint"],
    resolveKey: keyResolver({ flint, mallory }),
    lockFile,
    statsFile,
    pollIntervalMs: 60_000,
    now: () => clock,
    log: (m) => logs.push(m),
    runTurn: async (input, signal) => {
      turns.push(input);
      return turn ? turn(input, signal) : { kind: "final", text: "SMOKE-OK" };
    },
    sendReply: async (r) => {
      replies.push(r);
      return reply ? reply(r) : { ok: true };
    },
    ...rest,
  });
  return { consumer, turns, replies, logs };
}

const inDir = (dir: string) =>
  existsSync(join(inbox, dir))
    ? readdirSync(join(inbox, dir)).filter((f) => f.endsWith(".json"))
    : [];

// A pid that is certainly dead: a child that already exited.
async function deadPid(): Promise<number> {
  const c = spawn("true");
  await new Promise((r) => c.on("exit", r));
  if (c.pid === undefined) throw new Error("no pid");
  return c.pid;
}

describe("accepting mail (§2)", () => {
  it("(a2) a validly signed sender outside the allow-list → refused/, never a turn, never a reply", async () => {
    deliver("1.json", { from: "mallory", key: mallory });
    const h = harness();
    await h.consumer.poll();
    expect(h.turns).toHaveLength(0);
    expect(h.replies).toHaveLength(0);
    expect(inDir("refused")).toEqual(["1.json"]);
    expect(inDir("new")).toEqual([]);
    expect(inDir("cur")).toEqual([]);
    expect(readFileSync(join(inbox, "refused", "1.json.reason"), "utf8")).toMatch(
      /^reason: sender-not-allowed/,
    );
    expect(h.consumer.stats.refused["sender-not-allowed"]).toBe(1);
  });

  it("an inner/outer from mismatch → refused/ (from-mismatch), never a turn", async () => {
    deliver("1.json", { record: { from: "flint-impostor" } });
    const h = harness();
    await h.consumer.poll();
    expect(h.turns).toHaveLength(0);
    expect(inDir("refused")).toEqual(["1.json"]);
    expect(h.consumer.stats.refused["from-mismatch"]).toBe(1);
  });

  it("unsigned mail and a bad signature are refused and counted per reason", async () => {
    writeRecord(inbox, "1.json", mailRecord("plain text body", { from: "flint" }));
    deliver("2.json", { key: mallory }); // signed as flint with the wrong key
    writeFileSync(join(inbox, "new", "3.json"), "{not json");
    const h = harness();
    await h.consumer.poll();
    expect(h.turns).toHaveLength(0);
    expect(h.consumer.stats.refused).toMatchObject({
      unsigned: 1,
      "bad-signature": 1,
      malformed: 1,
    });
    expect(inDir("refused").sort()).toEqual(["1.json", "2.json", "3.json"]);
  });

  it("a record that cannot be canonicalized (1e400 → Infinity) is REFUSED, not retried forever", async () => {
    const env = signTestEnvelope(
      { from: "flint", to: "testbot", body: "x", messageId: "m-inf" },
      flint,
    );
    writeRecord(
      inbox,
      "1.json",
      mailRecord(JSON.stringify(env).replace(/}$/, ',"n":1e400}'), { from: "flint" }),
    );
    const h = harness();
    await h.consumer.poll();
    expect(inDir("refused")).toEqual(["1.json"]);
    expect(inDir("new")).toEqual([]);
    expect(readFileSync(join(inbox, "refused", "1.json.reason"), "utf8")).toMatch(
      /^reason: malformed\n.*cannot be canonicalized/,
    );
    expect(h.consumer.stats.refused.malformed).toBe(1);
    expect(h.consumer.stats.verifyUnavailable).toBe(0);
    expect(h.turns).toHaveLength(0);
  });

  it("a key lookup Flair cannot answer leaves the mail in new/ (a retry, never a refusal)", async () => {
    deliver("1.json");
    const h = harness({
      resolveKey: async () => {
        throw new Error("Flair unreachable");
      },
    });
    await h.consumer.poll();
    expect(inDir("new")).toEqual(["1.json"]);
    expect(inDir("refused")).toEqual([]);
    expect(h.consumer.stats.verifyUnavailable).toBe(1);
    expect(h.turns).toHaveLength(0);
  });

  it("refuses to construct with an empty allow-list or an invalid identity", () => {
    const base = {
      name: "testbot",
      identity: "testbot",
      inboxRoot: inbox,
      resolveKey: keyResolver({}),
    };
    expect(() => new MailConsumer({ ...base, senders: [] })).toThrow(/empty senders/);
    expect(() => new MailConsumer({ ...base, senders: ["fl*"] })).toThrow(/exact TPS id/);
    expect(() => new MailConsumer({ ...base, senders: ["flint"], identity: "-x" })).toThrow();
    expect(() => new MailConsumer({ ...base, senders: ["flint"], name: "../etc" })).toThrow(
      /invalid agent name/,
    );
  });

  it("rejects an agent name beyond the shared origin limit (bob#147 ORIGIN_FIELD_LIMITS.mailFrom)", () => {
    expect(
      () =>
        new MailConsumer({
          name: "a".repeat(65),
          identity: "testbot",
          inboxRoot: inbox,
          senders: ["flint"],
          resolveKey: keyResolver({}),
        }),
    ).toThrow(/64 characters/);
  });
});

describe("one turn per accepted mail, and the reply (§1, §5)", () => {
  it("runs one turn with the VERIFIED fields and replies to the verified sender, threaded", async () => {
    deliver("1.json", { body: "hello bob", messageId: "m-1" });
    const h = harness();
    await h.consumer.poll();
    expect(h.turns).toEqual([{ sender: "flint", messageId: "m-1", body: "hello bob" }]);
    expect(h.replies).toEqual([{ to: "flint", inReplyTo: "m-1", body: "SMOKE-OK" }]);
    expect(inDir("cur")).toEqual(["1.json"]);
    const marker = JSON.parse(readFileSync(join(inbox, "replied", "m-1"), "utf8"));
    expect(marker).toMatchObject({ inboundId: "m-1", outcome: "replied", to: "flint" });
    expect(h.consumer.stats).toMatchObject({ processed: 1, replied: 1 });
    expect(h.logs.join("\n")).toContain("replied to flint (in reply to m-1");
  });

  it("processes new/ oldest first by filename, whatever order the directory lists", async () => {
    for (const f of [
      "2026-09-28T12-00-03.json",
      "2026-09-28T12-00-01.json",
      "2026-09-28T12-00-02.json",
    ]) {
      deliver(f, { messageId: `m-${f.slice(17, 19)}` });
    }
    const h = harness();
    await h.consumer.poll();
    expect(h.turns.map((t) => t.messageId)).toEqual(["m-01", "m-02", "m-03"]);
  });

  it("caps the reply at maxReplyChars", async () => {
    deliver("1.json");
    const h = harness({
      maxReplyChars: 20,
      turn: async () => ({ kind: "final", text: "y".repeat(100) }),
    });
    await h.consumer.poll();
    expect(h.replies[0]?.body).toBe(`${"y".repeat(19)}…`);
  });

  it("(a6) a tool-only turn (settled, no final message) sends NO reply and is acked", async () => {
    deliver("1.json", { messageId: "m-1" });
    const h = harness({ turn: async () => ({ kind: "silent" }) });
    await h.consumer.poll();
    expect(h.turns).toHaveLength(1);
    expect(h.replies).toHaveLength(0);
    expect(inDir("cur")).toEqual(["1.json"]);
    expect(JSON.parse(readFileSync(join(inbox, "replied", "m-1"), "utf8")).outcome).toBe(
      "no-reply",
    );
    expect(h.consumer.stats.noReply).toBe(1);
  });

  it("a FAILED turn sends no reply, stays in new/, and is retried only after its backoff", async () => {
    deliver("1.json");
    let fail = true;
    const h = harness({
      retryBaseMs: 1000,
      turn: async () =>
        fail
          ? { kind: "failed", reason: "exit", detail: "provider 429" }
          : { kind: "final", text: "ok" },
    });
    await h.consumer.poll();
    expect(h.replies).toHaveLength(0);
    expect(inDir("new")).toEqual(["1.json"]);
    expect(h.consumer.stats.dispatchFailed).toBe(1);
    await h.consumer.poll(); // no hot loop: the backoff has not passed
    expect(h.turns).toHaveLength(1);
    clock += 1001;
    fail = false;
    await h.consumer.poll();
    expect(h.turns).toHaveLength(2);
    expect(h.replies).toHaveLength(1);
    expect(inDir("cur")).toEqual(["1.json"]);
  });

  it("a failed SEND is counted, stays in new/, and the retry resends without a second turn", async () => {
    deliver("1.json", { messageId: "m-1" });
    let sendOk = false;
    const h = harness({
      retryBaseMs: 1000,
      reply: async () =>
        sendOk ? { ok: true } : { ok: false, reason: "cli-missing", detail: "tps not found" },
    });
    await h.consumer.poll();
    expect(h.consumer.stats.replyFailed["cli-missing"]).toBe(1);
    expect(inDir("new")).toEqual(["1.json"]);
    expect(existsSync(join(inbox, "replied", "m-1"))).toBe(false);
    expect(h.logs.join("\n")).toMatch(/reply to flint for m-1 FAILED \(cli-missing/);
    clock += 1001;
    sendOk = true;
    await h.consumer.poll();
    expect(h.turns).toHaveLength(1);
    expect(h.replies).toHaveLength(2);
    expect(h.replies[1]).toEqual(h.replies[0]);
    expect(inDir("cur")).toEqual(["1.json"]);
  });

  it("persists its stats for bob doctor", async () => {
    deliver("1.json", { from: "mallory", key: mallory });
    const h = harness();
    await h.consumer.poll();
    const stats = JSON.parse(readFileSync(statsFile, "utf8"));
    expect(stats).toMatchObject({ agent: "testbot", identity: "testbot" });
    expect(stats.refused["sender-not-allowed"]).toBe(1);
  });
});

describe("crash semantics: post-before-ack (§5, Kern 5)", () => {
  it("(a4) kill the runtime mid-turn: the mail is re-delivered and answered exactly once", async () => {
    deliver("1.json", { messageId: "m-1" });
    const replies: ReplyRequest[] = [];
    // Runtime #1: the turn is cut before it ends.
    let turnStarted!: () => void;
    const started = new Promise<void>((r) => {
      turnStarted = r;
    });
    const first = harness({
      turn: () => {
        turnStarted();
        return new Promise<TurnOutcome>(() => {}); // never ends on its own
      },
      reply: async (r) => {
        replies.push(r);
        return { ok: true };
      },
    });
    first.consumer.start();
    const polling = first.consumer.poll();
    await started;
    await first.consumer.stop();
    await polling;
    expect(inDir("new")).toEqual(["1.json"]);
    expect(existsSync(join(inbox, "replied", "m-1"))).toBe(false);
    // The kill left its lock behind, naming a pid that no longer exists.
    mkdirSync(join(root, "lock"), { recursive: true });
    writeFileSync(lockFile, String(await deadPid()));

    // Runtime #2 re-delivers it.
    const second = harness({
      reply: async (r) => {
        replies.push(r);
        return { ok: true };
      },
    });
    second.consumer.start();
    await second.consumer.poll();
    await second.consumer.stop();
    expect(second.turns).toHaveLength(1);
    expect(replies).toHaveLength(1);
    expect(inDir("cur")).toEqual(["1.json"]);
  });

  it("(a5) kill after the reply and before the ack: the marker stops a second reply", async () => {
    deliver("1.json", { messageId: "m-1" });
    // Runtime #1 sends, writes the marker, and dies before the ack lands:
    // cur/ is not a directory, so the ack fails exactly where a crash would.
    mkdirSync(inbox, { recursive: true });
    writeFileSync(join(inbox, "cur"), "not a directory");
    const first = harness();
    await first.consumer.poll();
    expect(first.replies).toHaveLength(1);
    expect(inDir("new")).toEqual(["1.json"]);
    expect(existsSync(join(inbox, "replied", "m-1"))).toBe(true);

    // Runtime #2: acks without a turn and without replying again.
    rmSync(join(inbox, "cur"));
    mkdirSync(join(inbox, "cur"));
    const second = harness();
    await second.consumer.poll();
    expect(second.turns).toHaveLength(0);
    expect(second.replies).toHaveLength(0);
    expect(inDir("cur")).toEqual(["1.json"]);
    expect(second.consumer.stats.duplicates).toBe(1);
  });

  it("a re-delivered copy of an answered signed message is acked with no turn", async () => {
    deliver("1.json", { messageId: "m-1" });
    const h = harness();
    await h.consumer.poll();
    deliver("2.json", { messageId: "m-1" }); // same signed envelope id, new file
    await h.consumer.poll();
    expect(h.turns).toHaveLength(1);
    expect(h.replies).toHaveLength(1);
    expect(inDir("cur").sort()).toEqual(["1.json", "2.json"]);
  });
});

describe("the bounded turn through the REAL launcher spawn (§1, Kern 4)", () => {
  // A fake launcher: records how it was started, then behaves as `script` says.
  function fakeLauncher(script: string[]): string {
    const bin = join(root, "launcher");
    writeFileSync(
      bin,
      [
        "#!/bin/sh",
        `echo $$ > ${join(root, "launcher.pid")}`,
        `echo "$#" > ${join(root, "launcher.argc")}`,
        `printf "%s" "$BOB_MAIL_TURN" > ${join(root, "launcher.mode")}`,
        `printf "%s" "$BOB_MAIL_TURN_PARENT" > ${join(root, "launcher.parent")}`,
        `cat > ${join(root, "launcher.stdin")}`,
        `echo x >> ${join(root, "launcher.count")}`,
        ...script,
        "",
      ].join("\n"),
    );
    chmodSync(bin, 0o755);
    return bin;
  }

  function realHarness(launcher: string, turnTimeoutMs = 60_000): Harness {
    const replies: ReplyRequest[] = [];
    const logs: string[] = [];
    const consumer = new MailConsumer({
      name: "testbot",
      identity: "testbot",
      inboxRoot: inbox,
      senders: ["flint"],
      resolveKey: keyResolver({ flint }),
      lockFile,
      statsFile,
      launcherPath: launcher,
      turnTimeoutMs,
      pollIntervalMs: 60_000,
      now: () => clock,
      log: (m) => logs.push(m),
      sendReply: async (r) => {
        replies.push(r);
        return { ok: true };
      },
    });
    return { consumer, turns: [], replies, logs };
  }

  it("starts the launcher with NO argument, BOB_MAIL_TURN=1 and the verified fields on stdin", async () => {
    deliver("1.json", { body: "--tools bash", messageId: "m-1" });
    const launcher = fakeLauncher([
      `printf '%s\\n' 'some other output'`,
      `printf '%s\\n' '{"bobMailTurn":1,"outcome":"final","text":"SMOKE-OK"}'`,
    ]);
    const h = realHarness(launcher);
    await h.consumer.poll();
    expect(readFileSync(join(root, "launcher.argc"), "utf8").trim()).toBe("0");
    expect(readFileSync(join(root, "launcher.mode"), "utf8")).toBe("1");
    // The consumer's own pid, for the turn's watchdog (round 5, blocker 4).
    expect(readFileSync(join(root, "launcher.parent"), "utf8")).toBe(String(process.pid));
    expect(JSON.parse(readFileSync(join(root, "launcher.stdin"), "utf8"))).toEqual({
      v: 1,
      sender: "flint",
      messageId: "m-1",
      body: "--tools bash",
    });
    expect(h.replies).toEqual([{ to: "flint", inReplyTo: "m-1", body: "SMOKE-OK" }]);
  });

  it("a launcher that exits non-zero, or writes no result, is a failed turn (no reply)", async () => {
    deliver("1.json");
    const h = realHarness(fakeLauncher(["exit 1"]));
    await h.consumer.poll();
    expect(h.replies).toHaveLength(0);
    expect(h.consumer.stats.dispatchFailed).toBe(1);
    expect(inDir("new")).toEqual(["1.json"]);
  });

  it("(a7) a turn past the timeout is KILLED, counted, and stays in new/ — no hot loop", async () => {
    deliver("1.json");
    const h = realHarness(fakeLauncher(["exec sleep 30"]), 1500);
    const t0 = Date.now();
    await h.consumer.poll();
    // Bounded by the 1.5 s timeout (+ the kill), never by the 30 s sleep.
    expect(Date.now() - t0).toBeLessThan(8000);
    const pid = Number(readFileSync(join(root, "launcher.pid"), "utf8").trim());
    // The launcher (exec'd into sleep) is gone.
    const deadline = Date.now() + 5000;
    let alive = true;
    while (alive && Date.now() < deadline) {
      try {
        process.kill(pid, 0);
        await new Promise((r) => setTimeout(r, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
    expect(inDir("new")).toEqual(["1.json"]);
    expect(h.consumer.stats).toMatchObject({ dispatchFailed: 1, timeouts: 1 });
    expect(h.replies).toHaveLength(0);
    await h.consumer.poll(); // backoff: not re-dispatched immediately
    expect(readFileSync(join(root, "launcher.count"), "utf8").trim().split("\n")).toHaveLength(1);
  }, 15_000);

  it("(a7g) the timeout kills the launcher's WHOLE process group — a grandchild dies too", async () => {
    deliver("1.json");
    const grandchildPidFile = join(root, "grandchild.pid");
    const h = realHarness(
      fakeLauncher(["sleep 60 &", `echo $! > ${grandchildPidFile}`, "exec sleep 30"]),
      800,
    );
    await h.consumer.poll();
    const grandchild = Number(readFileSync(grandchildPidFile, "utf8").trim());
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    try {
      const deadline = Date.now() + 8000;
      while (alive(grandchild) && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 50));
      expect(alive(grandchild)).toBe(false);
      expect(h.consumer.stats.timeouts).toBe(1);
    } finally {
      if (alive(grandchild)) process.kill(grandchild, "SIGKILL"); // only a pid this test started
    }
  }, 20_000);
});

describe("the consumer lock (§6, Kern 2)", () => {
  it("(a8) is NOT taken from a live pid, however old the lock is", async () => {
    const holder = spawn("sleep", ["30"]);
    children.push(holder);
    mkdirSync(join(root, "lock"), { recursive: true });
    writeFileSync(lockFile, String(holder.pid));
    const tenMinutesAgo = new Date(Date.now() - 10 * 60_000);
    utimesSync(lockFile, tenMinutesAgo, tenMinutesAgo);
    const h = harness();
    expect(() => h.consumer.start()).toThrow(/already running \(pid \d+/);
    expect(readFileSync(lockFile, "utf8")).toBe(String(holder.pid));
  });

  it("IS taken over from a dead pid", async () => {
    mkdirSync(join(root, "lock"), { recursive: true });
    writeFileSync(lockFile, String(await deadPid()));
    const h = harness();
    h.consumer.start();
    expect(readFileSync(lockFile, "utf8")).toBe(String(process.pid));
    await h.consumer.stop();
    expect(existsSync(lockFile)).toBe(false);
  });

  it("refuses a lock that does not name a pid (its holder cannot be shown dead)", () => {
    mkdirSync(join(root, "lock"), { recursive: true });
    writeFileSync(lockFile, "123garbage");
    expect(() => harness().consumer.start()).toThrow(/does not name a pid/);
  });

  it("a second consumer in a live process is refused", async () => {
    const one = harness();
    one.consumer.start();
    expect(() => harness().consumer.start()).toThrow(/already running/);
    await one.consumer.stop();
  });
});

// ─── Gauge round 4 ──────────────────────────────────────────────────────────

describe("blocker 2 — the replied/ marker is DURABLE and comes before the ack", () => {
  it("(m1) a marker-write failure: sent once, NOT acked, NOT counted; the retry writes the marker WITHOUT resending", async () => {
    deliver("1.json", { messageId: "m-1" });
    let failMarker = true;
    const h = harness({
      retryBaseMs: 1000,
      writeMarkerFile: (path, content) => {
        if (failMarker) throw new Error("ENOSPC: no space left on device");
        durableWrite(path, content);
      },
    });
    await h.consumer.poll();
    expect(h.replies).toHaveLength(1);
    expect(inDir("new")).toEqual(["1.json"]);
    expect(inDir("cur")).toEqual([]);
    expect(existsSync(join(inbox, "replied", "m-1"))).toBe(false);
    expect(h.consumer.stats).toMatchObject({ processed: 0, replied: 0, markerFailed: 1 });
    expect(h.logs.join("\n")).toMatch(
      /could not durably write the replied\/ marker for m-1.*NOT acked/,
    );
    await h.consumer.poll(); // backoff: nothing yet
    expect(inDir("new")).toEqual(["1.json"]);
    clock += 1001;
    failMarker = false;
    await h.consumer.poll();
    expect(h.turns).toHaveLength(1); // no second turn
    expect(h.replies).toHaveLength(1); // no second send
    expect(existsSync(join(inbox, "replied", "m-1"))).toBe(true);
    expect(inDir("cur")).toEqual(["1.json"]);
    expect(h.consumer.stats).toMatchObject({ processed: 1, replied: 1, markerFailed: 1 });
  });

  it("(m2) a restart before the marker lands resends — threaded to the SAME messageId (the stated duplicate)", async () => {
    deliver("1.json", { messageId: "m-1" });
    const first = harness({
      writeMarkerFile: () => {
        throw new Error("EIO");
      },
    });
    await first.consumer.poll();
    expect(first.replies).toEqual([{ to: "flint", inReplyTo: "m-1", body: "SMOKE-OK" }]);
    expect(inDir("new")).toEqual(["1.json"]);
    const second = harness(); // a new runtime: the in-memory note is gone
    await second.consumer.poll();
    expect(second.replies).toEqual([{ to: "flint", inReplyTo: "m-1", body: "SMOKE-OK" }]);
    expect(inDir("cur")).toEqual(["1.json"]);
  });

  it("(m3) a silent turn whose marker fails is not acked, and its retry runs no second turn", async () => {
    deliver("1.json", { messageId: "m-1" });
    let failMarker = true;
    const h = harness({
      retryBaseMs: 1000,
      turn: async () => ({ kind: "silent" }),
      writeMarkerFile: (path, content) => {
        if (failMarker) throw new Error("EIO");
        durableWrite(path, content);
      },
    });
    await h.consumer.poll();
    expect(inDir("new")).toEqual(["1.json"]);
    expect(h.consumer.stats).toMatchObject({ processed: 0, noReply: 0, markerFailed: 1 });
    clock += 1001;
    failMarker = false;
    await h.consumer.poll();
    expect(h.turns).toHaveLength(1);
    expect(h.replies).toHaveLength(0);
    expect(inDir("cur")).toEqual(["1.json"]);
    expect(h.consumer.stats).toMatchObject({ processed: 1, noReply: 1 });
  });

  it("durableWrite writes the whole file and leaves no temp file; a failed write leaves none either", () => {
    const dir = join(root, "d");
    mkdirSync(dir);
    durableWrite(join(dir, "m"), "hello\n");
    expect(readFileSync(join(dir, "m"), "utf8")).toBe("hello\n");
    expect(readdirSync(dir)).toEqual(["m"]);
    mkdirSync(join(dir, "occupied"));
    writeFileSync(join(dir, "occupied", "x"), "");
    expect(() => durableWrite(join(dir, "occupied"), "nope")).toThrow();
    expect(readdirSync(dir).sort()).toEqual(["m", "occupied"]);
  });
});

describe("blocker 3 — a dead lock is taken over by EXACTLY one of racing restarts", () => {
  const consumerModule = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
    "src",
    "shell",
    "mail-consumer.ts",
  );

  // One racer: waits for `go`, then starts a consumer on the shared lock. The
  // hook holds every racer just after it judged the holder dead, so all of them
  // have decided "dead" before any takes the lock — the window a racy takeover
  // loses in. A holder keeps its lock until `stop` appears.
  function racerScript(): string {
    const file = join(root, "racer.ts");
    writeFileSync(
      file,
      [
        `import { appendFileSync, existsSync } from "node:fs";`,
        `import { MailConsumer } from ${JSON.stringify(consumerModule)};`,
        `const [lockFile, inboxRoot, go, stop, out, statsFile, ready] = process.argv.slice(2);`,
        `const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);`,
        `appendFileSync(ready, \`READY \${process.pid}\\n\`);`,
        `while (!existsSync(go)) nap(1);`,
        `const c = new MailConsumer({ name: "testbot", identity: "testbot", inboxRoot, senders: ["flint"],`,
        `  resolveKey: async () => null, lockFile, statsFile, pollIntervalMs: 3_600_000, log: () => {},`,
        `  lockHooks: { afterStaleCheck: () => nap(150) }, lockWaitMs: 10_000 });`,
        `try {`,
        `  c.start();`,
        `  appendFileSync(out, \`HOLD \${process.pid}\\n\`);`,
        `  while (!existsSync(stop)) nap(5);`,
        `  await c.stop();`,
        `} catch (err) {`,
        `  appendFileSync(out, \`REFUSED \${process.pid} \${(err as Error).message.slice(0, 80)}\\n\`);`,
        `}`,
        `process.exit(0);`,
        "",
      ].join("\n"),
    );
    return file;
  }

  it("(l1) six processes racing one dead lock end with exactly one holder — three rounds", async () => {
    const script = racerScript();
    for (let round = 0; round < 3; round++) {
      const dir = join(root, `round-${round}`);
      mkdirSync(dir, { recursive: true });
      const lockFile = join(dir, "testbot.lock");
      writeFileSync(lockFile, String(await deadPid()));
      const go = join(dir, "go");
      const stop = join(dir, "stop");
      const out = join(dir, "out");
      const ready = join(dir, "ready");
      writeFileSync(out, "");
      writeFileSync(ready, "");
      const racers: ChildProcess[] = [];
      for (let i = 0; i < 6; i++) {
        const c = spawn(
          process.execPath,
          [
            script,
            lockFile,
            join(dir, "inbox"),
            go,
            stop,
            out,
            join(dir, `stats-${i}.json`),
            ready,
          ],
          { stdio: "ignore" },
        );
        racers.push(c);
        children.push(c);
      }
      // A readiness barrier, not a sleep: `go` only after all six are loaded
      // and spinning on it.
      const readyBy = Date.now() + 20_000;
      while (readFileSync(ready, "utf8").split("\n").filter(Boolean).length < 6) {
        if (Date.now() > readyBy) throw new Error("racers never became ready");
        await new Promise((r) => setTimeout(r, 10));
      }
      writeFileSync(go, "");
      const deadline = Date.now() + 20_000;
      let lines: string[] = [];
      while (Date.now() < deadline) {
        lines = readFileSync(out, "utf8").split("\n").filter(Boolean);
        if (lines.length === 6) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      const holders = lines.filter((l) => l.startsWith("HOLD "));
      const refused = lines.filter((l) => l.startsWith("REFUSED "));
      expect(lines).toHaveLength(6);
      expect(holders).toHaveLength(1);
      expect(refused.every((l) => l.includes("already running"))).toBe(true);
      expect(readFileSync(lockFile, "utf8").trim()).toBe(holders[0].split(" ")[1]);
      expect(readdirSync(dir).filter((f) => f.includes(".takeover-"))).toEqual([]);
      writeFileSync(stop, "");
      await Promise.all(
        racers.map((c) => new Promise((r) => (c.exitCode !== null ? r(0) : c.on("exit", r)))),
      );
    }
  }, 60_000);

  it("(l2) a takeover claim left by a DEAD claimant fails closed, naming the file", async () => {
    mkdirSync(join(root, "lock"), { recursive: true });
    const dead = await deadPid();
    writeFileSync(lockFile, String(dead));
    writeFileSync(`${lockFile}.takeover-${dead}`, String(await deadPid()));
    expect(() => harness().consumer.start()).toThrow(/was interrupted, leaving .*takeover-/);
    expect(readFileSync(lockFile, "utf8")).toBe(String(dead)); // untouched
  });

  it("(l3) a claim held by a LIVE claimant is waited on, never broken", async () => {
    mkdirSync(join(root, "lock"), { recursive: true });
    const dead = await deadPid();
    writeFileSync(lockFile, String(dead));
    const claimant = spawn("sleep", ["30"]);
    children.push(claimant);
    writeFileSync(`${lockFile}.takeover-${dead}`, String(claimant.pid));
    expect(() => harness({ lockWaitMs: 200 }).consumer.start()).toThrow(
      new RegExp(`pid ${claimant.pid} has held the takeover claim .*takeover-${dead} for 200ms`),
    );
    expect(readFileSync(lockFile, "utf8")).toBe(String(dead));
  });
});

// ─── Gauge round 5 ──────────────────────────────────────────────────────────

// Real file operations, with a chosen failure injected.
function ioWith(over: Partial<DurableIo>): DurableIo {
  const real: DurableIo = {
    openSync: (p, f, m) => openSync(p, f, m),
    writeSync: (fd, b, o, l) => writeSync(fd, b, o, l),
    fsyncSync: (fd) => fsyncSync(fd),
    closeSync: (fd) => closeSync(fd),
    renameSync: (a, b) => renameSync(a, b),
    unlinkSync: (p) => unlinkSync(p),
  };
  return { ...real, ...over };
}

// fsync fails on the DIRECTORY fd only (the one opened with "r").
function dirSyncFails(code: string): DurableIo {
  const dirFds = new Set<number>();
  return ioWith({
    openSync: (p, f, m) => {
      const fd = openSync(p, f, m);
      if (f === "r") dirFds.add(fd);
      return fd;
    },
    fsyncSync: (fd) => {
      if (dirFds.has(fd)) throw Object.assign(new Error(`${code}: fsync on a directory`), { code });
      fsyncSync(fd);
    },
  });
}

describe("round 5, blocker 1 — no ack unless the marker's directory is synced", () => {
  it("(d1) a failed directory fsync FAILS the write and takes the marker back", () => {
    const dir = join(root, "d");
    mkdirSync(dir);
    expect(() => durableWrite(join(dir, "m"), "x\n", dirSyncFails("EIO"))).toThrow(/EIO/);
    expect(readdirSync(dir)).toEqual([]); // no marker, no temp
  });

  it("(d2) a filesystem that cannot fsync a directory gets an explicit operational error", () => {
    const dir = join(root, "d");
    mkdirSync(dir);
    for (const code of ["EINVAL", "ENOTSUP"]) {
      expect(() => durableWrite(join(dir, "m"), "x\n", dirSyncFails(code))).toThrow(
        /cannot fsync a directory .*cannot be made durable there and mail is not acked/,
      );
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it("(d3) a write that makes no progress throws instead of spinning", () => {
    const dir = join(root, "d");
    mkdirSync(dir);
    let calls = 0;
    const io = ioWith({
      writeSync: () => {
        calls += 1;
        if (calls > 1000) throw new Error("SPIN: the write loop never gave up");
        return 0;
      },
    });
    expect(() => durableWrite(join(dir, "m"), "x\n", io)).toThrow(
      /made no progress \(0\/2 bytes\)/,
    );
    expect(readdirSync(dir)).toEqual([]);
  });

  it("(d4) the consumer does NOT ack on an unsynced directory, and the retry marks without resending", async () => {
    deliver("1.json", { messageId: "m-1" });
    let broken = true;
    const h = harness({
      retryBaseMs: 1000,
      writeMarkerFile: (p, c) => durableWrite(p, c, broken ? dirSyncFails("EINVAL") : undefined),
    });
    await h.consumer.poll();
    expect(h.replies).toHaveLength(1);
    expect(inDir("new")).toEqual(["1.json"]);
    expect(existsSync(join(inbox, "replied", "m-1"))).toBe(false);
    expect(h.consumer.stats).toMatchObject({ processed: 0, replied: 0, markerFailed: 1 });
    expect(h.logs.join("\n")).toMatch(/cannot fsync a directory/);
    clock += 1001;
    broken = false;
    await h.consumer.poll();
    expect(h.replies).toHaveLength(1);
    expect(inDir("cur")).toEqual(["1.json"]);
    expect(h.consumer.stats).toMatchObject({ processed: 1, replied: 1 });
  });
});

describe("round 5, blocker 2 — per-id state is bound to the sender and the signed envelope", () => {
  let kern: TestKey;
  beforeEach(() => {
    kern = testKey();
  });
  const two = (overrides: Partial<MailConsumerOptions> & Parameters<typeof harness>[0] = {}) =>
    harness({
      senders: ["flint", "kern"],
      resolveKey: keyResolver({ flint, mallory, kern }),
      ...overrides,
    });

  it("(c1) a DIFFERENT envelope reusing an answered messageId is refused as an id collision", async () => {
    deliver("1.json", { messageId: "m-1", body: "first" });
    deliver("2.json", { messageId: "m-1", body: "second, a different envelope" });
    const h = two();
    await h.consumer.poll();
    expect(h.turns).toEqual([{ sender: "flint", messageId: "m-1", body: "first" }]);
    expect(h.replies).toHaveLength(1);
    expect(inDir("cur")).toEqual(["1.json"]);
    expect(inDir("refused")).toEqual(["2.json"]);
    expect(readFileSync(join(inbox, "refused", "2.json.reason"), "utf8")).toMatch(
      /^reason: id-collision\n.*already bound to a different signed envelope/,
    );
    expect(h.consumer.stats.refused["id-collision"]).toBe(1);
    expect(h.consumer.stats.duplicates).toBe(0);
  });

  it("(c2) in the marker-failure window, another envelope with the id is refused — never settled on the first one's behalf", async () => {
    deliver("1.json", { messageId: "m-1", body: "first" });
    let failMarker = true;
    const h = two({
      retryBaseMs: 1000,
      writeMarkerFile: (p, c) => {
        if (failMarker) throw new Error("EIO");
        durableWrite(p, c);
      },
    });
    await h.consumer.poll(); // first: replied, marker failed, pending
    expect(inDir("new")).toEqual(["1.json"]);
    deliver("2.json", { from: "kern", key: kern, messageId: "m-1", body: "second" });
    await h.consumer.poll(); // 1.json is backing off; 2.json meets the pending state
    expect(inDir("refused")).toEqual(["2.json"]);
    expect(h.turns).toHaveLength(1);
    expect(h.replies).toHaveLength(1);
    clock += 1001;
    failMarker = false;
    await h.consumer.poll(); // the first settles on its own retry, without resending
    expect(inDir("cur")).toEqual(["1.json"]);
    expect(h.replies).toEqual([{ to: "flint", inReplyTo: "m-1", body: "SMOKE-OK" }]);
    const marker = JSON.parse(readFileSync(join(inbox, "replied", "m-1"), "utf8"));
    expect(marker.sender).toBe("flint");
  });

  it("(c3) in the failed-send window, another sender's envelope with the id never gets the composed reply", async () => {
    deliver("1.json", { messageId: "m-1", body: "first" });
    let sendOk = false;
    const h = two({
      retryBaseMs: 1000,
      reply: async () =>
        sendOk ? { ok: true } : { ok: false, reason: "exit", detail: "tps exited 1" },
    });
    await h.consumer.poll(); // composed, send failed, pending reply
    deliver("2.json", { from: "kern", key: kern, messageId: "m-1", body: "second" });
    await h.consumer.poll();
    expect(inDir("refused")).toEqual(["2.json"]);
    expect(h.replies.every((r) => r.to === "flint")).toBe(true);
    clock += 1001;
    sendOk = true;
    await h.consumer.poll();
    expect(h.replies.map((r) => r.to)).toEqual(["flint", "flint"]);
    expect(h.turns).toHaveLength(1);
  });

  it("(c4) a marker that reads but is not a marker is HELD for a human — never acked, never refused", async () => {
    mkdirSync(join(inbox, "replied"), { recursive: true });
    writeFileSync(join(inbox, "replied", "m-1"), "not json");
    deliver("1.json", { messageId: "m-1" });
    const h = two();
    await h.consumer.poll();
    expect(existsSync(join(inbox, "held", "1.json"))).toBe(true);
    expect(readFileSync(join(inbox, "held", "1.json.reason"), "utf8")).toMatch(
      /^reason: marker-malformed\n.*is not a marker bob wrote/,
    );
    expect(inDir("refused")).toEqual([]);
    expect(inDir("cur")).toEqual([]);
    expect(h.turns).toHaveLength(0);
    expect(h.consumer.stats.held["marker-malformed"]).toBe(1);
    expect(h.consumer.stats.refused["id-collision"]).toBe(0);
  });
});

describe("round 5, blocker 3 — a wedged lock names the file and the remedy", () => {
  it("(l4) a dead lock plus an EMPTY leftover claim fails closed naming the claim", async () => {
    mkdirSync(join(root, "lock"), { recursive: true });
    const dead = await deadPid();
    writeFileSync(lockFile, String(dead));
    const claim = `${lockFile}.takeover-${dead}`;
    writeFileSync(claim, "");
    let err: Error | undefined;
    try {
      harness({ lockWaitMs: 200 }).consumer.start();
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).toContain(`the takeover claim ${claim} stayed EMPTY for 200ms`);
    expect(err?.message).toContain(`If no mail consumer for testbot is running`);
    expect(err?.message).toContain(
      `remove ${claim}, and ${lockFile} if it still names pid ${dead}`,
    );
    expect(readFileSync(lockFile, "utf8")).toBe(String(dead)); // nothing broken
    expect(existsSync(claim)).toBe(true);
  });

  it("(l5) an EMPTY lock (a start interrupted before its pid) fails closed naming the lock", () => {
    mkdirSync(join(root, "lock"), { recursive: true });
    writeFileSync(lockFile, "");
    expect(() => harness({ lockWaitMs: 200 }).consumer.start()).toThrow(
      new RegExp(
        `consumer lock ${lockFile.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} stayed EMPTY for 200ms.*remove`,
      ),
    );
  });
});

describe("round 5, blocker 4 — the turn's process group is supervised until it is gone", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  async function diesWithin(pid: number, ms: number): Promise<boolean> {
    const deadline = Date.now() + ms;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    return !alive(pid);
  }
  // A launcher that leaves a descendant which IGNORES SIGTERM and has closed its
  // stdio, so the launcher's close does not wait for it.
  function resistantLauncher(tail: string[]): { launcher: string; pidFile: string } {
    const pidFile = join(root, "resistant.pid");
    const launcher = join(root, "resistant-launcher");
    writeFileSync(
      launcher,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        `sh -c 'trap "" TERM; exec sleep 60' </dev/null >/dev/null 2>&1 &`,
        `echo $! > ${pidFile}`,
        ...tail,
        "",
      ].join("\n"),
    );
    chmodSync(launcher, 0o755);
    return { launcher, pidFile };
  }
  function supervised(launcher: string, turnTimeoutMs: number): Harness {
    const replies: ReplyRequest[] = [];
    const consumer = new MailConsumer({
      name: "testbot",
      identity: "testbot",
      inboxRoot: inbox,
      senders: ["flint"],
      resolveKey: keyResolver({ flint }),
      lockFile,
      statsFile,
      turnTimeoutMs,
      pollIntervalMs: 60_000,
      now: () => clock,
      log: () => {},
      runTurn: launcherTurnRunner({ launcherPath: launcher, killGraceMs: 300 }),
      sendReply: async (r) => {
        replies.push(r);
        return { ok: true };
      },
    });
    return { consumer, turns: [], replies, logs: [] };
  }

  it("(g2) a timed-out turn: a SIGTERM-resistant descendant with closed stdio is still killed", async () => {
    deliver("1.json");
    const { launcher, pidFile } = resistantLauncher(["exec sleep 30"]);
    const h = supervised(launcher, 800);
    await h.consumer.poll();
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      expect(h.consumer.stats.timeouts).toBe(1);
      expect(await diesWithin(pid, 6000)).toBe(true);
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL"); // only a pid this test started
    }
  }, 20_000);

  it("(g3) a turn that ENDED normally: what its launcher left behind is reaped too", async () => {
    deliver("1.json");
    const { launcher, pidFile } = resistantLauncher([
      `printf '%s\\n' '{"bobMailTurn":1,"outcome":"final","text":"done"}'`,
      "exit 0",
    ]);
    const h = supervised(launcher, 60_000);
    await h.consumer.poll();
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      expect(h.replies).toEqual([{ to: "flint", inReplyTo: "id-1.json", body: "done" }]);
      expect(await diesWithin(pid, 6000)).toBe(true);
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL");
    }
  }, 20_000);
});

// ─── Gauge round 6 ──────────────────────────────────────────────────────────

describe("round 6, blocker 1 — an existing marker is trusted only once its directory is synced", () => {
  // The directory fsync fails AND the removal of the renamed marker fails, so a
  // marker is left on disk whose durability was never proven.
  function syncAndUnlinkFail(): { io: DurableIo; heal: () => void } {
    let broken = true;
    const dirFds = new Set<number>();
    const io = ioWith({
      openSync: (p, f, m) => {
        const fd = openSync(p, f, m);
        if (f === "r") dirFds.add(fd);
        return fd;
      },
      fsyncSync: (fd) => {
        if (broken && dirFds.has(fd))
          throw Object.assign(new Error("EIO: dir fsync"), { code: "EIO" });
        fsyncSync(fd);
      },
      unlinkSync: (p) => {
        if (broken && !p.includes(".tmp-"))
          throw Object.assign(new Error("EIO: unlink"), { code: "EIO" });
        unlinkSync(p);
      },
    });
    return { io, heal: () => (broken = false) };
  }

  it("(d5) fsync-plus-unlink failure leaves a marker behind; it is NOT trusted until a sync succeeds — across a restart too", async () => {
    deliver("1.json", { messageId: "m-1" });
    const { io, heal } = syncAndUnlinkFail();
    const first = harness({ retryBaseMs: 1000, markerIo: io });
    await first.consumer.poll();
    expect(first.replies).toHaveLength(1);
    expect(existsSync(join(inbox, "replied", "m-1"))).toBe(true); // left behind
    expect(inDir("new")).toEqual(["1.json"]);
    expect(first.consumer.stats).toMatchObject({ processed: 0, replied: 0, markerFailed: 1 });

    clock += 1001;
    await first.consumer.poll(); // the leftover marker: sync still fails → not trusted
    expect(inDir("new")).toEqual(["1.json"]);
    expect(first.replies).toHaveLength(1);
    expect(first.consumer.stats.markerFailed).toBe(2);
    expect(first.logs.join("\n")).toMatch(/cannot be proven durable.*NOT acked/);

    const restarted = harness({ retryBaseMs: 1000, markerIo: io }); // in-memory state gone
    await restarted.consumer.poll();
    expect(inDir("new")).toEqual(["1.json"]);
    expect(restarted.turns).toHaveLength(0);
    expect(restarted.replies).toHaveLength(0);

    heal();
    clock += 1001;
    await restarted.consumer.poll(); // synced now: the marker is proven, the mail acked
    expect(inDir("cur")).toEqual(["1.json"]);
    expect(restarted.replies).toHaveLength(0);
    expect(restarted.consumer.stats.duplicates).toBe(1);
  });

  it("(d6) the same run's own settlement is counted once its leftover marker is proven", async () => {
    deliver("1.json", { messageId: "m-1" });
    const { io, heal } = syncAndUnlinkFail();
    const h = harness({ retryBaseMs: 1000, markerIo: io });
    await h.consumer.poll();
    heal();
    clock += 1001;
    await h.consumer.poll();
    expect(inDir("cur")).toEqual(["1.json"]);
    expect(h.replies).toHaveLength(1);
    expect(h.consumer.stats).toMatchObject({ processed: 1, replied: 1, duplicates: 0 });
  });
});

describe("round 7 — schema validation of a marker, and a held mail never loses its reason", () => {
  it("(m7) a READABLE but incomplete or mismatched marker is held, not trusted as a binding", async () => {
    deliver("1.json", { messageId: "m-1" });
    const h = harness();
    await h.consumer.poll(); // answered: the full marker is written
    const full = JSON.parse(readFileSync(join(inbox, "replied", "m-1"), "utf8"));
    const variants = [
      { sender: full.sender, digest: full.digest }, // two fields only
      { ...full, inboundId: "someone-else" }, // not this inbound's record
    ];
    let n = 2;
    for (const marker of variants) {
      writeFileSync(join(inbox, "replied", "m-1"), JSON.stringify(marker));
      const file = `${n++}.json`;
      deliver(file, { messageId: "m-1" }); // the SAME signed envelope again
      await h.consumer.poll();
      expect(existsSync(join(inbox, "held", file))).toBe(true);
      expect(inDir("cur")).toEqual(["1.json"]);
    }
    expect(h.consumer.stats.held["marker-malformed"]).toBe(2);
    expect(h.consumer.stats.duplicates).toBe(0);
    expect(h.consumer.stats.refused["id-collision"]).toBe(0);
  });

  it("(h1) a .reason sidecar that cannot be written leaves the mail in new/, never in held/ without its reason", async () => {
    mkdirSync(join(inbox, "replied"), { recursive: true });
    writeFileSync(join(inbox, "replied", "m-1"), "not json");
    deliver("1.json", { messageId: "m-1" });
    mkdirSync(join(inbox, "held", "1.json.reason"), { recursive: true }); // unwritable as a file
    const h = harness();
    await h.consumer.poll();
    expect(inDir("new")).toEqual(["1.json"]);
    expect(existsSync(join(inbox, "held", "1.json"))).toBe(false);
    expect(h.consumer.stats.held["marker-malformed"]).toBe(0);
    expect(h.logs.join("\n")).toMatch(/could not hold 1\.json in held\/.*left in new\//);
  });
});

describe("round 6, blocker 2 — only a PROVEN collision refuses", () => {
  it("(r1) a marker READ error is retried, then the same envelope's redelivery is acked", async () => {
    deliver("1.json", { messageId: "m-1" });
    let failRead = false;
    const h = harness({
      retryBaseMs: 1000,
      readMarkerFile: (path) => {
        if (failRead) throw Object.assign(new Error("EIO: read"), { code: "EIO" });
        return readFileSync(path, "utf8");
      },
    });
    await h.consumer.poll(); // answered; marker written
    expect(inDir("cur")).toEqual(["1.json"]);
    deliver("2.json", { messageId: "m-1" }); // the same signed envelope again
    failRead = true;
    await h.consumer.poll();
    expect(inDir("new")).toEqual(["2.json"]);
    expect(inDir("refused")).toEqual([]);
    expect(h.consumer.stats.markerReadFailed).toBe(1);
    expect(h.logs.join("\n")).toMatch(/marker for m-1 could not be read \(EIO\); left in new/);
    failRead = false;
    clock += 1001;
    await h.consumer.poll();
    expect(inDir("cur").sort()).toEqual(["1.json", "2.json"]);
    expect(h.turns).toHaveLength(1);
    expect(h.replies).toHaveLength(1);
    expect(h.consumer.stats.duplicates).toBe(1);
    expect(h.consumer.stats.refused["id-collision"]).toBe(0);
  });
});

describe("round 6, blocker 3 — group cleanup starts when the leader EXITS", () => {
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  it("(g4) a SIGTERM-resistant descendant that KEEPS stdout neither holds the turn to its timeout nor gets a finished turn retried", async () => {
    deliver("1.json", { messageId: "m-1" });
    const pidFile = join(root, "holder.pid");
    const launcher = join(root, "holding-launcher");
    writeFileSync(
      launcher,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        `printf '%s\\n' '{"bobMailTurn":1,"outcome":"final","text":"done"}'`,
        // Inherits stdout and stderr: the launcher's `close` cannot fire while it lives.
        `sh -c 'trap "" TERM; exec sleep 60' &`,
        `echo $! > ${pidFile}`,
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(launcher, 0o755);
    const h = harness({
      launcherPath: launcher,
      runTurn: undefined,
      turnTimeoutMs: 20_000,
      turnRunner: { killGraceMs: 300 },
    });
    const t0 = Date.now();
    await h.consumer.poll();
    const elapsed = Date.now() - t0;
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    try {
      expect(elapsed).toBeLessThan(8000); // not the 20 s turn timeout
      expect(h.consumer.stats.timeouts).toBe(0);
      expect(h.replies).toEqual([{ to: "flint", inReplyTo: "m-1", body: "done" }]);
      expect(inDir("cur")).toEqual(["1.json"]); // finished, never retried
      expect(alive(pid)).toBe(false);
    } finally {
      if (alive(pid)) process.kill(pid, "SIGKILL"); // only a pid this test started
    }
  }, 40_000);

  it("(g5) members left after SIGKILL and the reap limit are LOGGED and COUNTED", async () => {
    deliver("1.json", { messageId: "m-1" });
    const launcher = join(root, "plain-launcher");
    writeFileSync(
      launcher,
      [
        "#!/bin/sh",
        "cat > /dev/null",
        `printf '%s\\n' '{"bobMailTurn":1,"outcome":"final","text":"done"}'`,
        "exit 0",
        "",
      ].join("\n"),
    );
    chmodSync(launcher, 0o755);
    const signalled: string[] = [];
    const h = harness({
      launcherPath: launcher,
      runTurn: undefined,
      turnRunner: {
        killGraceMs: 50,
        reapLimitMs: 100,
        // A group that never goes away, whatever it is sent.
        groupOps: { exists: () => true, signal: (_pgid, sig) => void signalled.push(sig) },
      },
    });
    await h.consumer.poll();
    const deadline = Date.now() + 3000;
    while (h.consumer.stats.reapExhausted === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(signalled).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.consumer.stats.reapExhausted).toBe(1);
    expect(h.logs.join("\n")).toMatch(
      /process group \d+ still has members after SIGKILL and the reap limit; cleanup gave up/,
    );
  }, 10_000);
});
