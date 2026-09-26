// reachy S3 — the REAL stub sidecar over a UNIX socket + the key-read proof.
//
// Part 1 starts test/fixtures/reachy-stub/sidecar.py on a temp UNIX socket, connects
// the REAL UnixSocketReachyClient, replays events.jsonl through it, and lets the
// WIRE decoder + policy run — so the live path is exercised end to end.
// Part 2 is the key-read proof: it REQUIRES the `jarvis-sidecar` user and FAILS
// when absent — a real check, not a passing no-op. Set REACHY_KEY_PROOF=skip to
// SKIP it (visible in the run) on a host that cannot provision the user.
import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MemoryWriter,
  type OrgEventStore,
  type PiLike,
  type ReachyCommands,
  wireReachyCapability,
} from "../../../src/capabilities/reachy/capability.js";
import { UnixSocketReachyClient } from "../../../src/capabilities/reachy/client.js";
import type { OrgEvent, PolicyState } from "../../../src/capabilities/reachy/policy.js";

const REPO = join(import.meta.dirname, "..", "..", "..");
const STUB = join(REPO, "test", "fixtures", "reachy-stub", "sidecar.py");
const EVENTS = join(REPO, "test", "fixtures", "reachy-stub", "events.jsonl");

class FakePi implements PiLike {
  registerTool(_t: unknown): void {}
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
    metadata: { speakerId: string; correlationId: string };
  }> = [];
  private n = 0;
  async writePrivate(w: {
    content: string;
    visibility: "private";
    authorId: string;
    metadata: { speakerId: string; correlationId: string };
  }): Promise<{ id: string }> {
    this.writes.push(w);
    return { id: `mem_${++this.n}` };
  }
}
class FakeStore implements OrgEventStore {
  readonly all: OrgEvent[] = [];
  async write(event: OrgEvent): Promise<{ id: string }> {
    this.all.push(event);
    return { id: `evt_${this.all.length}` };
  }
  async readByCorrelation(): Promise<OrgEvent | null> {
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

describe("reachy S3 — the real stub sidecar over a UNIX socket", () => {
  it("replays events.jsonl through the real client + wire decoder: one private memory, the visitor none", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reachy-sock-"));
    scratch.push(dir);
    const socketPath = join(dir, "reachy.sock");
    const proc = spawn("python3", [STUB, socketPath, EVENTS], { stdio: "ignore" });

    // Wait for the socket file, then connect the REAL client.
    const deadline = Date.now() + 8000;
    while (!existsSync(socketPath)) {
      if (Date.now() > deadline) throw new Error("stub socket never appeared");
      await new Promise((r) => setTimeout(r, 10));
    }
    const { memory, wired } = makeHarness({ "spk-1": "member-1" });
    const client = new UnixSocketReachyClient({ socket: socketPath });
    await client.connect();
    client.onLine((line) => {
      void wired.handleLine(line);
    });

    // Wait for the replay to land (the verified transcript writes one memory).
    const done = Date.now() + 8000;
    while (memory.writes.length === 0) {
      if (Date.now() > done) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    client.close();
    proc.kill();

    expect(memory.writes.length).toBe(1); // RED before: flat decoding → zero writes over the socket
    expect(memory.writes[0]!.visibility).toBe("private");
    expect(memory.writes[0]!.metadata.speakerId).toBe("spk-1");
    expect(memory.writes.some((w) => w.metadata.speakerId === "visitor-9")).toBe(false);
  }, 30_000);

  it("a malformed line over the socket does nothing but emit reachy.malformed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "reachy-badline-"));
    scratch.push(dir);
    const socketPath = join(dir, "reachy.sock");
    const bad = join(dir, "bad.jsonl");
    writeFileSync(bad, '{"type":"proposal","text":"just prose"}\n');
    const proc = spawn("python3", [STUB, socketPath, bad], { stdio: "ignore" });
    const deadline = Date.now() + 8000;
    while (!existsSync(socketPath)) {
      if (Date.now() > deadline) throw new Error("stub socket never appeared");
      await new Promise((r) => setTimeout(r, 10));
    }
    const { memory, store, wired } = makeHarness({ "spk-1": "member-1" });
    const client = new UnixSocketReachyClient({ socket: socketPath });
    await client.connect();
    client.onLine((line) => {
      void wired.handleLine(line);
    });
    const done = Date.now() + 5000;
    while (store.all.length === 0) {
      if (Date.now() > done) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    client.close();
    proc.kill();
    expect(memory.writes.length).toBe(0);
    expect(store.all.some((e) => e.kind === "reachy.malformed")).toBe(true);
  }, 30_000);
});

describe("reachy S3 — key-read proof (the stub runs as its own user)", () => {
  const forcedSkip = process.env.REACHY_KEY_PROOF === "skip";
  const hasUser = (() => {
    try {
      execFileSync("id", ["-u", "jarvis-sidecar"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();
  it.skipIf(forcedSkip)(
    `jarvis-sidecar cannot read a 0600 fixture${forcedSkip ? " (SKIPPED: REACHY_KEY_PROOF=skip)" : ""}`,
    () => {
      if (!hasUser) {
        throw new Error(
          "the `jarvis-sidecar` user is REQUIRED for the key-read proof — provision it (see README) or set REACHY_KEY_PROOF=skip to SKIP this test",
        );
      }
      const dir = mkdtempSync(join(tmpdir(), "reachy-keyread-"));
      scratch.push(dir);
      const adminPass = join(dir, "admin-pass");
      const agentKey = join(dir, "agent-key");
      writeFileSync(adminPass, "fixture-not-a-real-secret\n", { mode: 0o600 });
      writeFileSync(agentKey, "fixture-not-a-real-key\n", { mode: 0o600 });
      expect((statSync(adminPass).mode & 0o777).toString(8)).toBe("600");
      expect((statSync(agentKey).mode & 0o777).toString(8)).toBe("600");
      for (const f of [adminPass, agentKey]) {
        const r = spawnSync("sudo", ["-n", "-u", "jarvis-sidecar", "cat", f], { encoding: "utf8" });
        expect(r.status, `cat ${f} as jarvis-sidecar should fail`).not.toBe(0);
        expect(r.stderr).toContain("Permission denied");
      }
    },
  );
});
