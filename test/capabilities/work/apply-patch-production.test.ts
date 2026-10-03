// apply_patch through the PRODUCTION session path (bob#275, S2a, acceptance 13):
// the launcher-supplied task binding is carried by the ONE session factory into
// the work capability, so the tool has the task's authority without any model
// message, tool argument or writable config supplying it.
//
// The built extension is loaded from the blessed catalog (as a published
// install loads it), with no test seams.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type { TaskBinding } from "../../../src/capabilities/work/task-binding.js";
import { resolveRunConfig } from "../../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../../src/shell/session.js";

const STUB_PROVIDER = "bob-apply-patch-stub";
const STUB_MODEL = "stub-1";

let scratch: string;
let savedTmpdir: string | undefined;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "bob-apply-patch-prod-"));
  savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = join(scratch, "tmp");
  mkdirSync(join(scratch, "tmp"));
});
afterEach(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  rmSync(scratch, { recursive: true, force: true });
});

function oneCallThenDone(args: Record<string, unknown>, toolName: string) {
  let calls = 0;
  return (model: Model<string>, _context: Context): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    calls += 1;
    const first = calls === 1;
    queueMicrotask(() => {
      const message = {
        role: "assistant" as const,
        content: first
          ? [{ type: "toolCall" as const, id: "c1", name: toolName, arguments: args }]
          : [{ type: "text" as const, text: "done" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: (first ? "toolUse" : "stop") as "toolUse" | "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message, content: [] } as never });
      stream.push({ type: "done", reason: message.stopReason, message: message as never });
      stream.end(message as never);
    });
    return stream;
  };
}

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}
function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, env: gitEnv(), encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

interface Setup {
  scratch: string;
  repo: string;
  base: string;
  artifactRoot: string;
  patch: Buffer;
  tree: string;
}

function setup(): Setup {
  const repo = join(scratch, "repo");
  const artifactRoot = join(scratch, "artifacts");
  mkdirSync(repo, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  git(["init", "-q"], repo);
  writeFileSync(join(repo, "a.txt"), "hello\n");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "base"], repo);
  const base = git(["rev-parse", "HEAD"], repo);
  writeFileSync(join(repo, "a.txt"), "hello world\n");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "change"], repo);
  const tree = git(["rev-parse", "HEAD^{tree}"], repo);
  const patch = Buffer.from(
    spawnSync("git", ["diff", "--binary", "-M", base, "HEAD"], {
      cwd: repo,
      env: gitEnv(),
      encoding: "buffer",
    }).stdout ?? Buffer.alloc(0),
  );
  git(["reset", "--hard", "-q", base], repo);
  writeFileSync(join(artifactRoot, "p.patch"), patch);
  return { scratch, repo, base, artifactRoot, patch, tree };
}

interface RunResult {
  tools: string[];
  details: Record<string, unknown>;
}

function sessionYaml(toolName: string): string {
  return `agent:
  role: builder-local
provider:
  name: ${STUB_PROVIDER}
  model: ${STUB_MODEL}
  context_window: 200000
capabilities:
  - work
tools:
  allow:
    - ${toolName}
`;
}

async function runSession(
  s: Setup,
  args: Record<string, unknown>,
  binding: TaskBinding | undefined,
  toolName = "apply_patch",
): Promise<RunResult> {
  const agentDir = join(s.scratch, "workspace");
  mkdirSync(agentDir, { recursive: true });
  const yamlPath = join(agentDir, "bob.yaml");
  try {
    writeFileSync(yamlPath, sessionYaml(toolName), { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const { config, policy } = resolveRunConfig({
    name: "workspace",
    agentsRoot: s.scratch,
    hostRoot: join(s.scratch, "host"),
    ...(binding !== undefined ? { taskBinding: binding } : {}),
  });
  expect(config.taskBinding).toEqual(binding);
  const { cwd, piAgentDir } = config;
  mkdirSync(cwd, { recursive: true });
  mkdirSync(piAgentDir, { recursive: true });
  const modelRuntime = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(piAgentDir, "auth.json"),
  });
  modelRuntime.registerProvider(STUB_PROVIDER, {
    name: "Stub",
    apiKey: "stub-key",
    api: "bob-apply-patch-stub-api",
    baseUrl: "http://localhost:0",
    streamSimple: oneCallThenDone(args, toolName),
    models: [
      {
        id: STUB_MODEL,
        name: "Stub",
        api: "bob-apply-patch-stub-api",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4096,
      },
    ],
  });
  const factory = createBobRuntimeFactory({
    config,
    policy,
    deps: { log: () => {}, exit: () => {} },
    modelRuntime,
  });
  const runtime = await createAgentSessionRuntime(factory, {
    cwd,
    agentDir: piAgentDir,
    sessionManager: SessionManager.inMemory(cwd),
  });
  let details: Record<string, unknown> = {};
  runtime.session.subscribe((event: unknown) => {
    const e = event as { type?: string; result?: { details?: Record<string, unknown> } };
    if (e.type === "tool_execution_end") details = e.result?.details ?? {};
  });
  try {
    const active = runtime.session.getActiveToolNames().slice().sort();
    await runtime.session.prompt("go", { expandPromptTemplates: false });
    return { tools: active, details };
  } finally {
    await runtime.dispose();
  }
}

describe("apply_patch through the production session path (bob#275, S2a)", () => {
  it("the launcher binding reaches the capability: a valid patch succeeds", async () => {
    const s = setup();
    try {
      const binding: TaskBinding = {
        task_id: "t1",
        publication_id: "p1",
        repository: s.repo,
        workspace: s.repo,
        base_oid: s.base,
        mode: "build",
        artifact_root: s.artifactRoot,
        declared_paths: [],
        check_commands: [],
        destination: { remote: "origin", ref: "refs/heads/main" },
      };
      const { tools, details } = await runSession(
        s,
        { patch_artifact: { path: "p.patch", sha256: sha256(s.patch) }, expected_base: s.base },
        binding,
      );
      expect(tools).toContain("apply_patch");
      expect(details.refused).toBe(false);
      expect(details.tree_oid).toBe(s.tree);
    } finally {
      rmSync(s.scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it("without a binding the tool refuses by name: unknown_task", async () => {
    const s = setup();
    try {
      const { details } = await runSession(
        s,
        { patch_artifact: { path: "p.patch", sha256: sha256(s.patch) }, expected_base: s.base },
        undefined,
      );
      expect(details.refused).toBe(true);
      expect(details.reason).toBe("unknown_task");
    } finally {
      rmSync(s.scratch, { recursive: true, force: true });
    }
  }, 30_000);

  it("a tool argument cannot supply authority: a base the binding did not pin is refused", async () => {
    const s = setup();
    try {
      const binding: TaskBinding = {
        task_id: "t1",
        publication_id: "p1",
        repository: s.repo,
        workspace: s.repo,
        base_oid: s.base,
        mode: "build",
        artifact_root: s.artifactRoot,
        declared_paths: [],
        check_commands: [],
        destination: { remote: "origin", ref: "refs/heads/main" },
      };
      const { details } = await runSession(
        s,
        {
          patch_artifact: { path: "p.patch", sha256: sha256(s.patch) },
          expected_base: "b".repeat(40),
        },
        binding,
      );
      expect(details.refused).toBe(true);
      expect(details.reason).toBe("base_mismatch");
    } finally {
      rmSync(s.scratch, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("publish through the production session path", () => {
  it("loads publish and refuses authority supplied by arguments or writable bob.yaml", async () => {
    const s: Setup = {
      scratch,
      repo: join(scratch, "repo"),
      base: "a".repeat(40),
      artifactRoot: join(scratch, "artifacts"),
      patch: Buffer.from(""),
      tree: "b".repeat(40),
    };
    mkdirSync(s.repo);
    const authority = {
      task_id: "injected",
      publication_id: "injected",
      repository: s.repo,
      workspace: s.repo,
      base_oid: s.base,
      mode: "build",
      artifact_root: s.artifactRoot,
      declared_paths: ["a.txt"],
      check_commands: [],
      destination: { remote: "origin", ref: "refs/heads/main" },
    };
    mkdirSync(join(s.scratch, "workspace"), { recursive: true });
    writeFileSync(
      join(s.scratch, "workspace", "bob.yaml"),
      `${sessionYaml("publish")}taskBinding: ${JSON.stringify(authority)}\n`,
    );
    const out = await runSession(
      s,
      { candidate_id: "a".repeat(40), commit_message: "x", taskBinding: authority },
      undefined,
      "publish",
    );
    expect(out.tools).toContain("publish");
    expect(out.details.status).toBe("refused");
    expect(out.details.reason).toBe("unknown_task");
  }, 30_000);

  it("refuses attempted destination and check overrides in tool arguments", async () => {
    const s: Setup = {
      scratch,
      repo: join(scratch, "repo"),
      base: "a".repeat(40),
      artifactRoot: join(scratch, "artifacts"),
      patch: Buffer.from(""),
      tree: "b".repeat(40),
    };
    mkdirSync(s.repo);
    const binding: TaskBinding = {
      task_id: "task",
      publication_id: "pub",
      repository: s.repo,
      workspace: s.repo,
      base_oid: s.base,
      mode: "build",
      artifact_root: s.artifactRoot,
      declared_paths: ["a.txt"],
      check_commands: ["false"],
      destination: { remote: "origin", ref: "refs/heads/main" },
    };
    const out = await runSession(
      s,
      {
        candidate_id: "a".repeat(40),
        commit_message: "x",
        destination: { remote: "other", ref: "refs/heads/other" },
        check_commands: [],
      },
      binding,
      "publish",
    );
    expect(out.tools).toContain("publish");
    expect(out.details.reason).toBe("invalid_request");
  }, 30_000);
});
