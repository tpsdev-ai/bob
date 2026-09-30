// bob#244 (web spec v3, slice R1a): bob's own "what remains" note (#145) is an
// injection into a running session, and it carries workspace data (git
// status). In a web session it is refused — the observer logs the refusal and
// the run carries on — while any other session still gets it. Driven through
// runAgent with a scripted session, so the wiring in run.ts is what is tested.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPersistent } from "../../src/shell/persistent.js";
import { type RunSession, type RunSessionConfig, runAgent } from "../../src/shell/run.js";

let root: string;
let agentsRoot: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-web-note-"));
  agentsRoot = join(root, "agents");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeAgent(capabilities: string[]): void {
  const agentDir = join(agentsRoot, "notebot");
  mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
  mkdirSync(join(agentDir, "work"), { recursive: true });
  writeFileSync(
    join(agentDir, "bob.yaml"),
    [
      "agent:",
      "  id: notebot",
      "  role: ea",
      "",
      "provider:",
      "  name: anthropic",
      "  model: claude-sonnet-4-6",
      "  context_window: 200000",
      "",
      "tools:",
      "  allow:",
      "",
      "capabilities:",
      ...capabilities.map((c) => `  - ${c}`),
      "",
    ].join("\n"),
  );
}

// A session whose one turn compacts and then ends; any steer is recorded.
function compactingSession(steers: string[]): RunSession {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    subscribe(listener: (event: unknown) => void) {
      listeners.push(listener);
      return () => {};
    },
    async prompt(text: string, options?: { streamingBehavior?: string }) {
      if (options?.streamingBehavior !== undefined) {
        steers.push(text);
        return;
      }
      for (const listener of listeners) {
        listener({ type: "compaction_end", reason: "threshold" });
        listener({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            stopReason: "stop",
          },
        });
      }
    },
    dispose() {},
  } as unknown as RunSession;
}

async function run(capabilities: string[]) {
  writeAgent(capabilities);
  const steers: string[] = [];
  let seen: RunSessionConfig | undefined;
  const stderr: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    const res = await runAgent({
      name: "notebot",
      prompt: "do the thing",
      agentsRoot,
      sessionFactory: async (config) => {
        seen = config;
        return compactingSession(steers);
      },
    });
    return { res, steers, seen, stderr: stderr.join("") };
  } finally {
    process.stderr.write = write;
  }
}

describe("bob's compaction note and the web composition rule", () => {
  it("a web session gets NO note: the injection is refused and logged, and the run still settles", async () => {
    const { res, steers, seen, stderr } = await run(["web"]);
    expect(Object.values(seen?.capabilityBySource ?? {})).toEqual(["web"]);
    expect(res.exitCode).toBe(0);
    expect(steers).toEqual([]);
    expect(stderr).toContain("not sending the compaction-note into a web session");
  });

  it("the control: the same agent without web gets the note as a steer", async () => {
    const { res, steers } = await run(["fixture"]);
    expect(res.exitCode).toBe(0);
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("WHAT REMAINS");
  });
});

describe("the persistent runtime's compaction note", () => {
  // A warm session whose events the test fires directly.
  function warmSession(steers: string[]) {
    const listeners: Array<(event: unknown) => void> = [];
    const session = {
      subscribe(listener: (event: unknown) => void) {
        listeners.push(listener);
        return () => {};
      },
      async prompt(text: string, options?: { streamingBehavior?: string }) {
        if (options?.streamingBehavior !== undefined) steers.push(text);
      },
      async waitForIdle() {},
      dispose() {},
    } as unknown as RunSession;
    const emit = (event: unknown) => {
      for (const listener of listeners) listener(event);
    };
    return { session, emit };
  }

  async function persistentNote(capabilities: string[]) {
    writeAgent(capabilities);
    const steers: string[] = [];
    const logs: string[] = [];
    const warm = warmSession(steers);
    const handle = await startPersistent({
      name: "notebot",
      agentsRoot,
      installSignalHandlers: false,
      log: (m) => logs.push(m),
      sessionFactory: async () => warm.session,
    });
    try {
      warm.emit({ type: "compaction_end", reason: "threshold" });
      // The refusal and the send both settle on a later microtask.
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { steers, logs: logs.join("\n") };
    } finally {
      await handle.shutdown();
    }
  }

  it("a web session gets no note, and the refusal is logged", async () => {
    const { steers, logs } = await persistentNote(["web"]);
    expect(steers).toEqual([]);
    expect(logs).toContain("not sending the compaction-note into a web session");
  });

  it("the control: without web the warm session gets the note", async () => {
    const { steers } = await persistentNote(["fixture"]);
    expect(steers).toHaveLength(1);
    expect(steers[0]).toContain("WHAT REMAINS");
  });
});
