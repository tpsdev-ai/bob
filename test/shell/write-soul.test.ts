// write_soul — the bob-owned, soul-ONLY setup write (bob#204).
//
// Two layers are pinned:
//   1. the TOOL CORE (write-soul.ts) against a fake PiLike — it takes content
//      only, targets bob's resolved soul.md, refuses a path argument, refuses a
//      symlinked soul.md or a symlinked agent dir, enforces the size cap, and
//      writes atomically;
//   2. a REAL pi setup session (through bob's ONE factory, stub model): the
//      setup policy activates read + write_soul and NOT pi's generic `write`,
//      the registered tool's schema has no path, and executing it writes
//      soul.md.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { initAgent } from "../../src/shell/init.js";
import { resolveRunConfig } from "../../src/shell/run.js";
import { createBobRuntimeFactory, SETUP_TOOL_POLICY } from "../../src/shell/session.js";
import {
  createWriteSoulExtension,
  MAX_SOUL_BYTES,
  type SoulToolOutput,
  type SoulWritePi,
  WRITE_SOUL_TOOL,
  wireSoulWrite,
} from "../../src/shell/write-soul.js";

// ─── Layer 1: the tool core, with a fake PiLike ──────────────────────────────

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  parameters: { type?: string; properties?: Record<string, unknown> };
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: unknown,
  ) => Promise<SoulToolOutput>;
}

function firstText(res: SoulToolOutput): string {
  return res.content[0]?.text ?? "";
}

function wire(soulPath: string): CapturedTool {
  let tool: CapturedTool | undefined;
  const pi: SoulWritePi = {
    registerTool(t) {
      tool = t as unknown as CapturedTool;
    },
  };
  wireSoulWrite(pi, soulPath);
  if (!tool) throw new Error("write_soul was not registered");
  return tool;
}

describe("write_soul tool core", () => {
  let dir: string;
  let agentDir: string;
  let soulPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bob-write-soul-"));
    agentDir = join(dir, "testbot");
    mkdirSync(agentDir, { recursive: true });
    soulPath = join(agentDir, "soul.md");
    writeFileSync(soulPath, "seed persona\n");
    writeFileSync(join(agentDir, "bob.yaml"), "agent:\n  id: testbot\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("registers a tool named write_soul that takes CONTENT ONLY (no path parameter)", () => {
    const tool = wire(soulPath);
    expect(tool.name).toBe(WRITE_SOUL_TOOL);
    expect(tool.name).toBe("write_soul");
    const props = Object.keys(tool.parameters.properties ?? {});
    expect(props).toEqual(["content"]);
    expect(props).not.toContain("path");
  });

  it("writes the content to bob's resolved soul.md, and leaves no temp file behind", async () => {
    const tool = wire(soulPath);
    const res = await tool.execute("c1", { content: "# Testbot\n\nRefined.\n" });
    expect(res.details.refused).toBeUndefined();
    expect(firstText(res)).toContain("Wrote");
    expect(readFileSync(soulPath, "utf-8")).toBe("# Testbot\n\nRefined.\n");
    // The atomic-write temp file is renamed away, not left in the agent dir.
    expect(readdirSync(agentDir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("refuses a path argument BY NAME and never writes the named file (absolute path outside the agent dir)", async () => {
    const tool = wire(soulPath);
    const outside = join(dir, "outside.md");
    const res = await tool.execute("c1", { content: "x", path: outside });
    expect(res.details.refused).toBe(true);
    expect(firstText(res)).toContain("no path");
    expect(existsSync(outside)).toBe(false);
    // soul.md is untouched too — a refused call writes nothing at all.
    expect(readFileSync(soulPath, "utf-8")).toBe("seed persona\n");
  });

  it("cannot be aimed at bob.yaml via a `file`/`target`/`..` argument either", async () => {
    const tool = wire(soulPath);
    for (const key of ["file", "target", "file_path", "filename"]) {
      const res = await tool.execute("c1", { content: "x", [key]: join(agentDir, "bob.yaml") });
      expect(res.details.refused).toBe(true);
    }
    // A traversal value is refused the same way — it is a path argument, full stop.
    const traversal = await tool.execute("c1", { content: "x", path: "../bob.yaml" });
    expect(traversal.details.refused).toBe(true);
    expect(readFileSync(join(agentDir, "bob.yaml"), "utf-8")).toBe("agent:\n  id: testbot\n");
  });

  it("refuses a SYMLINKED soul.md (it must not follow the link out of the agent dir)", async () => {
    const tool = wire(soulPath);
    const victim = join(dir, "victim.md");
    writeFileSync(victim, "do not touch\n");
    rmSync(soulPath);
    symlinkSync(victim, soulPath);
    const res = await tool.execute("c1", { content: "# redirected\n" });
    expect(res.details.refused).toBe(true);
    expect(firstText(res)).toContain("symlink");
    expect(readFileSync(victim, "utf-8")).toBe("do not touch\n");
  });

  it("refuses a SYMLINKED agent directory", async () => {
    // Point the tool at a soul.md whose parent dir is a symlink.
    const linkDir = join(dir, "agent-link");
    symlinkSync(agentDir, linkDir);
    const tool = wire(join(linkDir, "soul.md"));
    const res = await tool.execute("c1", { content: "x" });
    expect(res.details.refused).toBe(true);
    expect(firstText(res)).toContain("symlink");
    expect(readFileSync(soulPath, "utf-8")).toBe("seed persona\n");
  });

  it("enforces the size cap and writes nothing when over it", async () => {
    const tool = wire(soulPath);
    const res = await tool.execute("c1", { content: "x".repeat(MAX_SOUL_BYTES + 1) });
    expect(res.details.refused).toBe(true);
    expect(firstText(res)).toContain(String(MAX_SOUL_BYTES));
    expect(readFileSync(soulPath, "utf-8")).toBe("seed persona\n");
  });

  it("the inline extension registers write_soul bound to the given path", () => {
    const ext = createWriteSoulExtension(soulPath);
    expect(ext.name).toBe("bob-write-soul");
    expect(ext.hidden).toBe(true);
    let name = "";
    (ext.factory as (pi: unknown) => void)({
      registerTool: (t: { name: string }) => {
        name = t.name;
      },
    });
    expect(name).toBe("write_soul");
  });
});

// ─── Layer 2: a REAL pi setup session ────────────────────────────────────────

const STUB_PROVIDER = "bob-stub";
const STUB_MODEL = "stub-1";

async function stubRuntime() {
  const runtime = await ModelRuntime.create({ modelsPath: null });
  runtime.registerProvider(STUB_PROVIDER, {
    name: "Bob Stub",
    apiKey: "stub-key",
    api: "bob-stub-api",
    baseUrl: "http://localhost:0",
    streamSimple: () => {
      throw new Error("the setup-session tests never run a model turn");
    },
    models: [
      {
        id: STUB_MODEL,
        name: "Stub",
        api: "bob-stub-api",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200_000,
        maxTokens: 4096,
      },
    ],
  });
  return runtime;
}

describe("setup session gets write_soul and never pi's write", () => {
  let root: string;
  let agentsRoot: string;
  let agentDir: string;
  let cwd: string;
  let piAgentDir: string;
  let soulPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-soul-session-"));
    agentsRoot = join(root, "agents");
    const res = initAgent({
      name: "testbot",
      role: "ea",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      agentsRoot,
      flairKeysDir: join(root, ".flair", "keys"),
      skipFlair: true,
    });
    agentDir = res.agentDir;
    cwd = join(agentDir, "work");
    piAgentDir = join(agentDir, ".pi-agent");
    soulPath = join(agentDir, "soul.md");
    writeFileSync(soulPath, "seed persona\n");
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function buildSession(
    opts: { setupSoulPath?: string; policy?: typeof SETUP_TOOL_POLICY } = {},
  ) {
    const runtime = await stubRuntime();
    const base = resolveRunConfig({ name: "testbot", agentsRoot }).config;
    const factory = createBobRuntimeFactory({
      config: {
        ...base,
        provider: STUB_PROVIDER,
        model: STUB_MODEL,
        extensionSources: [],
        ...(opts.setupSoulPath !== undefined ? { setupSoulPath: opts.setupSoulPath } : {}),
      },
      policy: opts.policy ?? SETUP_TOOL_POLICY,
      deps: { log: () => {}, exit: () => {} },
      modelRuntime: runtime,
    });
    const result = await factory({
      cwd,
      agentDir: piAgentDir,
      sessionManager: SessionManager.inMemory(cwd) as never,
    });
    return result;
  }

  it("activates read + write_soul and NOT pi's generic write/edit/bash", async () => {
    const result = await buildSession({ setupSoulPath: soulPath });
    try {
      const active = result.session.getActiveToolNames();
      expect(active).toContain("write_soul");
      expect(active).toContain("read");
      expect(active).not.toContain("write");
      expect(active).not.toContain("edit");
      expect(active).not.toContain("bash");
    } finally {
      result.session.dispose();
    }
  });

  it("registers write_soul with a content-only schema and executes it to soul.md", async () => {
    const result = await buildSession({ setupSoulPath: soulPath });
    try {
      const tool = result.services.resourceLoader
        .getExtensions()
        .extensions.flatMap((e) => [...e.tools.values()])
        .map((t) => (t as { definition?: unknown }).definition)
        .find((d): d is { name: string } => (d as { name?: string })?.name === "write_soul");
      expect(tool, "write_soul is registered in the session").toBeTruthy();
      const params = (tool as unknown as { parameters: { properties?: Record<string, unknown> } })
        .parameters;
      expect(Object.keys(params.properties ?? {})).toEqual(["content"]);

      const res = await (
        tool as unknown as {
          execute(
            id: string,
            p: Record<string, unknown>,
            s?: AbortSignal,
            u?: unknown,
            c?: unknown,
          ): Promise<SoulToolOutput>;
        }
      ).execute("call-1", { content: "# Refined persona\n" });
      expect(res.details.refused).toBeUndefined();
      expect(readFileSync(soulPath, "utf-8")).toBe("# Refined persona\n");

      // A path argument is refused and bob.yaml is untouched — the session
      // cannot write anything but soul.md.
      const bobYamlBefore = readFileSync(join(agentDir, "bob.yaml"), "utf-8");
      const refused = await (
        tool as unknown as {
          execute(id: string, p: Record<string, unknown>): Promise<SoulToolOutput>;
        }
      ).execute("call-2", { content: "x", path: join(agentDir, "bob.yaml") });
      expect(refused.details.refused).toBe(true);
      expect(readFileSync(join(agentDir, "bob.yaml"), "utf-8")).toBe(bobYamlBefore);
    } finally {
      result.session.dispose();
    }
  });

  it("does NOT register write_soul for a session without setupSoulPath", async () => {
    const policy = {
      tools: ["read"],
      excludeTools: [],
      resident: false,
      allowResidentShell: false,
    };
    const result = await buildSession({ policy });
    try {
      const names = result.services.resourceLoader
        .getExtensions()
        .extensions.flatMap((e) => [...e.tools.keys()]);
      expect(names).not.toContain("write_soul");
    } finally {
      result.session.dispose();
    }
  });

  it("a normal (non-setup) session's runtime still excludes write_soul from the policy", async () => {
    // Guard against a regression where the tool leaks into every session: the
    // policy is the ceiling, and a session that did not set setupSoulPath and
    // does not list write_soul must not activate it.
    const result = await buildSession({ setupSoulPath: soulPath });
    try {
      expect(lstatSync(soulPath).isFile()).toBe(true);
      expect(SETUP_TOOL_POLICY.tools).toEqual(["read", "write_soul"]);
      expect(SETUP_TOOL_POLICY.tools).not.toContain("write");
    } finally {
      result.session.dispose();
    }
  });
});
