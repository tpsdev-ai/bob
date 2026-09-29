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
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MailTurnInput } from "../../src/capabilities/tps-mail/prompt.js";
import type { ReplyRequest, ReplyResult } from "../../src/capabilities/tps-mail/reply.js";
import {
  durableWrite,
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
        `const [lockFile, inboxRoot, go, stop, out, statsFile] = process.argv.slice(2);`,
        `const nap = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);`,
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
      writeFileSync(out, "");
      const racers: ChildProcess[] = [];
      for (let i = 0; i < 6; i++) {
        const c = spawn(
          process.execPath,
          [script, lockFile, join(dir, "inbox"), go, stop, out, join(dir, `stats-${i}.json`)],
          { stdio: "ignore" },
        );
        racers.push(c);
        children.push(c);
      }
      await new Promise((r) => setTimeout(r, 600)); // every racer is waiting on `go`
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
      /did not settle within 200ms/,
    );
    expect(readFileSync(lockFile, "utf8")).toBe(String(dead));
  });
});
