// reachy S3 — the stub sidecar replay + the key-read proof (bob#180 §5 S3).
//
// Part 1 drives the capability with the STUB sidecar's scripted event file
// (test/fixtures/reachy-stub/events.jsonl) — no hardware, no model.
// Part 2 is the S1 key-read proof run here too: the stub runs as its OWN
// unprivileged user and cannot read a 0600 fixture; skipped (with the reason
// printed) when the host cannot create the user — never silently green.
import { describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type MemoryWriter,
  type PiLike,
  type ReachyCommands,
  wireReachyCapability,
} from "../../../src/capabilities/reachy/capability.js";
import type {
  MemoryWrite,
  OrgEvent,
  PolicyState,
} from "../../../src/capabilities/reachy/policy.js";

const STUB_EVENTS = join(
  import.meta.dirname,
  "..",
  "..",
  "fixtures",
  "reachy-stub",
  "events.jsonl",
);

class FakePi implements PiLike {
  readonly tools = new Map<
    string,
    {
      name: string;
      execute: (
        id: string,
        p: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
    }
  >();
  registerTool(tool: {
    name: string;
    execute: (
      id: string,
      p: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void {
    this.tools.set(tool.name, tool);
  }
}
class FakeCommands implements ReachyCommands {
  readonly sent: Array<{ command: string; args?: Record<string, unknown> }> = [];
  async send(command: string, args?: Record<string, unknown>): Promise<unknown> {
    this.sent.push({ command, args });
    return null;
  }
}
class FakeMemory implements MemoryWriter {
  readonly writes: MemoryWrite[] = [];
  private n = 0;
  async writePrivate(w: MemoryWrite): Promise<{ id: string }> {
    this.writes.push(w);
    return { id: `mem_${++this.n}` };
  }
}

describe("reachy S3 — the stub sidecar's scripted events drive the capability", () => {
  it("replays events.jsonl: the verified transcript writes one private memory, the visitor does not, the look is audited", async () => {
    const pi = new FakePi();
    const commands = new FakeCommands();
    const memory = new FakeMemory();
    const events: OrgEvent[] = [];
    const state: PolicyState = {
      wakeName: "jarvis",
      enrolment: { "spk-1": "member-1" },
      mute: false,
      nowMs: () => Date.now(),
      lastAcknowledgeAtMs: undefined,
    };
    const wired = wireReachyCapability({
      pi,
      commands,
      memory,
      emit: (e) => {
        events.push(e);
      },
      state,
      log: () => {},
    });

    const lines = readFileSync(STUB_EVENTS, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    for (const line of lines) {
      const type = line.type as "transcript" | "proposal" | "presence" | "health";
      if (type === "transcript")
        await wired.handleEvent({ transcript: line as never }, "transcript");
      else if (type === "proposal")
        await wired.handleEvent({ proposal: line as never }, "proposal");
      else await wired.handleEvent(line as never, type);
    }

    expect(memory.writes.length).toBe(1); // only the enrolled speaker's sentence is durable
    expect(memory.writes[0]!.visibility).toBe("private");
    expect(memory.writes[0]!.metadata.speakerId).toBe("spk-1");
    expect(events.some((e) => e.kind === "reachy.memory")).toBe(true);
    expect(events.some((e) => e.kind === "reachy.look")).toBe(true);
    // The visitor's addressed sentence is EPHEMERAL — recallable nowhere.
    expect(memory.writes.some((w) => w.metadata.speakerId === "visitor-9")).toBe(false);
  });
});

describe("reachy S3 — key-read proof (the stub runs as its own user)", () => {
  it("jarvis-sidecar cannot read a 0600 admin-pass / agent-key fixture; both are 0600", () => {
    const dir = mkdtempSync(join(tmpdir(), "reachy-keyread-"));
    try {
      const adminPass = join(dir, "admin-pass");
      const agentKey = join(dir, "agent-key");
      writeFileSync(adminPass, "fixture-not-a-real-secret\n", { mode: 0o600 });
      writeFileSync(agentKey, "fixture-not-a-real-key\n", { mode: 0o600 });

      // Both must be 0600 for the owner.
      const mode = (f: string) =>
        execFileSync("stat", ["-c", "%a", f], { encoding: "utf8" }).trim();
      expect(mode(adminPass)).toBe("600");
      expect(mode(agentKey)).toBe("600");

      // Ensure the separate user exists (create once). If the host cannot, SKIP
      // with the reason printed — never silently green.
      const hasUser = () => {
        try {
          execFileSync("id", ["-u", "jarvis-sidecar"], { stdio: "ignore" });
          return true;
        } catch {
          return false;
        }
      };
      if (!hasUser()) {
        const created = spawnSync(
          "sudo",
          ["-n", "useradd", "-r", "-M", "-s", "/usr/sbin/nologin", "jarvis-sidecar"],
          { encoding: "utf8" },
        );
        if (created.status !== 0) {
          console.error(
            `reachy S3 key-read proof: SKIPPED — cannot create the jarvis-sidecar user (${created.stderr?.trim() || created.error?.message || `exit ${created.status}`})`,
          );
          return;
        }
      }

      for (const f of [adminPass, agentKey]) {
        const r = spawnSync("sudo", ["-n", "-u", "jarvis-sidecar", "cat", f], { encoding: "utf8" });
        expect(r.status, `cat ${f} as jarvis-sidecar should fail`).not.toBe(0);
        expect(r.stderr).toContain("Permission denied");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
