// Positions — slice 1 acceptance tests (bob#195).
//
// The six acceptance tests from the reconciled spec, each as written, plus the
// "an existing `bob init` agent still boots unchanged" guard. Every test drives
// the real loader / resolver / grant store in a scratch tree; the session
// assertions go through runAgent with a capturing session factory, so the tools
// a session is created with are the tools the resolver produced.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  adoptAgent,
  DEFAULT_POSITIONS_ROOT,
  hireAgent,
  initAgent,
  positionDiff,
  type RunSession,
  type RunSessionConfig,
  readBaseline,
  readGrant,
  resolveRunConfig,
  runAgent,
} from "../../src/shell/index.js";

interface Scratch {
  base: string;
  agentsRoot: string;
  hostRoot: string;
  positionsRoot: string;
}

let s: Scratch;
beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "bob-pos-"));
  s = {
    base,
    agentsRoot: join(base, "agents"),
    hostRoot: join(base, "host"),
    positionsRoot: join(base, "positions"),
  };
  mkdirSync(s.agentsRoot, { recursive: true });
  mkdirSync(s.positionsRoot, { recursive: true });
});
afterEach(() => {
  rmSync(s.base, { recursive: true, force: true });
});

// Write a test-only candidate position under the scratch positions root, using
// the same loader production uses.
function candidate(name: string, manifest: Record<string, unknown>, soul = "seed soul\n"): string {
  const dir = join(s.positionsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "position.json"), `${JSON.stringify({ name, ...manifest }, null, 2)}\n`);
  writeFileSync(join(dir, "soul.md"), soul);
  return name;
}

// A capturing session factory: records the config each created session gets,
// and returns a minimal fake session.
function capturingFactory(sink: RunSessionConfig[]): (c: RunSessionConfig) => Promise<RunSession> {
  return async (config) => {
    sink.push(config);
    return {
      subscribe: () => () => {},
      prompt: async () => {},
      dispose: () => {},
    } as unknown as RunSession;
  };
}

const bobYamlPath = (name: string) => join(s.agentsRoot, name, "bob.yaml");
const soulPath = (name: string) => join(s.agentsRoot, name, "soul.md");

// ---------------------------------------------------------------------------
describe("positions (bob#195) — 1. adoption", () => {
  it("records the binding/ratification/baseline, resolves before == after, and leaves config + soul unchanged", () => {
    // An existing agent whose requests are within the `builder` position.
    initAgent({
      name: "old1",
      role: "coder",
      provider: "exe-dev-gateway",
      model: "claude-sonnet-4-6",
      agentsRoot: s.agentsRoot,
      capabilities: [],
      toolAllow: ["read", "bash", "write", "edit", "grep", "find"],
      skipFlair: true,
    });
    const yamlBefore = readFileSync(bobYamlPath("old1"));
    const soulBefore = readFileSync(soulPath("old1"));

    const result = adoptAgent({
      name: "old1",
      positionName: "builder",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
    });

    // The binding, ratification and baseline records exist and name the position.
    const grant = readGrant(s.hostRoot, "old1");
    expect(grant?.position.name).toBe("builder");
    expect(grant?.role).toBe("coder");
    expect(readBaseline(s.hostRoot, "old1")?.position.name).toBe("builder");

    // The two independently resolved configurations are compared and agree.
    expect(result.before).toEqual(result.after);
    expect(result.after.tools).toEqual(["bash", "edit", "find", "grep", "read", "write"]);

    // The pre-existing configuration and soul are byte-for-byte unchanged.
    expect(readFileSync(bobYamlPath("old1")).equals(yamlBefore)).toBe(true);
    expect(readFileSync(soulPath("old1")).equals(soulBefore)).toBe(true);
    expect(result.soulHashBefore).toBe(result.soulHashAfter);

    // And `position diff` is empty immediately after adoption.
    expect(
      positionDiff({
        name: "old1",
        agentsRoot: s.agentsRoot,
        hostRoot: s.hostRoot,
        positionsRoot: DEFAULT_POSITIONS_ROOT,
      }).empty,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("positions (bob#195) — 2. hire a valid position; refuse an above-ceiling request", () => {
  it("hires a valid packaged position", () => {
    const result = hireAgent({
      name: "new1",
      positionName: "builder",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      skipFlair: true,
    });
    expect(existsSync(join(result.agentDir, "bob.yaml"))).toBe(true);
    expect(existsSync(join(result.agentDir, "overrides", ".git"))).toBe(true);
    expect(readGrant(s.hostRoot, "new1")?.position.name).toBe("builder");
  });

  it("refuses an above-ceiling tool request, naming the tool, with nothing committed", () => {
    candidate("bad-cand", {
      version: "0.1.0",
      role: "coder",
      tools: ["read", "discord_reply"],
      capabilities: { permitted: [], default: [] },
      files: [{ path: "soul.md", kind: "soul" }],
    });
    let err: unknown;
    try {
      hireAgent({
        name: "bad1",
        positionName: "bad-cand",
        agentsRoot: s.agentsRoot,
        hostRoot: s.hostRoot,
        positionsRoot: s.positionsRoot,
        skipFlair: true,
      });
    } catch (e) {
      err = e;
    }
    expect(String((err as Error)?.message)).toMatch(/discord_reply/);
    // No scaffold, grant or override repository committed.
    expect(existsSync(join(s.agentsRoot, "bad1"))).toBe(false);
    expect(readGrant(s.hostRoot, "bad1")).toBeUndefined();
    expect(existsSync(join(s.agentsRoot, "bad1", "overrides"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("positions (bob#195) — 3. boot refusals for an ungranted role / capability", () => {
  it("refuses a role change, refuses an ungranted capability, and boots when restored", () => {
    hireAgent({
      name: "boot1",
      positionName: "builder",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      skipFlair: true,
    });
    const good = readFileSync(bobYamlPath("boot1"), "utf8");
    const resolve = () =>
      resolveRunConfig({
        name: "boot1",
        agentsRoot: s.agentsRoot,
        hostRoot: s.hostRoot,
        positionsRoot: DEFAULT_POSITIONS_ROOT,
      });

    // A valid agent boots.
    expect(resolve().config.tools).toEqual(["read", "bash", "write", "edit", "grep", "find"]);

    // (a) bob.yaml changed to another existing role -> refuse, naming agent.role.
    writeFileSync(bobYamlPath("boot1"), good.replace("role: coder", "role: reviewer"));
    let roleErr: unknown;
    try {
      resolve();
    } catch (e) {
      roleErr = e;
    }
    expect(String((roleErr as Error)?.message)).toMatch(/agent\.role/);
    expect(String((roleErr as Error)?.message)).toMatch(/ratified the role/);

    // (b) request a blessed, supported but UNGRANTED capability -> refuse, naming it.
    writeFileSync(
      bobYamlPath("boot1"),
      `${good.replace("capabilities:\n", "capabilities:\n  - observatory\n")}`,
    );
    let capErr: unknown;
    try {
      resolve();
    } catch (e) {
      capErr = e;
    }
    expect(String((capErr as Error)?.message)).toMatch(/observatory/);

    // Restoring it boots successfully.
    writeFileSync(bobYamlPath("boot1"), good);
    expect(() => resolve()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("positions (bob#195) — 4. enabled-only secret presence", () => {
  const secretSoul = "seed\n";
  it("hires when the enabled capability's secret is bound, refuses when missing, and permits hire when the capability is off", () => {
    candidate(
      "sec-on",
      {
        version: "0.1.0",
        role: "coder",
        tools: ["read", "bash"],
        capabilities: { permitted: ["fixture"], default: ["fixture"] },
        files: [{ path: "soul.md", kind: "soul" }],
        secrets: [{ capability: "fixture", names: ["FIXTURE_TOKEN"] }],
      },
      secretSoul,
    );
    candidate(
      "sec-off",
      {
        version: "0.1.0",
        role: "coder",
        tools: ["read", "bash"],
        capabilities: { permitted: ["fixture"], default: [] },
        files: [{ path: "soul.md", kind: "soul" }],
      },
      secretSoul,
    );

    // Enabled capability, secret missing -> hire refused, naming the secret.
    let missingErr: unknown;
    try {
      hireAgent({
        name: "sec-missing",
        positionName: "sec-on",
        agentsRoot: s.agentsRoot,
        hostRoot: s.hostRoot,
        positionsRoot: s.positionsRoot,
        skipFlair: true,
        bindings: {},
      });
    } catch (e) {
      missingErr = e;
    }
    expect(String((missingErr as Error)?.message)).toMatch(/FIXTURE_TOKEN/);
    expect(existsSync(join(s.agentsRoot, "sec-missing"))).toBe(false);

    // Enabled capability, secret bound -> hire succeeds.
    const ok = hireAgent({
      name: "sec-bound",
      positionName: "sec-on",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: s.positionsRoot,
      skipFlair: true,
      bindings: { FIXTURE_TOKEN: { value: "present" } },
    });
    expect(ok.effective.capabilities).toEqual(["fixture"]);

    // Capability OFF, secret missing -> hire permitted.
    const off = hireAgent({
      name: "sec-off-ok",
      positionName: "sec-off",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: s.positionsRoot,
      skipFlair: true,
      bindings: {},
    });
    expect(off.effective.capabilities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
describe("positions (bob#195) — 5. two hires stay independent", () => {
  it("separate souls, override repos, baselines and grants; an override on one does not touch the other", async () => {
    const a = hireAgent({
      name: "twin-a",
      positionName: "builder",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      skipFlair: true,
    });
    const b = hireAgent({
      name: "twin-b",
      positionName: "builder",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      skipFlair: true,
    });

    expect(a.agentDir).not.toBe(b.agentDir);
    expect(existsSync(join(a.agentDir, "soul.md"))).toBe(true);
    expect(existsSync(join(b.agentDir, "soul.md"))).toBe(true);
    expect(existsSync(join(a.agentDir, "overrides", ".git"))).toBe(true);
    expect(existsSync(join(b.agentDir, "overrides", ".git"))).toBe(true);
    expect(readBaseline(s.hostRoot, "twin-a")?.position.name).toBe("builder");
    expect(readBaseline(s.hostRoot, "twin-b")?.position.name).toBe("builder");
    expect(readGrant(s.hostRoot, "twin-a")?.agent).toBe("twin-a");
    expect(readGrant(s.hostRoot, "twin-b")?.agent).toBe("twin-b");

    // A valid override edit on A disables a tool.
    writeFileSync(
      join(a.agentDir, "overrides", "overrides.json"),
      `${JSON.stringify({ disable: { tools: ["find"], capabilities: [] }, files: [] }, null, 2)}\n`,
    );

    const sinkA: RunSessionConfig[] = [];
    await runAgent({
      name: "twin-a",
      prompt: "go",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      sessionFactory: capturingFactory(sinkA),
    });
    expect(sinkA[0].tools).toEqual(["read", "bash", "write", "edit", "grep"]);

    // B is untouched: its resolution and created session still hold `find`.
    const sinkB: RunSessionConfig[] = [];
    await runAgent({
      name: "twin-b",
      prompt: "go",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      sessionFactory: capturingFactory(sinkB),
    });
    expect(sinkB[0].tools).toEqual(["read", "bash", "write", "edit", "grep", "find"]);
    expect(
      positionDiff({
        name: "twin-b",
        agentsRoot: s.agentsRoot,
        hostRoot: s.hostRoot,
        positionsRoot: DEFAULT_POSITIONS_ROOT,
      }).empty,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("positions (bob#195) — 6. a disable removes a tool; an enable/widening key refuses boot", () => {
  it("a valid disable removes a previously active tool from a created session", async () => {
    hireAgent({
      name: "dis1",
      positionName: "builder",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      skipFlair: true,
    });
    writeFileSync(
      join(s.agentsRoot, "dis1", "overrides", "overrides.json"),
      `${JSON.stringify({ disable: { tools: ["grep"], capabilities: [] }, files: [] }, null, 2)}\n`,
    );
    const sink: RunSessionConfig[] = [];
    await runAgent({
      name: "dis1",
      prompt: "go",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      sessionFactory: capturingFactory(sink),
    });
    expect(sink[0].tools).not.toContain("grep");
    expect(sink[0].tools).toContain("read");
  });

  it("an enable key and a tool-widening key each refuse boot, naming the key; removing them restores boot", () => {
    hireAgent({
      name: "bad-key",
      positionName: "builder",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      skipFlair: true,
    });
    const overridesPath = join(s.agentsRoot, "bad-key", "overrides", "overrides.json");
    const resolve = () =>
      resolveRunConfig({
        name: "bad-key",
        agentsRoot: s.agentsRoot,
        hostRoot: s.hostRoot,
        positionsRoot: DEFAULT_POSITIONS_ROOT,
      });

    // Boots clean to start.
    expect(() => resolve()).not.toThrow();

    // An ENABLE key -> refuse, naming "enable".
    writeFileSync(overridesPath, `${JSON.stringify({ enable: { tools: ["ls"] } }, null, 2)}\n`);
    let enableErr: unknown;
    try {
      resolve();
    } catch (e) {
      enableErr = e;
    }
    expect(String((enableErr as Error)?.message)).toMatch(/enable/);

    // A TOOL-WIDENING key (top-level `tools`) -> refuse, naming "tools".
    writeFileSync(overridesPath, `${JSON.stringify({ tools: ["ls"] }, null, 2)}\n`);
    let widenErr: unknown;
    try {
      resolve();
    } catch (e) {
      widenErr = e;
    }
    expect(String((widenErr as Error)?.message)).toMatch(/tools/);

    // Removing each invalid edit restores a successful boot.
    writeFileSync(
      overridesPath,
      `${JSON.stringify({ disable: { tools: [], capabilities: [] }, files: [] }, null, 2)}\n`,
    );
    expect(() => resolve()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("positions (bob#195) — an un-adopted `bob init` agent boots unchanged", () => {
  it("resolves and creates a session with no position, grant or overrides involved", async () => {
    initAgent({
      name: "plain",
      role: "custom",
      provider: "exe-dev-gateway",
      model: "claude-sonnet-4-6",
      agentsRoot: s.agentsRoot,
      skipFlair: true,
    });
    // No grant exists, so the agent is not adopted.
    expect(readGrant(s.hostRoot, "plain")).toBeUndefined();

    const sink: RunSessionConfig[] = [];
    await runAgent({
      name: "plain",
      prompt: "go",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      sessionFactory: capturingFactory(sink),
    });
    // The stamped allowlist for the custom role is unchanged.
    expect(sink[0].tools).toEqual([
      "read",
      "bash",
      "write",
      "edit",
      "flair_search",
      "flair_write",
      "flair_get",
    ]);
    // And the flair capability still loads.
    expect(sink[0].extensionSources.length).toBe(1);
    expect(existsSync(join(s.agentsRoot, "plain", "overrides"))).toBe(false);
  });
});
