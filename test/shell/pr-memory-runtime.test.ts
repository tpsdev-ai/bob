import { afterEach, beforeEach, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWriteToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TaskBinding } from "../../src/capabilities/work/task-binding.js";
import { PR_MEMORY_PROMPT_HEADING, prMemoryKey } from "../../src/shell/pr-memory.js";
import { type RunSession, runAgent } from "../../src/shell/run.js";
import { makeFakeFlair } from "./flair-fake.js";

const AGENT = "testbot";
const REPO = "github.com/tpsdev-ai/bob";
const PR = 185;
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
let savedFetch: typeof fetch;
let fake = makeFakeFlair();
// The one round record written for this PR.
function roundContent(): { rounds: Array<{ outcome: string; files_touched: string[] }> } {
  const prefix = `${prMemoryKey(AGENT, REPO, PR)}-r`;
  const records = [...fake.memories.values()].filter((r) => String(r.id).startsWith(prefix));
  expect(records).toHaveLength(1);
  return JSON.parse(String(records[0]?.content));
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-prmem-runtime-"));
  keyFile = join(root, "key");
  writeFileSync(
    keyFile,
    generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  scaffold(root, "http://flair.test", keyFile);
  savedFetch = globalThis.fetch;
  fake = makeFakeFlair({ agents: { [AGENT]: { id: AGENT } } });
  globalThis.fetch = (async (url, init) => {
    if (new URL(String(url)).pathname === "/BootstrapMemories")
      return new Response('{"context":""}');
    const r = await fake.fetchImpl(String(url), {
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    return new Response(await r.text(), { status: r.status });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = savedFetch;
  rmSync(root, { recursive: true, force: true });
});

it.each([
  { repository: "https://github.com/tpsdev-ai/bob", number: PR },
  { repository: "GitHub.com/tpsdev-ai/bob", number: PR },
  { repository: REPO, number: 0 },
  { repository: REPO, number: 1.5 },
  { repository: REPO, number: Number.MAX_SAFE_INTEGER + 1 },
])("refuses programmatic pr_ref %j before fetching or constructing a session", async (pr_ref) => {
  const requests: string[] = [];
  let constructed = false;
  globalThis.fetch = (async (url) => {
    requests.push(String(url));
    return new Response("{}");
  }) as typeof fetch;
  await expect(
    runAgent({
      name: AGENT,
      prompt: "round",
      agentsRoot: root,
      taskBinding: { ...binding(PR), pr_ref },
      sessionFactory: async () => {
        constructed = true;
        throw new Error("unexpected session construction");
      },
    }),
  ).rejects.toThrow(/pr_ref/);
  expect(requests).toEqual([]);
  expect(constructed).toBe(false);
});

it.each(["bootstrap", "factory"])("records a pre-session abort during %s", async (stage) => {
  const normalFetch = globalThis.fetch;
  if (stage === "bootstrap")
    globalThis.fetch = (async (url, init) =>
      String(url).endsWith("/BootstrapMemories")
        ? new Promise<Response>(() => {})
        : normalFetch(url, init)) as typeof fetch;
  const result = await runAgent({
    name: AGENT,
    prompt: "abort",
    agentsRoot: root,
    taskBinding: binding(PR),
    wallClockMs: 30,
    sessionFactory: async () => new Promise<RunSession>(() => {}),
  });
  globalThis.fetch = normalFetch;
  expect(result.aborted).toBeDefined();
  expect(roundContent().rounds[0]?.outcome).toBe("aborted");
});

it("keeps both actual session prompts free of recall and records only verified paths", async () => {
  const prompts: string[] = [];
  const configs: Array<string | undefined> = [];
  for (const prompt of ["round N", "round N+1"])
    await runAgent({
      name: AGENT,
      prompt,
      agentsRoot: root,
      taskBinding: binding(PR),
      sessionFactory: async (config) => {
        configs.push(config.prMemory);
        const listeners: Array<(event: unknown) => void> = [];
        return {
          subscribe(l) {
            listeners.push(l);
            return () => {};
          },
          async prompt(text) {
            prompts.push(text);
            for (const [id, args] of [
              ["bad", { path: "unverified.ts" }],
              ["good", { path: "verified.ts", content: "written" }],
            ] as const)
              for (const listener of listeners)
                listener({ type: "tool_execution_start", toolName: "write", toolCallId: id, args });
            const result = await createWriteToolDefinition(join(root, AGENT, "work")).execute(
              "good",
              { path: "verified.ts", content: "written" },
            );
            expect(readFileSync(join(root, AGENT, "work", "verified.ts"), "utf8")).toBe("written");
            for (const [id, resultValue] of [
              ["good", result],
              ["bad", {}],
            ] as const)
              for (const listener of listeners)
                listener({
                  type: "tool_execution_end",
                  toolName: "write",
                  toolCallId: id,
                  isError: false,
                  result: resultValue,
                });
          },
          dispose() {},
        };
      },
    });
  expect(configs[0]).toBeUndefined();
  expect(configs[1]).toContain(PR_MEMORY_PROMPT_HEADING);
  expect(prompts).toEqual(["round N", "round N+1"]);
  for (const prompt of prompts) {
    expect(prompt).not.toContain(PR_MEMORY_PROMPT_HEADING);
    expect(prompt).not.toContain("<<<BOB-PR-MEMORY>>>");
  }
  const prefix = `${prMemoryKey(AGENT, REPO, PR)}-r`;
  const records = [...fake.memories.values()].filter((r) => String(r.id).startsWith(prefix));
  expect(records).toHaveLength(2);
  for (const r of records)
    expect(JSON.parse(String(r.content)).rounds[0].files_touched).toEqual(["verified.ts"]);
});
