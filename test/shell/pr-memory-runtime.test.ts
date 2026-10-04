import { afterEach, beforeEach, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskBinding } from "../../src/capabilities/work/task-binding.js";
import { PR_MEMORY_PROMPT_HEADING, prMemoryKey } from "../../src/shell/pr-memory.js";
import { type RunSession, runAgent } from "../../src/shell/run.js";

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
const store = new Map<string, string>();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-prmem-runtime-"));
  keyFile = join(root, "key");
  writeFileSync(
    keyFile,
    generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }),
  );
  scaffold(root, "http://flair.test", keyFile);
  savedFetch = globalThis.fetch;
  store.clear();
  globalThis.fetch = (async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/BootstrapMemories") return new Response('{"context":""}');
    if (init?.method === "PUT") {
      store.set(path, String(init.body));
      return new Response("{}");
    }
    return new Response(store.get(path) ?? "{}", { status: store.has(path) ? 200 : 404 });
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
  store.clear();
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
  const record = JSON.parse(store.get(`/Memory/${prMemoryKey(AGENT, REPO, PR)}`) ?? "{}");
  expect(JSON.parse(record.content).rounds[0].outcome).toBe("aborted");
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
            for (const listener of listeners)
              listener({
                type: "tool_execution_end",
                toolName: "edit",
                isError: false,
                result: {},
                args: { path: "unverified.ts" },
              });
            for (const listener of listeners)
              listener({
                type: "tool_execution_end",
                toolName: "edit",
                isError: false,
                result: { details: { diff: "+a" }, content: [{ type: "text", text: "edited" }] },
                args: { path: "verified.ts" },
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
  const record = JSON.parse(store.get(`/Memory/${prMemoryKey(AGENT, REPO, PR)}`) ?? "{}");
  expect(JSON.parse(record.content).rounds[0].files_touched).toEqual(["verified.ts"]);
});
