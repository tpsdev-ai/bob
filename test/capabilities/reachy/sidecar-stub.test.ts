// reachy S3 — the REAL stub sidecar over a UNIX socket + the key-read proof.
//
// Round 4: completion is the stub's EXPLICIT end-of-replay marker, and the
// expected event count + outcomes are PINNED CONSTANTS in this test — never a
// count derived from the fixture, so a truncated replay cannot satisfy them. The
// key proof makes the fixture dir TRAVERSABLE (0711) and asserts BOTH that a 0644
// control file IS readable by the other user and the 0600 fixtures are NOT, so it
// isolates the file mode, not the directory.
import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MemoryWriter,
  type OrgEventStore,
  orgEventRecordId,
  type PiLike,
  type ReachyCommands,
  wireReachyCapability,
} from "../../../src/capabilities/reachy/capability.js";
import { UnixSocketReachyClient } from "../../../src/capabilities/reachy/client.js";
import type { OrgEvent, PolicyState } from "../../../src/capabilities/reachy/policy.js";

// PINNED expectations, independent of any fixture file (round 4 item 4). If the
// replay is truncated, these are NOT met and the proof FAILS — it does not
// measure whatever file the caller handed it.
const EVENTS_EXPECTED = 5; // the 5 event lines in the fixture, before the end marker
const EXPECTED_MEMORY_WRITES = 1; // one private memory, for the verified speaker
const EXPECTED_VISITOR_MEMORIES = 0;
const EXPECTED_MALFORMED = 0;

const REPO = join(import.meta.dirname, "..", "..", "..");
const STUB = join(REPO, "test", "fixtures", "reachy-stub", "sidecar.py");
const EVENTS = join(REPO, "test", "fixtures", "reachy-stub", "events.jsonl");

class FakePi implements PiLike {
  registerTool(): void {}
}
class FakeCommands implements ReachyCommands {
  async send(): Promise<unknown> {
    return null;
  }
}
class FakeMemory implements MemoryWriter {
  readonly writes: Array<{
    content: string;
    visibility: string;
    metadata: { speakerId: string; correlationId: string; orgEventId: string };
  }> = [];
  private n = 0;
  async writePrivate(w: {
    content: string;
    visibility: "private";
    authorId: string;
    metadata: { speakerId: string; correlationId: string; orgEventId: string };
  }): Promise<{ id: string }> {
    this.writes.push(w);
    return { id: `mem_${++this.n}` };
  }
}
class FakeStore implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  async write(event: OrgEvent): Promise<{ id: string }> {
    this.all.push(event);
    return { id: orgEventRecordId(event) };
  }
  async getById(): Promise<OrgEvent | null> {
    return null;
  }
}

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeHarness(enrolment: Record<string, string>) {
  const memory = new FakeMemory();
  const store = new FakeStore();
  const state: PolicyState = {
    wakeName: "jarvis",
    enrolment,
    mute: false,
    nowMs: () => Date.now(),
    lastAcknowledgeAtMs: undefined,
  };
  const wired = wireReachyCapability({
    pi: new FakePi(),
    commands: new FakeCommands(),
    memory,
    store,
    state,
    log: () => {},
  });
  return { memory, store, wired };
}

/** Start the stub on a temp socket and connect the REAL client; returns a helper
 *  to await the end-of-replay MARKER (not a count from the fixture) before
 *  asserting, with every handler promise awaited. */
async function startReplay(eventsPath: string) {
  const dir = mkdtempSync(join(tmpdir(), "reachy-sock-"));
  scratch.push(dir);
  const socketPath = join(dir, "reachy.sock");
  const proc = spawn("python3", [STUB, socketPath, eventsPath], { stdio: "ignore" });
  const deadline = Date.now() + 8000;
  while (!existsSync(socketPath)) {
    if (Date.now() > deadline) throw new Error("stub socket never appeared");
    await new Promise((r) => setTimeout(r, 10));
  }
  const h = makeHarness({ "spk-1": "member-1" });
  let received = 0;
  let ended = false;
  const pending: Array<Promise<unknown>> = [];
  const client = new UnixSocketReachyClient({ socket: socketPath });
  await client.connect();
  client.onLine((line) => {
    const obj = line as { type?: string; replayEnd?: boolean };
    if (obj?.type === "health" && obj.replayEnd === true) {
      ended = true; // the stub's explicit end-of-replay marker
      return;
    }
    received++;
    pending.push(h.wired.handleLine(line)); // awaited below, never fire-and-forget
  });
  const waitFullReplay = async () => {
    const done = Date.now() + 8000;
    while (!ended) {
      if (Date.now() > done)
        throw new Error(`replay never ended: received ${received} event line(s)`);
      await new Promise((r) => setTimeout(r, 10));
    }
    await Promise.all(pending); // every handler has settled
  };
  const stop = () => {
    client.close();
    proc.kill();
  };
  return { ...h, waitFullReplay, stop, received: () => received };
}

describe("reachy S3 — the real stub sidecar over a UNIX socket", () => {
  it("replays EVERY line: the PINNED outcomes hold (one private memory for the speaker, none for the visitor)", async () => {
    const h = await startReplay(EVENTS);
    try {
      await h.waitFullReplay(); // waits for the end-of-replay marker, not the file
      expect(h.received()).toBe(EVENTS_EXPECTED); // constant, NOT derived from the fixture
      expect(h.memory.writes.length).toBe(EXPECTED_MEMORY_WRITES);
      expect(h.memory.writes[0]!.visibility).toBe("private");
      expect(h.memory.writes[0]!.metadata.speakerId).toBe("spk-1");
      expect(h.memory.writes.filter((w) => w.metadata.speakerId === "visitor-9").length).toBe(
        EXPECTED_VISITOR_MEMORIES,
      );
      expect(h.store.all.filter((e) => e.kind === "reachy.malformed").length).toBe(
        EXPECTED_MALFORMED,
      );
    } finally {
      h.stop();
    }
  }, 30_000);

  it("the pinned proof CANNOT be satisfied by a truncated replay (drops the visitor line)", async () => {
    // The end-of-replay marker still arrives (the stub always appends it), so
    // waitFullReplay completes — but the PINNED event count is not met, because it
    // is a constant, not the fixture's own length. This is the weakness the
    // constants remove: with a fixture-derived count this case PASSED.
    const dir = mkdtempSync(join(tmpdir(), "reachy-trunc-"));
    scratch.push(dir);
    const truncated = join(dir, "events.jsonl");
    const all = readFileSync(EVENTS, "utf8").split("\n").filter(Boolean);
    writeFileSync(truncated, all.slice(0, 4).join("\n") + "\n"); // drop the visitor line (line 5)
    const h = await startReplay(truncated);
    try {
      await h.waitFullReplay();
      expect(h.received()).toBeLessThan(EVENTS_EXPECTED); // the proof FAILS, as it must
      expect(all.length).toBe(EVENTS_EXPECTED); // the fixture really has EVENTS_EXPECTED lines
    } finally {
      h.stop();
    }
  }, 30_000);

  it("an oversized line over the socket is malformed, never buffered", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reachy-big-"));
    scratch.push(dir);
    const big = join(dir, "big.jsonl");
    writeFileSync(big, JSON.stringify({ type: "health", blob: "x".repeat(70 * 1024) }) + "\n");
    const h = await startReplay(big);
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(h.memory.writes.length).toBe(0);
      expect(h.store.all.some((e) => e.kind === "reachy.malformed")).toBe(true);
    } finally {
      h.stop();
    }
  }, 30_000);

  it("an extra wire field over the socket is malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reachy-extra-"));
    scratch.push(dir);
    const f = join(dir, "extra.jsonl");
    writeFileSync(
      f,
      JSON.stringify({
        type: "transcript",
        text: "jarvis hi",
        ts: "t",
        wakeHeard: true,
        extra: 1,
      }) + "\n",
    );
    const h = await startReplay(f);
    try {
      await h.waitFullReplay();
      expect(h.memory.writes.length).toBe(0);
      expect(h.store.all.some((e) => e.kind === "reachy.malformed")).toBe(true);
    } finally {
      h.stop();
    }
  }, 30_000);
});

describe("reachy S3 — key-read proof (a DIFFERENT OS user cannot read the 0600 key fixtures)", () => {
  const hasUser = (() => {
    try {
      execFileSync("id", ["-u", "jarvis-sidecar"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  const sudoNoPrompt = spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 0;
  const skipReason = !hasUser
    ? "the jarvis-sidecar user is not provisioned"
    : !sudoNoPrompt
      ? "sudo -n is unavailable"
      : "";
  it.skipIf(skipReason !== "")(
    `the FILE mode (not the directory) denies the other user: 0644 readable, 0600 not${skipReason ? ` — skipped: ${skipReason}` : ""}`,
    () => {
      const dir = mkdtempSync(join(tmpdir(), "reachy-keyread-"));
      scratch.push(dir);
      // Make the DIRECTORY traversable (0711): without this the 0700 dir denies
      // traversal and the test proves nothing about the file modes (round 4 item 5).
      chmodSync(dir, 0o711);
      expect((statSync(dir).mode & 0o777).toString(8)).toBe("711");
      const control = join(dir, "control-0644");
      const adminPass = join(dir, "admin-pass");
      const agentKey = join(dir, "agent-key");
      writeFileSync(control, "fixture-control-not-a-secret\n", { mode: 0o644 });
      writeFileSync(adminPass, "fixture-not-a-real-secret\n", { mode: 0o600 });
      writeFileSync(agentKey, "fixture-not-a-real-key\n", { mode: 0o600 });
      expect((statSync(control).mode & 0o777).toString(8)).toBe("644");
      expect((statSync(adminPass).mode & 0o777).toString(8)).toBe("600");
      expect((statSync(agentKey).mode & 0o777).toString(8)).toBe("600");
      // The 0644 control IS readable → the dir is truly traversable, so the 0600
      // denials below are about the FILE mode.
      const ok = spawnSync("sudo", ["-n", "-u", "jarvis-sidecar", "cat", control], {
        encoding: "utf8",
      });
      expect(ok.status, `cat ${control} as jarvis-sidecar should SUCCEED`).toBe(0);
      expect(ok.stdout).toContain("fixture-control-not-a-secret");
      for (const f of [adminPass, agentKey]) {
        const r = spawnSync("sudo", ["-n", "-u", "jarvis-sidecar", "cat", f], { encoding: "utf8" });
        expect(r.status, `cat ${f} as jarvis-sidecar should fail`).not.toBe(0);
        expect(r.stderr).toContain("Permission denied");
      }
    },
  );
});
