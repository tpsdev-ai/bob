// A failed hire after a REAL interview session (bob#326). The interview seam
// here builds the setup session through bob's one session factory, the way
// `bob hire` does, with a stub model (no model-provider request is made) and a
// real on-disk session store under the agent's .pi-agent/sessions. It then
// calls the write_soul tool the factory REGISTERED, which replaces soul.md with
// a new file (a new inode), on real files.
//
// What the rollback does with the interview's own work: the refined soul.md is
// not the entry init published (write_soul renamed a new file over it), and the
// session store was written by pi, not recorded by this operation. Both stay in
// place, so the persona the operator just shaped is not lost, and both are
// named in the refusal. Everything init, the marker and the override repository
// published is removed, and so are the host grant and baseline.

import { afterAll, describe, expect, it } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import {
  baselinePath,
  bindingMarkerPath,
  createBobRuntimeFactory,
  grantPath,
  readGrant,
  type SessionRunner,
} from "../../src/shell/index.js";
import type { SoulToolOutput } from "../../src/shell/write-soul.js";
import {
  entriesUnder,
  hire,
  newScratch,
  readEntry,
  refusalOf,
  type Scratch,
} from "./rollback-326-helpers.js";

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
      throw new Error("the interview tests never run a model turn");
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

type Execute = (id: string, params: Record<string, unknown>) => Promise<SoulToolOutput>;

// The interview: the real setup session (bob's factory, the policy and config
// runOnboard hands it, a real SessionManager on disk), the registered
// write_soul writing `soul`, then optionally a persisted exchange in the
// session store, then `exitCode`.
function realInterview(opts: {
  soul: string;
  exitCode: number;
  persistSession?: boolean;
}): SessionRunner {
  return async (input) => {
    const sessionManager = SessionManager.create(
      input.config.cwd,
      join(input.config.piAgentDir, "sessions"),
    );
    const factory = createBobRuntimeFactory({
      config: {
        ...input.config,
        provider: STUB_PROVIDER,
        providerRecord: undefined,
        model: STUB_MODEL,
        modelLimits: { provider: STUB_PROVIDER, model: STUB_MODEL, contextWindow: 200_000 },
        extensionSources: [],
      },
      policy: input.policy,
      deps: { log: () => {}, exit: () => {} },
      modelRuntime: await stubRuntime(),
    });
    const built = await factory({
      cwd: input.config.cwd,
      agentDir: input.config.piAgentDir,
      sessionManager: sessionManager as never,
    });
    try {
      expect(built.session.getActiveToolNames().slice().sort()).toEqual(["read", "write_soul"]);
      const tool = built.services.resourceLoader
        .getExtensions()
        .extensions.flatMap((e) => [...e.tools.values()])
        .map((t) => (t as { definition?: { name?: string; execute?: Execute } }).definition)
        .find((d) => d?.name === "write_soul");
      if (tool?.execute === undefined) throw new Error("write_soul is not registered");
      const res = await tool.execute("call-1", { content: opts.soul });
      if (res.details.refused !== undefined) throw new Error(String(res.content[0]?.text));
      if (opts.persistSession === true) {
        sessionManager.appendMessage({
          role: "user",
          content: "ship it",
          timestamp: Date.now(),
        } as never);
        sessionManager.appendMessage({
          role: "assistant",
          content: [{ type: "text", text: "Wrote my persona." }],
          api: "bob-stub-api",
          provider: STUB_PROVIDER,
          model: STUB_MODEL,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: Date.now(),
        } as never);
      }
    } finally {
      built.session.dispose();
    }
    return opts.exitCode;
  };
}

const scratches: Scratch[] = [];
const scratch = (): Scratch => {
  const s = newScratch("bob-rbi-");
  scratches.push(s);
  return s;
};
afterAll(() => {
  for (const s of scratches) rmSync(s.base, { recursive: true, force: true });
});

const PERSONA = "# Refined persona\n\nI am the builder the operator just interviewed.\n";

describe("bob#326 — a hire that fails after a real interview session", () => {
  it("the interview writes soul.md with the registered write_soul, then exits nonzero: the persona and the session store are kept and named, the rest is removed", async () => {
    const s = scratch();
    const name = "rbi-exit";
    const agentDir = join(s.agentsRoot, name);
    const msg = await refusalOf(() =>
      hire(s, name, { interview: realInterview({ soul: PERSONA, exitCode: 5 }) }),
    );

    expect(msg).toContain(`the onboarding interview for "${name}" exited with code 5`);
    expect(msg).toContain(`left these entries in place (paths relative to ${agentDir}`);
    expect(msg).toContain("soul.md");
    expect(msg).toContain(".pi-agent/sessions");
    // The persona write_soul wrote is retained byte for byte.
    expect(readEntry(join(agentDir, "soul.md")).text).toBe(PERSONA);
    // Everything init published is gone; what stays is the interview's own.
    expect(entriesUnder(agentDir)).toEqual([".pi-agent", ".pi-agent/sessions", "soul.md"]);
    expect(readGrant(s.hostRoot, name)).toBeUndefined();
    expect(readdirSync(s.agentsRoot)).toEqual([name]);
  });

  it("session files written before a failure in the commit: kept and named; the marker, grant and baseline are removed", async () => {
    const s = scratch();
    const name = "rbi-commit";
    const agentDir = join(s.agentsRoot, name);
    const msg = await refusalOf(() =>
      hire(s, name, {
        interview: realInterview({ soul: PERSONA, exitCode: 0, persistSession: true }),
        failAt: "baseline",
      }),
    );

    expect(msg).toContain("injected failure at baseline");
    expect(msg).toContain(".pi-agent/sessions");
    expect(msg).toContain("soul.md");
    const sessions = readdirSync(join(agentDir, ".pi-agent", "sessions"));
    expect(sessions).toHaveLength(1);
    const sessionFile = join(agentDir, ".pi-agent", "sessions", sessions[0] as string);
    expect(readEntry(sessionFile).text).toContain("Wrote my persona.");
    expect(readEntry(join(agentDir, "soul.md")).text).toBe(PERSONA);
    expect(entriesUnder(agentDir)).toEqual(
      [".pi-agent", ".pi-agent/sessions", `.pi-agent/sessions/${sessions[0]}`, "soul.md"].sort(),
    );
    // The binding is cleaned up: marker (inside the agent directory), grant and
    // baseline (under the host state root).
    expect(entriesUnder(agentDir)).not.toContain(".position-binding.json");
    expect(bindingMarkerPath(agentDir).startsWith(agentDir)).toBe(true);
    expect(readGrant(s.hostRoot, name)).toBeUndefined();
    expect(readdirSync(join(s.hostRoot, "grants"))).not.toContain(`${name}.json`);
    expect(readdirSync(join(s.hostRoot, "baselines"))).not.toContain(`${name}.json`);
    expect(grantPath(s.hostRoot, name)).toBe(join(s.hostRoot, "grants", `${name}.json`));
    expect(baselinePath(s.hostRoot, name)).toBe(join(s.hostRoot, "baselines", `${name}.json`));
  });
});
