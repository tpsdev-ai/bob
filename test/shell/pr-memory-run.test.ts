// bob#185 item 5 — the runtime entry path. Stands up a REAL local HTTP stub as
// Flair (so the real HTTP + Ed25519 signing path runs) and runs `bob run`
// twice: round N writes the memory, round N+1 recalls it into the factory's
// config before the first model request (recall is a Flair bootstrap request,
// a memory GET and a memory listing), with nothing pasted into either brief.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskBinding } from "../../src/capabilities/work/task-binding.js";
import {
  PR_MEMORY_PROMPT_HEADING,
  PR_MEMORY_START_TIMEOUT_MS,
  prMemoryKey,
  recallPrMemoryRound,
} from "../../src/shell/pr-memory.js";
import { type RunSession, type RunSessionConfig, runAgent } from "../../src/shell/run.js";
import type { RunTimer } from "../../src/shell/run-bounds.js";
import { makeFakeFlair } from "./flair-fake.js";

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
  memories: Map<string, Record<string, unknown>>;
  close(): Promise<void>;
}

// Serves the shared fake Flair (by-id GET/PUT, the Memory listing, DELETE)
// over real HTTP, plus an empty bootstrap.
async function startMemoryStub(): Promise<Stub> {
  const fake = makeFakeFlair({ agents: { [AGENT]: { id: AGENT } } });
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", async () => {
      const send = (status: number, body: string): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body);
      };
      if (req.url === "/BootstrapMemories") return send(200, JSON.stringify({ context: "" }));
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers[k] = v;
      const r = await fake.fetchImpl(`http://stub${req.url ?? ""}`, {
        method: req.method ?? "",
        headers,
        ...(raw !== "" ? { body: raw } : {}),
      });
      send(r.status, await r.text());
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    memories: fake.memories,
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

// A timer seam whose wall-clock callback the test fires on demand (bob#135's
// seam): the run never times out on its own, so a test ends it at the moment
// it chooses.
function captureWallClock(): { timer: RunTimer; fire: () => void } {
  let wall: (() => void) | undefined;
  const timer: RunTimer = {
    setTimeout(callback) {
      if (wall === undefined) wall = callback;
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout() {},
  };
  return { timer, fire: () => wall?.() };
}

// Capture what a run writes to stderr, without touching the real stream. `fn`
// can read what has been captured so far.
async function captureStderr(fn: (seen: () => string) => Promise<void>): Promise<string> {
  let out = "";
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    out += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn(() => out);
  } finally {
    process.stderr.write = original;
  }
  return out;
}

// A recall row that carries one valid round and an `expiresAt`, so the recall's
// post-fetch validation reads the clock (its `now()` seam).
function recallRow(key: string): Record<string, unknown> {
  return {
    id: `${key}-r1-a`,
    agentId: AGENT,
    subject: key,
    visibility: "private",
    durability: "persistent",
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2099-01-01T00:00:00.000Z",
    content: JSON.stringify({
      v: 1,
      agentId: AGENT,
      repository: REPO,
      prNumber: PR,
      open_findings: [],
      rounds: [
        {
          endedAt: "2026-01-01T00:00:00.000Z",
          outcome: "completed",
          blockers_addressed: [],
          files_touched: [],
          test_evidence: [],
          incomplete: [],
          omitted: [],
        },
      ],
      omitted: [],
    }),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-prmem-run-"));
  keyFile = writeKeyFile(root);
});
afterEach(async () => {
  for (const s of stubs.splice(0)) await s.close();
  rmSync(root, { recursive: true, force: true });
});

describe("`bob run` with a launcher pr_ref", () => {
  it("round N writes, round N+1 recalls", async () => {
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

    // The round-end write landed a private, persistent record of its own.
    const records = [...stub.memories.values()];
    expect(records).toHaveLength(1);
    const record = records[0] as Record<string, unknown>;
    expect(String(record.id).startsWith(`${ID}-r`)).toBe(true);
    expect(record.visibility).toBe("private");
    expect(record.durability).toBe("persistent");
    expect(record.tags).toEqual(["bob-pr-round"]);
    expect(record.subject).toBe(ID);

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
    expect(stub.memories.size).toBe(0);
  });
});

// bob#319 — the recall runs under the run's cancellation guard, with the run's
// abort signal, and the run is checked again between recall and session
// construction. A run terminated while recall is in flight cancels the recall
// request; a termination detected after recall returns prevents the session
// factory from being invoked.
describe("`bob run` recall under the run's cancellation guard (bob#319)", () => {
  it("a run terminated while recall is in flight aborts the recall request and builds no session", async () => {
    scaffold(root, "http://127.0.0.1:1", keyFile); // no Flair is listening
    const wall = captureWallClock();
    const started = Date.now();
    const state = { aborts: 0, firstAbortMs: Number.POSITIVE_INFINITY };
    // Hold the two recall requests (the by-id read and the listing) and report
    // the abort the run's signal delivers to them; serve the round-end write and
    // the prune listing so the run can finish.
    const fetchImpl = ((url: string, init: { method?: string; signal?: AbortSignal }) =>
      new Promise((resolve, reject) => {
        if (init.method === "PUT") {
          resolve({ ok: true, status: 200, text: async () => JSON.stringify({ id: "x" }) });
          return;
        }
        if (url.includes("limit(3,")) {
          resolve({ ok: true, status: 200, text: async () => "[]" });
          return;
        }
        const signal = init.signal;
        const onAbort = (): void => {
          state.aborts += 1;
          state.firstAbortMs = Math.min(state.firstAbortMs, Date.now() - started);
          reject(new Error("aborted"));
        };
        if (signal === undefined) return;
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        wall.fire(); // the run's bound fires while this request is in flight
      })) as never;

    let factoryCalls = 0;
    let result: Awaited<ReturnType<typeof runAgent>> | undefined;
    const stderr = await captureStderr(async () => {
      result = await runAgent({
        name: AGENT,
        prompt: "hi",
        agentsRoot: root,
        taskBinding: binding(PR),
        prMemorySeams: { fetchImpl },
        wallClockMs: 60_000,
        noProgressMs: 60_000,
        timer: wall.timer,
        sessionFactory: async () => {
          factoryCalls += 1;
          return scriptedSession();
        },
      });
    });
    expect(result?.exitCode).toBe(1);
    expect(result?.aborted).toBe("wall_clock");
    expect(factoryCalls).toBe(0);
    // The recall's request was aborted by the run's signal, promptly (never by
    // its own two-second timeout).
    expect(state.aborts).toBeGreaterThan(0);
    expect(state.firstAbortMs).toBeLessThan(1000);
    expect(stderr).toContain("the run was terminated");
  }, 15_000);

  it("a run terminated after recall returns, before the session factory is invoked, does not invoke it", async () => {
    scaffold(root, "http://127.0.0.1:1", keyFile);
    const wall = captureWallClock();
    const row = recallRow(ID);
    const state = { served: 0, scheduled: false };
    const fetchImpl = ((url: string, init: { method?: string }) => {
      state.served += 1;
      return Promise.resolve(
        init.method === "PUT"
          ? { ok: true, status: 200, text: async () => JSON.stringify({ id: "x" }) }
          : url.includes("limit(3,")
            ? { ok: true, status: 200, text: async () => "[]" }
            : url.includes("?")
              ? { ok: true, status: 200, text: async () => JSON.stringify([row]) }
              : { ok: false, status: 404, text: async () => "not found" },
      );
    }) as never;
    // Both recall requests have been served by the time recall validates their
    // results, synchronously. The validation's clock callback (`now()`) schedules
    // the bound's termination through queued microtasks, which places it after
    // the guard resolves and before the session factory is invoked.
    const now = (): number => {
      if (state.served >= 2 && !state.scheduled) {
        state.scheduled = true;
        queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => wall.fire())));
      }
      return 1_700_000_000_000;
    };

    let factoryCalls = 0;
    const result = await runAgent({
      name: AGENT,
      prompt: "hi",
      agentsRoot: root,
      taskBinding: binding(PR),
      prMemorySeams: { fetchImpl, now },
      wallClockMs: 60_000,
      noProgressMs: 60_000,
      timer: wall.timer,
      sessionFactory: async () => {
        factoryCalls += 1;
        return scriptedSession();
      },
    });
    expect(result.exitCode).toBe(1);
    expect(result.aborted).toBe("wall_clock");
    expect(factoryCalls).toBe(0);
  }, 15_000);

  it("a live run whose recall fails still builds its session once", async () => {
    scaffold(root, "http://127.0.0.1:1", keyFile);
    const fetchImpl = ((url: string, init: { method?: string }) =>
      init.method === "PUT"
        ? Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify({ id: "x" }) })
        : url.includes("limit(3,")
          ? Promise.resolve({ ok: true, status: 200, text: async () => "[]" })
          : Promise.reject(new Error("network down"))) as never;
    let factoryCalls = 0;
    let seen: RunSessionConfig | undefined;
    const result = await runAgent({
      name: AGENT,
      prompt: "hi",
      agentsRoot: root,
      taskBinding: binding(PR),
      prMemorySeams: { fetchImpl },
      wallClockMs: 60_000,
      noProgressMs: 60_000,
      sessionFactory: async (c) => {
        factoryCalls += 1;
        seen = c;
        return scriptedSession();
      },
    });
    expect(result.exitCode).toBe(0);
    expect(factoryCalls).toBe(1);
    expect(seen?.prMemory).toBeUndefined();
  }, 15_000);

  it("a recall cancelled by the caller's signal resolves as unavailable", async () => {
    scaffold(root, "http://127.0.0.1:1", keyFile);
    const controller = new AbortController();
    const fetchImpl = ((_url: string, init: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal;
        const onAbort = (): void => reject(new Error("aborted"));
        if (signal === undefined) return;
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      })) as never;
    const pending = recallPrMemoryRound({
      target: { url: "http://127.0.0.1:1", agentId: AGENT, keyFile },
      ref: { repository: REPO, number: PR },
      identity: { agentId: AGENT, repository: REPO, prNumber: PR },
      seams: { fetchImpl },
      signal: controller.signal,
    });
    controller.abort();
    const recalled = await pending;
    expect(recalled.status).toBe("unavailable");
    expect(recalled.reason).toBe("the run was terminated");
  }, 15_000);
});

// Polls `ready` every 10 ms until it holds or the clock passes `deadline`.
async function waitUntil(ready: () => boolean, deadline: number): Promise<void> {
  while (!ready() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// bob#319 over real HTTP: a local server stands in for Flair, and the recall's
// requests go through the client's real fetch with the run's composed signal
// (the fetch seam passes each call to the global fetch and counts the recall
// responses whose headers arrived). The server holds both recall
// requests, before their headers or after their headers and part of their
// bodies, and the run's bound fires while they are held.
describe("`bob run` recall cancelled over real HTTP (bob#319)", () => {
  for (const phase of ["awaiting response headers", "reading a response body"] as const) {
    it(`a run terminated while recall is ${phase} aborts both held requests and does not invoke the session factory`, async () => {
      const wall = captureWallClock();
      let firedAt = Number.NaN;
      const fire = (): void => {
        firedAt = Date.now();
        wall.fire();
      };
      const isRecall = (method: string | undefined, url: string): boolean =>
        method === "GET" && url.includes("/Memory/") && !url.includes("limit(3,");
      // Milliseconds from the bound firing to the server seeing each held
      // request's socket close.
      const closedAfterFire: number[] = [];
      let held = 0;
      const server = createServer((req, res) => {
        const url = req.url ?? "";
        if (isRecall(req.method, url)) {
          // One of the two recall requests (the by-id read or the listing): hold
          // it. Its request stream is not resumed: under Bun, resuming it
          // suppresses the socket close event observed here.
          req.socket.once("close", () => closedAfterFire.push(Date.now() - firedAt));
          if (phase === "reading a response body") {
            res.writeHead(200, { "content-type": "application/json" });
            res.write('{"id":"'); // part of a body that never finishes
          }
          held += 1;
          if (phase === "awaiting response headers" && held === 2) setTimeout(fire, 50);
          return;
        }
        req.resume();
        req.on("end", () => {
          const send = (status: number, body: string): void => {
            res.writeHead(status, { "content-type": "application/json" });
            res.end(body);
          };
          if (url === "/BootstrapMemories") return send(200, JSON.stringify({ context: "" }));
          if (req.method === "PUT") return send(200, JSON.stringify({ id: "x" }));
          if (url.includes("limit(3,")) return send(200, "[]");
          send(404, "not found");
        });
      });
      let headersSeen = 0;
      const fetchImpl = ((url: string, init: { method?: string }) =>
        fetch(url, init as RequestInit).then((res) => {
          if (isRecall(init.method, url)) {
            headersSeen += 1;
            if (phase === "reading a response body" && headersSeen === 2) setTimeout(fire, 50);
          }
          return res;
        })) as never;
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing server port");
        scaffold(root, `http://127.0.0.1:${address.port}`, keyFile);

        let factoryCalls = 0;
        let result: Awaited<ReturnType<typeof runAgent>> | undefined;
        const unavailable = "PR memory unavailable at start (the run was terminated).";
        const stderr = await captureStderr(async (seen) => {
          result = await runAgent({
            name: AGENT,
            prompt: "hi",
            agentsRoot: root,
            taskBinding: binding(PR),
            prMemorySeams: { fetchImpl },
            wallClockMs: 60_000,
            noProgressMs: 60_000,
            timer: wall.timer,
            sessionFactory: async () => {
              factoryCalls += 1;
              return scriptedSession();
            },
          });
          // Wait for both closes and the recall's report, up to half the
          // requests' own deadline after the bound fired.
          await waitUntil(
            () => closedAfterFire.length === 2 && seen().includes(unavailable),
            firedAt + PR_MEMORY_START_TIMEOUT_MS / 2,
          );
        });
        expect(result?.exitCode).toBe(1);
        expect(result?.aborted).toBe("wall_clock");
        expect(factoryCalls).toBe(0);
        expect(held).toBe(2);
        expect(headersSeen).toBe(phase === "awaiting response headers" ? 0 : 2);
        // The run's signal aborted both requests: the server saw each socket
        // close well before the requests' own deadline would have aborted them.
        expect(closedAfterFire).toHaveLength(2);
        for (const ms of closedAfterFire) expect(ms).toBeLessThan(PR_MEMORY_START_TIMEOUT_MS / 2);
        expect(stderr).toContain(unavailable);
      } finally {
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }, 15_000);
  }
});
