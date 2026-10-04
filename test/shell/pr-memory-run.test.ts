// bob#185 item 5 — the runtime entry path. Stands up a REAL local HTTP stub as
// Flair (so the real HTTP + Ed25519 signing path runs) and runs `bob run`
// twice: round N writes the memory, round N+1 recalls it into the factory's
// config BEFORE the first request, with nothing pasted into either brief.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskBinding } from "../../src/capabilities/work/task-binding.js";
import { PR_MEMORY_PROMPT_HEADING, prMemoryKey } from "../../src/shell/pr-memory.js";
import { type RunSession, type RunSessionConfig, runAgent } from "../../src/shell/run.js";

const AGENT = "testbot";
const REPO = "github.com/tpsdev-ai/bob";
const PR = 185;
const ID = prMemoryKey(AGENT, REPO, PR);

function writeKeyFile(dir: string): string {
  const path = join(dir, "testbot.key");
  const pem = generateKeyPairSync("ed25519").privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  writeFileSync(path, pem);
  return path;
}

interface Stub {
  url: string;
  store: Map<string, string>;
  close(): Promise<void>;
}

async function startMemoryStub(): Promise<Stub> {
  const store = new Map<string, string>();
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const method = req.method ?? "";
      const path = req.url ?? "";
      const send = (status: number, body: string): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      };
      if (path === "/BootstrapMemories") return send(200, JSON.stringify({ context: "" }));
      const m = /^\/Memory\/(.+)$/.exec(path);
      if (m) {
        const id = decodeURIComponent(m[1] as string);
        if (method === "PUT") {
          store.set(id, raw);
          return send(200, JSON.stringify({ id }));
        }
        if (method === "GET") {
          const found = store.get(id);
          return found !== undefined
            ? send(200, found)
            : send(404, JSON.stringify({ error: "not found" }));
        }
      }
      return send(404, JSON.stringify({ error: "no route" }));
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    store,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

function scriptedSession(prompts?: string[]): RunSession {
  const listeners: Array<(e: unknown) => void> = [];
  return {
    subscribe(l) {
      listeners.push(l as (e: unknown) => void);
      return () => {};
    },
    async prompt(text) {
      prompts?.push(text);
      for (const l of listeners) {
        l({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stopReason: "stop",
          },
        });
      }
    },
    dispose() {},
  };
}

function scaffold(root: string, url: string, keyFile: string): void {
  const dir = join(root, AGENT);
  mkdirSync(join(dir, "work"), { recursive: true });
  mkdirSync(join(dir, ".pi-agent"), { recursive: true });
  writeFileSync(join(dir, "soul.md"), "You are Testbot.");
  writeFileSync(
    join(dir, "bob.yaml"),
    [
      "agent:",
      `  id: ${AGENT}`,
      "  name: Testbot",
      "  role: reviewer",
      "",
      "provider:",
      "  name: anthropic",
      "  model: claude-sonnet-4-6",
      "",
      "tools:",
      "  allow:",
      "    - read",
      "",
      "capabilities:",
      "  - flair",
      "",
      "flair:",
      `  url: ${url}`,
      `  agentId: ${AGENT}`,
      `  keyFile: ${keyFile}`,
      "",
    ].join("\n"),
  );
}

function binding(prNumber: number): TaskBinding {
  return {
    task_id: "t1",
    publication_id: "p1",
    repository: REPO,
    workspace: "/ws",
    base_oid: "a".repeat(40),
    mode: "build",
    artifact_root: "/art",
    declared_paths: ["src/a.ts"],
    check_commands: ["bun test"],
    destination: { remote: "origin", ref: "refs/heads/main" },
    pr_ref: { repository: REPO, number: prNumber },
  };
}

let root: string;
let keyFile: string;
const stubs: Stub[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-prmem-run-"));
  keyFile = writeKeyFile(root);
});
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.close();
  rmSync(root, { recursive: true, force: true });
});

describe("`bob run` with a launcher pr_ref", () => {
  it("round N writes, round N+1 recalls before the first request", async () => {
    const stub = await startMemoryStub();
    stubs.push(stub);
    scaffold(root, stub.url, keyFile);

    // Round N — no memory yet.
    const prompts: string[] = [];
    let first: RunSessionConfig | undefined;
    const r1 = await runAgent({
      name: AGENT,
      prompt: "round N",
      agentsRoot: root,
      taskBinding: binding(PR),
      sessionFactory: async (c) => {
        first = c;
        return scriptedSession(prompts);
      },
    });
    expect(r1.exitCode).toBe(0);
    expect(first?.prMemory).toBeUndefined();

    // The round-end write landed a private, persistent record.
    expect(stub.store.get(ID)).toBeDefined();
    const record = JSON.parse(stub.store.get(ID) as string) as Record<string, unknown>;
    expect(record.visibility).toBe("private");
    expect(record.durability).toBe("persistent");
    expect(record.tags).toEqual(["bob-pr-round"]);
    expect(record.subject).toBe(`${REPO}#pr-${PR}`);

    // Round N+1 — the recall is attached to the factory config BEFORE the
    // session is built, and neither brief carried it.
    let second: RunSessionConfig | undefined;
    const r2 = await runAgent({
      name: AGENT,
      prompt: "round N+1",
      agentsRoot: root,
      taskBinding: binding(PR),
      sessionFactory: async (c) => {
        second = c;
        return scriptedSession(prompts);
      },
    });
    expect(r2.exitCode).toBe(0);
    expect(second?.prMemory).toContain(PR_MEMORY_PROMPT_HEADING);
    expect(second?.prMemory).toContain("completed");
    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("round N");
    expect(prompts[1]).toContain("round N+1");
    for (const prompt of prompts) {
      expect(prompt).not.toContain(PR_MEMORY_PROMPT_HEADING);
      expect(prompt).not.toContain("<<<BOB-PR-MEMORY>>>");
    }
  });

  it("a different PR recalls nothing", async () => {
    const stub = await startMemoryStub();
    stubs.push(stub);
    scaffold(root, stub.url, keyFile);
    await runAgent({
      name: AGENT,
      prompt: "round N",
      agentsRoot: root,
      taskBinding: binding(PR),
      sessionFactory: async () => scriptedSession(),
    });
    let other: RunSessionConfig | undefined;
    await runAgent({
      name: AGENT,
      prompt: "other PR",
      agentsRoot: root,
      taskBinding: binding(999),
      sessionFactory: async (c) => {
        other = c;
        return scriptedSession();
      },
    });
    expect(other?.prMemory).toBeUndefined();
  });

  it("an unreachable Flair: the round runs, no memory, no block", async () => {
    const stub = await startMemoryStub();
    const url = stub.url;
    await stub.close(); // nothing is listening now
    scaffold(root, url, keyFile);
    let config: RunSessionConfig | undefined;
    const result = await runAgent({
      name: AGENT,
      prompt: "hi",
      agentsRoot: root,
      taskBinding: binding(PR),
      sessionFactory: async (c) => {
        config = c;
        return scriptedSession();
      },
    });
    expect(result.exitCode).toBe(0);
    expect(config?.prMemory).toBeUndefined();
  });

  it("no pr_ref: memory is off", async () => {
    const stub = await startMemoryStub();
    stubs.push(stub);
    scaffold(root, stub.url, keyFile);
    let config: RunSessionConfig | undefined;
    await runAgent({
      name: AGENT,
      prompt: "hi",
      agentsRoot: root,
      sessionFactory: async (c) => {
        config = c;
        return scriptedSession();
      },
    });
    expect(config?.prMemory).toBeUndefined();
    expect(stub.store.size).toBe(0);
  });
});
