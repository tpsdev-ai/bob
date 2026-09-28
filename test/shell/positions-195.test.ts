// Positions — slice 1 acceptance tests (bob#195), ROUND 2.
//
// Every test drives the real loader / resolver / grant store in a scratch tree.
// Session assertions go through runAgent / runLaunch / runOnboard / runAlign with
// a capturing factory (or an injected session runner), so the tools a session is
// created with are the tools the resolver produced — for EVERY session entry
// path.
//
// Each test is named for the blocker it discriminates. "Old code" notes name the
// behaviour on head 3b874cb that the test fails against.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  adoptAgent,
  BINDING_MARKER,
  bindingMarkerPath,
  DEFAULT_POSITIONS_ROOT,
  hireAgent,
  initAgent,
  type LoadedPosition,
  loadPosition,
  overridesDir,
  type PositionManifest,
  positionDiff,
  type RunSession,
  type RunSessionConfig,
  readBaseline,
  readBindingMarker,
  readGrant,
  resolvePositionFiles,
  resolveRunConfig,
  runAgent,
  runAlign,
  runLaunch,
  runOnboard,
  type SessionRunner,
  writeGrant,
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

// A no-op hiring interview: returns exit 0 and leaves soul.md as scaffolded.
const noopInterview: SessionRunner = async () => 0;

// An interview that records the policy + the seed soul it saw, then writes a new
// persona (proving the interview actually ran and refined the soul).
function recordingInterview(
  seen: { policy: unknown; seedSoul: string },
  persona: string,
  path: string,
): SessionRunner {
  return async (input) => {
    seen.policy = input.policy;
    // No existsSync-then-read window (CodeQL js/file-system-race): a missing
    // file is just an empty seed.
    try {
      seen.seedSoul = readFileSync(path, "utf8");
    } catch {
      seen.seedSoul = "";
    }
    writeFileSync(path, persona);
    return 0;
  };
}

// Write a test-only candidate position under the scratch positions root, using
// the same loader production uses.
function candidate(name: string, manifest: Record<string, unknown>, soul = "seed soul\n"): string {
  const dir = join(s.positionsRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "position.json"), `${JSON.stringify({ name, ...manifest }, null, 2)}\n`);
  writeFileSync(join(dir, "soul.md"), soul);
  return name;
}

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
const grantFile = (name: string) => join(s.hostRoot, "grants", `${name}.json`);
const resolve = (name: string) =>
  resolveRunConfig({
    name,
    agentsRoot: s.agentsRoot,
    hostRoot: s.hostRoot,
    positionsRoot: DEFAULT_POSITIONS_ROOT,
  });

// A builder hire (the shipped position, coder role).
const hireBuilder = (name: string, interview: SessionRunner = noopInterview) =>
  hireAgent({
    name,
    positionName: "builder",
    agentsRoot: s.agentsRoot,
    hostRoot: s.hostRoot,
    positionsRoot: DEFAULT_POSITIONS_ROOT,
    skipFlair: true,
    interview,
  });

// ---------------------------------------------------------------------------
describe("bob#195 blocker 1 — the grant is host state; a bound agent whose grant is gone REFUSES", () => {
  it("stores the grant outside the agent dir and its cwd, and writes a binding marker into the agent dir", async () => {
    await hireBuilder("g1");
    const agentDir = join(s.agentsRoot, "g1");
    const g = grantFile("g1");
    expect(existsSync(g)).toBe(true);
    // The grant is not under the agent's directory or its cwd (…/work).
    expect(g.startsWith(agentDir)).toBe(false);
    expect(g.startsWith(join(agentDir, "work"))).toBe(false);
    expect(g.startsWith(s.agentsRoot)).toBe(false);
    // The binding marker is the in-agent evidence that g1 was bound.
    expect(existsSync(bindingMarkerPath(agentDir))).toBe(true);
    expect(readBindingMarker(agentDir)?.position).toBe("builder");
    expect(BINDING_MARKER.startsWith(".")).toBe(true);
  });

  it("refuses to boot when a bound agent's grant is missing (no legacy fallback)", async () => {
    await hireBuilder("g2");
    // Sanity: it boots while the grant is present.
    expect(() => resolve("g2")).not.toThrow();
    // Remove the grant: the agent was bound (marker present), so boot must refuse
    // rather than fall back to unratified legacy resolution.
    rmSync(grantFile("g2"));
    let err: unknown;
    try {
      resolve("g2");
    } catch (e) {
      err = e;
    }
    expect(String((err as Error)?.message)).toMatch(/grant is missing/);
    expect(String((err as Error)?.message)).toMatch(/no fallback|Refusing to boot/);
  });
});

// ---------------------------------------------------------------------------
describe("bob#195 blocker 2 — the packaged role and the manifest version are enforced at boot", () => {
  it("refuses boot when the manifest version differs from the grant (the packaged role is loaded and compared)", async () => {
    await hireBuilder("r2a");
    const grant = readGrant(s.hostRoot, "r2a");
    expect(grant).toBeDefined();
    if (!grant) throw new Error("no grant");
    // Same name/hash/role, only the ratified VERSION drifts.
    writeGrant(s.hostRoot, { ...grant, position: { ...grant.position, version: "9.9.9" } });
    let err: unknown;
    try {
      resolve("r2a");
    } catch (e) {
      err = e;
    }
    expect(String((err as Error)?.message)).toMatch(/version/);
  });

  it("enforces the PACKAGED role ceiling, not just the grant's tool list", async () => {
    await hireBuilder("r2b");
    const grant = readGrant(s.hostRoot, "r2b");
    if (!grant) throw new Error("no grant");
    // A host grant that ratifies a tool the packaged `coder` role does NOT allow.
    writeGrant(s.hostRoot, { ...grant, maxTools: [...grant.maxTools, "ls"] });
    // bob.yaml requests it: within the grant, outside the packaged role.
    const yaml = readFileSync(bobYamlPath("r2b"), "utf8");
    writeFileSync(bobYamlPath("r2b"), yaml.replace(/(\n {4}- find)/, "$1\n    - ls"));
    let err: unknown;
    try {
      resolve("r2b");
    } catch (e) {
      err = e;
    }
    expect(String((err as Error)?.message)).toMatch(/role/i);
  });
});

// ---------------------------------------------------------------------------
describe("bob#195 blocker 3 — every session entry path uses the resolved policy (within the grant)", () => {
  // A reviewer position: role `reviewer` allows read, bash, grep (no write).
  const hireReviewer = (name: string) =>
    hireAgent({
      name,
      positionName: "reviewer",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      skipFlair: true,
      interview: noopInterview,
    });

  it("one-shot `bob run` uses the grant's tools", async () => {
    await hireReviewer("p1");
    const sink: RunSessionConfig[] = [];
    await runAgent({
      name: "p1",
      prompt: "go",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      sessionFactory: capturingFactory(sink),
    });
    expect(sink[0].tools.slice().sort()).toEqual(["bash", "grep", "read"]);
  });

  it("the persistent runtime resolution excludes the resident shell within the grant", async () => {
    await hireReviewer("p2");
    const { config } = resolveRunConfig({
      name: "p2",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      persistent: true,
    });
    // reviewer's role does not opt into a resident shell: bash is excluded at
    // persistent-session time (active tools are tools minus excludeTools).
    expect(config.tools.slice().sort()).toEqual(["bash", "grep", "read"]);
    expect(config.excludeTools).toContain("bash");
    const active = config.tools.filter((t) => !config.excludeTools.includes(t));
    expect(active.slice().sort()).toEqual(["grep", "read"]);
  });

  it("`bob launch` (prompt path) uses the grant's tools", async () => {
    await hireReviewer("p3");
    const sink: RunSessionConfig[] = [];
    await runLaunch({
      name: "p3",
      prompt: "go",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      sessionFactory: capturingFactory(sink),
    });
    expect(sink[0].tools.slice().sort()).toEqual(["bash", "grep", "read"]);
  });

  it("`bob onboard` on an adopted agent runs the grant's tools plus EXACTLY the one write tool", async () => {
    const hired = await hireReviewer("p4");
    const seen: { policy?: { tools: string[] } } = {};
    await runOnboard({
      name: "p4",
      role: "reviewer",
      agentDir: hired.agentDir,
      provider: "exe-dev-gateway",
      model: "claude-sonnet-4-6",
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      sessionRunner: async (input) => {
        seen.policy = input.policy as { tools: string[] };
        return 0;
      },
    });
    const tools = seen.policy?.tools ?? [];
    // The grant's tools are present (old code used a fixed [read, write]).
    expect(tools.slice().sort()).toEqual(["bash", "grep", "read", "write"]);
    // Nothing but `write` may exceed the grant.
    const grant = readGrant(s.hostRoot, "p4");
    const outside = tools.filter((t) => !(grant?.maxTools ?? []).includes(t));
    expect(outside).toEqual(["write"]);
  });

  it("`bob align` on an adopted agent runs the grant's tools plus EXACTLY the one write tool", async () => {
    const hired = await hireReviewer("p5");
    const seen: { policy?: { tools: string[] } } = {};
    await runAlign({
      name: "p5",
      agentDir: hired.agentDir,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      sessionRunner: async (input) => {
        seen.policy = input.policy as { tools: string[] };
        return 0;
      },
    });
    const tools = seen.policy?.tools ?? [];
    expect(tools.slice().sort()).toEqual(["bash", "grep", "read", "write"]);
    const grant = readGrant(s.hostRoot, "p5");
    const outside = tools.filter((t) => !(grant?.maxTools ?? []).includes(t));
    expect(outside).toEqual(["write"]);
  });
});

// ---------------------------------------------------------------------------
describe("bob#195 blocker 4 — slice 1 refuses a position that declares a secret; hire and adopt both refuse", () => {
  it("hire refuses a position declaring a secret (no host secret bindings in slice 1)", async () => {
    candidate("sec-cand", {
      version: "0.1.0",
      role: "coder",
      tools: ["read", "bash"],
      capabilities: { permitted: ["fixture"], default: [] },
      files: [{ path: "soul.md", kind: "soul" }],
      secrets: [{ capability: "fixture", names: ["FIXTURE_TOKEN"] }],
    });
    let err: unknown;
    try {
      await hireAgent({
        name: "sec1",
        positionName: "sec-cand",
        agentsRoot: s.agentsRoot,
        hostRoot: s.hostRoot,
        positionsRoot: s.positionsRoot,
        skipFlair: true,
        interview: noopInterview,
      });
    } catch (e) {
      err = e;
    }
    expect(String((err as Error)?.message)).toMatch(/secret/i);
    expect(existsSync(join(s.agentsRoot, "sec1"))).toBe(false);
  });

  it("adoption refuses a position declaring a secret", () => {
    candidate("sec-cand2", {
      version: "0.1.0",
      role: "coder",
      tools: ["read", "bash"],
      capabilities: { permitted: [], default: [] },
      files: [{ path: "soul.md", kind: "soul" }],
      secrets: [{ capability: "fixture", names: ["FIXTURE_TOKEN"] }],
    });
    initAgent({
      name: "sec2",
      role: "coder",
      provider: "exe-dev-gateway",
      model: "claude-sonnet-4-6",
      agentsRoot: s.agentsRoot,
      capabilities: [],
      toolAllow: ["read", "bash"],
      skipFlair: true,
    });
    let err: unknown;
    try {
      adoptAgent({
        name: "sec2",
        positionName: "sec-cand2",
        agentsRoot: s.agentsRoot,
        hostRoot: s.hostRoot,
        positionsRoot: s.positionsRoot,
      });
    } catch (e) {
      err = e;
    }
    expect(String((err as Error)?.message)).toMatch(/secret/i);
  });
});

// ---------------------------------------------------------------------------
describe("bob#195 blocker 5 — hire runs the onboarding interview and keeps the agent's identity", () => {
  it("a completed hire runs the interview, which refines soul.md", async () => {
    const seen = { policy: undefined as unknown, seedSoul: "" };
    const result = await hireBuilder(
      "h1",
      recordingInterview(seen, "REFINED BY INTERVIEW\n", soulPath("h1")),
    );
    expect(result.interview.soulUpdated).toBe(true);
    expect(readFileSync(soulPath("h1"), "utf8")).toBe("REFINED BY INTERVIEW\n");
    // The interview saw the seed soul, which carries the agent's OWN identity
    // (initAgent's header) plus the position's persona.
    expect(seen.seedSoul).toContain("You are H1");
    expect(seen.seedSoul).toContain("You are a builder.");
  });

  it("the seed soul keeps the agent's identity AND the position's persona (not the generic packaged soul alone)", async () => {
    const seen = { policy: undefined as unknown, seedSoul: "" };
    await hireBuilder("h2", recordingInterview(seen, "x\n", soulPath("h2")));
    expect(seen.seedSoul).toMatch(/# You are H2/);
    expect(seen.seedSoul).toContain("You are a builder.");
  });
});

// ---------------------------------------------------------------------------
describe("bob#195 blocker 6 — unsupported file kinds, soul overrides, and the confined `path:` form", () => {
  it("refuses a manifest that declares a file kind slice 1 cannot load", async () => {
    candidate("skill-cand", {
      version: "0.1.0",
      role: "coder",
      tools: ["read"],
      capabilities: { permitted: [], default: [] },
      files: [{ path: "x.md", kind: "skill" }],
    });
    let err: unknown;
    try {
      await hireAgent({
        name: "sk1",
        positionName: "skill-cand",
        agentsRoot: s.agentsRoot,
        hostRoot: s.hostRoot,
        positionsRoot: s.positionsRoot,
        skipFlair: true,
        interview: noopInterview,
      });
    } catch (e) {
      err = e;
    }
    expect(String((err as Error)?.message)).toMatch(/skill/);
    expect(existsSync(join(s.agentsRoot, "sk1"))).toBe(false);
  });

  it("refuses a soul override (the persona is not overridable)", async () => {
    await hireBuilder("ov-soul");
    const files = join(s.agentsRoot, "ov-soul", "overrides", "files");
    mkdirSync(files, { recursive: true });
    writeFileSync(join(files, "soul.md"), "hijacked persona\n");
    let err: unknown;
    try {
      resolve("ov-soul");
    } catch (e) {
      err = e;
    }
    expect(String((err as Error)?.message)).toMatch(/soul/);
  });

  it("loads the confined `path:` form and refuses one that escapes the packaged directory", () => {
    const p = loadPosition("path:builder", { root: DEFAULT_POSITIONS_ROOT });
    expect(p.manifest.name).toBe("builder");
    expect(() => loadPosition("path:../escape", { root: DEFAULT_POSITIONS_ROOT })).toThrow();
    expect(() =>
      loadPosition("path:builder/../../etc", { root: DEFAULT_POSITIONS_ROOT }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("bob#195 blocker 7 — adoption requires equal before/after; diff covers the effective settings", () => {
  it("adoption REFUSES when the before and after effective configurations differ", () => {
    initAgent({
      name: "ad1",
      role: "coder",
      provider: "exe-dev-gateway",
      model: "claude-sonnet-4-6",
      agentsRoot: s.agentsRoot,
      capabilities: [],
      toolAllow: ["read", "bash", "write", "edit", "grep", "find"],
      skipFlair: true,
    });
    // An override that disables a tool changes the AFTER but not the BEFORE.
    const ovDir = join(s.agentsRoot, "ad1", "overrides");
    mkdirSync(ovDir, { recursive: true });
    writeFileSync(
      join(ovDir, "overrides.json"),
      `${JSON.stringify({ disable: { tools: ["find"], capabilities: [] }, files: [] }, null, 2)}\n`,
    );
    let err: unknown;
    try {
      adoptAgent({
        name: "ad1",
        positionName: "builder",
        agentsRoot: s.agentsRoot,
        hostRoot: s.hostRoot,
        positionsRoot: DEFAULT_POSITIONS_ROOT,
      });
    } catch (e) {
      err = e;
    }
    expect(String((err as Error)?.message)).toMatch(/does not equal|before binding|agree/);
    // Nothing was ratified.
    expect(readGrant(s.hostRoot, "ad1")).toBeUndefined();
  });

  it("`position diff` reports drift in a setting other than tools/capabilities/files/soul (excludeTools)", async () => {
    await hireBuilder("d1");
    expect(
      positionDiff({
        name: "d1",
        agentsRoot: s.agentsRoot,
        hostRoot: s.hostRoot,
        positionsRoot: DEFAULT_POSITIONS_ROOT,
      }).empty,
    ).toBe(true);
    // Add an exclusion for a tool NOT in the allow list: `tools` is unchanged,
    // only the exclusion set drifts.
    const yaml = readFileSync(bobYamlPath("d1"), "utf8");
    writeFileSync(
      bobYamlPath("d1"),
      yaml.replace("\ncapabilities:", "\n  exclude:\n    - ls\n\ncapabilities:"),
    );
    const diff = positionDiff({
      name: "d1",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
    });
    expect(diff.tools.added).toEqual([]);
    expect(diff.tools.removed).toEqual([]);
    expect(diff.excludeTools.added).toEqual(["ls"]);
    expect(diff.empty).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("positions (bob#195) — 1. adoption records the binding and leaves config + soul unchanged", () => {
  it("records the binding/ratification/baseline, resolves before == after, and leaves config + soul unchanged", () => {
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

    const grant = readGrant(s.hostRoot, "old1");
    expect(grant?.position.name).toBe("builder");
    expect(grant?.role).toBe("coder");
    expect(readBaseline(s.hostRoot, "old1")?.position.name).toBe("builder");

    expect(result.before).toEqual(result.after);
    expect(result.after.tools.slice().sort()).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "read",
      "write",
    ]);

    expect(readFileSync(bobYamlPath("old1")).equals(yamlBefore)).toBe(true);
    expect(readFileSync(soulPath("old1")).equals(soulBefore)).toBe(true);
    expect(result.soulHashBefore).toBe(result.soulHashAfter);

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
  it("hires a valid packaged position", async () => {
    const result = await hireBuilder("new1");
    expect(existsSync(join(result.agentDir, "bob.yaml"))).toBe(true);
    expect(existsSync(join(result.agentDir, "overrides", ".git"))).toBe(true);
    expect(readFileSync(join(result.agentDir, "soul.md"), "utf8")).toContain("You are a builder.");
    expect(readFileSync(join(result.agentDir, "soul.md"), "utf8")).toContain("You are New1");
    expect(readGrant(s.hostRoot, "new1")?.position.name).toBe("builder");
    // Immediately after hire, `position diff` is empty.
    expect(
      positionDiff({
        name: "new1",
        agentsRoot: s.agentsRoot,
        hostRoot: s.hostRoot,
        positionsRoot: DEFAULT_POSITIONS_ROOT,
      }).empty,
    ).toBe(true);
  });

  it("refuses an above-ceiling tool request, naming the tool, with nothing committed", async () => {
    candidate("bad-cand", {
      version: "0.1.0",
      role: "coder",
      tools: ["read", "discord_reply"],
      capabilities: { permitted: [], default: [] },
      files: [{ path: "soul.md", kind: "soul" }],
    });
    let err: unknown;
    try {
      await hireAgent({
        name: "bad1",
        positionName: "bad-cand",
        agentsRoot: s.agentsRoot,
        hostRoot: s.hostRoot,
        positionsRoot: s.positionsRoot,
        skipFlair: true,
        interview: noopInterview,
      });
    } catch (e) {
      err = e;
    }
    expect(String((err as Error)?.message)).toMatch(/discord_reply/);
    expect(existsSync(join(s.agentsRoot, "bad1"))).toBe(false);
    expect(readGrant(s.hostRoot, "bad1")).toBeUndefined();
    expect(existsSync(join(s.agentsRoot, "bad1", "overrides"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("positions (bob#195) — 3. boot refusals for an ungranted role / capability", () => {
  it("refuses a role change, refuses an ungranted capability, and boots when restored", async () => {
    await hireBuilder("boot1");
    const good = readFileSync(bobYamlPath("boot1"), "utf8");

    expect(resolve("boot1").config.tools.slice().sort()).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "read",
      "write",
    ]);

    writeFileSync(bobYamlPath("boot1"), good.replace("role: coder", "role: reviewer"));
    let roleErr: unknown;
    try {
      resolve("boot1");
    } catch (e) {
      roleErr = e;
    }
    expect(String((roleErr as Error)?.message)).toMatch(/agent\.role/);
    expect(String((roleErr as Error)?.message)).toMatch(/ratified the role/);

    // A capability the POSITION does not permit is refused by the position check.
    writeFileSync(
      bobYamlPath("boot1"),
      good.replace("capabilities:\n", "capabilities:\n  - observatory\n"),
    );
    let capErr: unknown;
    try {
      resolve("boot1");
    } catch (e) {
      capErr = e;
    }
    expect(String((capErr as Error)?.message)).toMatch(/observatory/);
    expect(String((capErr as Error)?.message)).toMatch(/position does not permit/);

    writeFileSync(bobYamlPath("boot1"), good);
    expect(() => resolve("boot1")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
describe("positions (bob#195) — 5. two hires stay independent (files AND grants compared)", () => {
  it("separate souls, override repos, baselines and grants; an override on one leaves the other untouched", async () => {
    const a = await hireBuilder("twin-a");
    const b = await hireBuilder("twin-b");

    expect(a.agentDir).not.toBe(b.agentDir);
    expect(readBaseline(s.hostRoot, "twin-a")?.position.name).toBe("builder");
    expect(readBaseline(s.hostRoot, "twin-b")?.position.name).toBe("builder");
    expect(readGrant(s.hostRoot, "twin-a")?.agent).toBe("twin-a");
    expect(readGrant(s.hostRoot, "twin-b")?.agent).toBe("twin-b");

    // B's files and grant, captured before A is edited.
    const bGrantBefore = readFileSync(grantFile("twin-b"));
    const bSoulBefore = readFileSync(soulPath("twin-b"));

    // A valid override on A disables a tool.
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
    expect(sinkA[0].tools.slice().sort()).toEqual(["bash", "edit", "grep", "read", "write"]);

    // B's files and grant are byte-for-byte what they were; its session holds `find`.
    expect(readFileSync(grantFile("twin-b")).equals(bGrantBefore)).toBe(true);
    expect(readFileSync(soulPath("twin-b")).equals(bSoulBefore)).toBe(true);
    const sinkB: RunSessionConfig[] = [];
    await runAgent({
      name: "twin-b",
      prompt: "go",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      sessionFactory: capturingFactory(sinkB),
    });
    expect(sinkB[0].tools.slice().sort()).toEqual([
      "bash",
      "edit",
      "find",
      "grep",
      "read",
      "write",
    ]);
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
    await hireBuilder("dis1");
    // Establish PRIOR activity: `grep` is active before the override.
    const before: RunSessionConfig[] = [];
    await runAgent({
      name: "dis1",
      prompt: "go",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      sessionFactory: capturingFactory(before),
    });
    expect(before[0].tools).toContain("grep");

    writeFileSync(
      join(s.agentsRoot, "dis1", "overrides", "overrides.json"),
      `${JSON.stringify({ disable: { tools: ["grep"], capabilities: [] }, files: [] }, null, 2)}\n`,
    );
    const after: RunSessionConfig[] = [];
    await runAgent({
      name: "dis1",
      prompt: "go",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      sessionFactory: capturingFactory(after),
    });
    expect(after[0].tools).not.toContain("grep");
    expect(after[0].tools).toContain("read");
  });

  it("an enable key and a tool-widening key each refuse boot, naming the key; removing them restores boot", async () => {
    await hireBuilder("bad-key");
    const overridesPath = join(s.agentsRoot, "bad-key", "overrides", "overrides.json");

    expect(() => resolve("bad-key")).not.toThrow();

    writeFileSync(overridesPath, `${JSON.stringify({ enable: { tools: ["ls"] } }, null, 2)}\n`);
    let enableErr: unknown;
    try {
      resolve("bad-key");
    } catch (e) {
      enableErr = e;
    }
    expect(String((enableErr as Error)?.message)).toMatch(/enable/);

    writeFileSync(overridesPath, `${JSON.stringify({ tools: ["ls"] }, null, 2)}\n`);
    let widenErr: unknown;
    try {
      resolve("bad-key");
    } catch (e) {
      widenErr = e;
    }
    expect(String((widenErr as Error)?.message)).toMatch(/tools/);

    writeFileSync(
      overridesPath,
      `${JSON.stringify({ disable: { tools: [], capabilities: [] }, files: [] }, null, 2)}\n`,
    );
    expect(() => resolve("bad-key")).not.toThrow();
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
    expect(readGrant(s.hostRoot, "plain")).toBeUndefined();
    expect(readBindingMarker(join(s.agentsRoot, "plain"))).toBeUndefined();

    const sink: RunSessionConfig[] = [];
    await runAgent({
      name: "plain",
      prompt: "go",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      sessionFactory: capturingFactory(sink),
    });
    expect(sink[0].tools).toEqual([
      "read",
      "bash",
      "write",
      "edit",
      "flair_search",
      "flair_write",
      "flair_get",
    ]);
    // The flair capability's tools are actually in the session's policy, and it
    // is the one extension source.
    expect(sink[0].extensionSources.length).toBe(1);
    expect(sink[0].tools).toContain("flair_search");
    expect(existsSync(join(s.agentsRoot, "plain", "overrides"))).toBe(false);
  });
});

// ===========================================================================
// ROUND 3
// ===========================================================================

// Build a LoadedPosition by hand so a test can name a NON-soul packaged file
// (slice 1 refuses such a manifest through loadPosition, but resolvePositionFiles
// itself is kind-agnostic, and that is exactly what the override checks guard).
function loadedPosition(
  files: Array<{ path: string; kind: string }>,
  dirFiles: Record<string, string> = {},
): LoadedPosition {
  const dir = mkdtempSync(join(tmpdir(), "bob-pos-dir-"));
  for (const [rel, content] of Object.entries(dirFiles)) {
    const p = join(dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
  }
  const manifest = {
    name: "cand",
    version: "0.1.0",
    role: "coder",
    tools: ["read"],
    capabilities: { permitted: [], default: [] },
    files,
    secrets: [],
    thresholds: [],
  } as unknown as PositionManifest;
  return { manifest, dir, hash: "deadbeef" } as unknown as LoadedPosition;
}

// A scratch agent dir with an overrides/files tree but nothing inside it yet.
function scratchAgentDir(name: string): string {
  const dir = join(s.agentsRoot, name);
  mkdirSync(join(dir, "overrides", "files"), { recursive: true });
  return dir;
}

// ---------------------------------------------------------------------------
describe("bob#195 round 3, blocker 1 — a same-user grant write is DETECTED at boot", () => {
  it("a plain fs write to the resolved grant path is DETECTED: boot refuses the edited grant", async () => {
    await hireBuilder("tf1");
    expect(() => resolve("tf1")).not.toThrow();
    const g = JSON.parse(readFileSync(grantFile("tf1"), "utf8"));
    // The exact write a built-in file tool performs when it is handed this
    // absolute path: the placement is not a wall, so boot must DETECT the edit.
    writeFileSync(
      grantFile("tf1"),
      `${JSON.stringify({ ...g, position: { ...g.position, hash: "0".repeat(64) } }, null, 2)}\n`,
    );
    expect(() => resolve("tf1")).toThrow(/ratified hash/);
  });

  it("a truncated/unparsable grant is a LOUD refusal, never a fallback", async () => {
    await hireBuilder("tf2");
    expect(() => resolve("tf2")).not.toThrow();
    writeFileSync(grantFile("tf2"), "not json at all\n");
    expect(() => resolve("tf2")).toThrow(/unparsable/);
  });
});

// ---------------------------------------------------------------------------
describe("bob#195 round 3, blocker 2 — marker PRESENCE decides, contents never do", () => {
  const markerPath = (name: string) => bindingMarkerPath(join(s.agentsRoot, name));

  it("a MALFORMED (unparsable) marker still counts as present and refuses boot, naming the file", async () => {
    await hireBuilder("mk1");
    rmSync(grantFile("mk1"));
    writeFileSync(markerPath("mk1"), "{ not json\n");
    let err: unknown;
    try {
      resolve("mk1");
    } catch (e) {
      err = e;
    }
    const msg = String((err as Error)?.message);
    expect(msg).toMatch(/grant is missing/i);
    expect(msg).toContain(markerPath("mk1"));
  });

  it("a FALSEY-JSON marker (`null`) is still PRESENT and refuses boot", async () => {
    await hireBuilder("mk2");
    rmSync(grantFile("mk2"));
    writeFileSync(markerPath("mk2"), "null");
    let err: unknown;
    try {
      resolve("mk2");
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(String((err as Error)?.message)).toContain(markerPath("mk2"));
  });

  it("a well-formed marker with no grant refuses boot, naming the marker file", async () => {
    await hireBuilder("mk3");
    rmSync(grantFile("mk3"));
    let err: unknown;
    try {
      resolve("mk3");
    } catch (e) {
      err = e;
    }
    expect(String((err as Error)?.message)).toContain(markerPath("mk3"));
  });

  it("no marker and no grant is an ordinary un-adopted agent (it does not refuse)", () => {
    const agentDir = scratchAgentDir("mk4");
    writeFileSync(join(agentDir, "bob.yaml"), "agent:\n  role: custom\n\nbob:\n");
    expect(readBindingMarker(agentDir)).toBeUndefined();
    expect(existsSync(bindingMarkerPath(agentDir))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("bob#195 round 3, blocker 3 — declared and present override paths are BOTH checked; reads are confined", () => {
  it("refuses a path DECLARED in overrides.json that the manifest does not allow-list (even when absent)", () => {
    const agentDir = scratchAgentDir("ovd1");
    writeFileSync(
      join(overridesDir(agentDir), "overrides.json"),
      `${JSON.stringify({ disable: { tools: [], capabilities: [] }, files: [{ path: "ghost.md" }] }, null, 2)}\n`,
    );
    const pos = loadedPosition([{ path: "keep.md", kind: "skill" }], { "keep.md": "packaged\n" });
    let err: unknown;
    try {
      resolvePositionFiles(pos, agentDir);
    } catch (e) {
      err = e;
    }
    const msg = String((err as Error)?.message);
    expect(msg).toMatch(/ghost\.md/);
    expect(msg).toMatch(/declared/);
  });

  it("refuses a file PRESENT under overrides/files/ with NO document (the tree is checked regardless)", () => {
    const agentDir = scratchAgentDir("ovd2");
    // No overrides.json at all — only the stray file the tree carries.
    writeFileSync(join(overridesDir(agentDir), "files", "evil.md"), "stray\n");
    const pos = loadedPosition([{ path: "keep.md", kind: "skill" }], { "keep.md": "packaged\n" });
    expect(() => resolvePositionFiles(pos, agentDir)).toThrow(/evil\.md/);
  });

  it("realpath-confines an override read: a symlink that escapes the override tree is refused", () => {
    const agentDir = scratchAgentDir("ovd3");
    const outside = join(s.base, "outside-secret.txt");
    writeFileSync(outside, "OUTSIDE\n");
    writeFileSync(
      join(overridesDir(agentDir), "overrides.json"),
      `${JSON.stringify({ disable: { tools: [], capabilities: [] }, files: [{ path: "keep.md" }] }, null, 2)}\n`,
    );
    symlinkSync(outside, join(overridesDir(agentDir), "files", "keep.md"));
    const pos = loadedPosition([{ path: "keep.md", kind: "skill" }], { "keep.md": "packaged\n" });
    let err: unknown;
    try {
      resolvePositionFiles(pos, agentDir);
    } catch (e) {
      err = e;
    }
    expect(String((err as Error)?.message)).toMatch(/resolves outside/);
  });
});

// ---------------------------------------------------------------------------
describe("bob#195 round 3, blocker 4 — both reference forms are a single top-level name, stable across hire and boot", () => {
  it("hires and boots by bare name AND by the `path:` form, resolving the same position each time", async () => {
    await hireAgent({
      name: "ref1",
      positionName: "builder",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      skipFlair: true,
      interview: noopInterview,
    });
    expect(readGrant(s.hostRoot, "ref1")?.position.name).toBe("builder");
    const sink1: RunSessionConfig[] = [];
    await runAgent({
      name: "ref1",
      prompt: "go",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      sessionFactory: capturingFactory(sink1),
    });
    expect(sink1[0].tools).toContain("read");

    await hireAgent({
      name: "ref2",
      positionName: "path:builder",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      skipFlair: true,
      interview: noopInterview,
    });
    // The grant pins the TOP-LEVEL name, so boot reloads the same directory.
    expect(readGrant(s.hostRoot, "ref2")?.position.name).toBe("builder");
    const sink2: RunSessionConfig[] = [];
    await runAgent({
      name: "ref2",
      prompt: "go",
      agentsRoot: s.agentsRoot,
      hostRoot: s.hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      sessionFactory: capturingFactory(sink2),
    });
    expect(sink2[0].tools).toContain("read");
  });

  it("refuses a NESTED `path:` reference at hire, naming the rule, with nothing committed", async () => {
    const nestedDir = join(s.positionsRoot, "sub", "nested");
    mkdirSync(nestedDir, { recursive: true });
    writeFileSync(
      join(nestedDir, "position.json"),
      `${JSON.stringify(
        {
          name: "nested",
          version: "0.1.0",
          role: "coder",
          tools: ["read"],
          capabilities: { permitted: [], default: [] },
          files: [{ path: "soul.md", kind: "soul" }],
        },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(nestedDir, "soul.md"), "nested soul\n");
    let err: unknown;
    try {
      await hireAgent({
        name: "ref3",
        positionName: "path:sub/nested",
        agentsRoot: s.agentsRoot,
        hostRoot: s.hostRoot,
        positionsRoot: s.positionsRoot,
        skipFlair: true,
        interview: noopInterview,
      });
    } catch (e) {
      err = e;
    }
    expect(String((err as Error)?.message)).toMatch(/single top-level name/);
    expect(existsSync(join(s.agentsRoot, "ref3"))).toBe(false);
  });
});

// ===========================================================================
// ROUND 4
// ===========================================================================

// Build the JSON text of a grant with one field overridden, written back to the
// agent's grant file. `writeGrant` derives its path from `grant.agent`, so an
// agent-field mutation must be written directly.
const writeGrantText = (name: string, mutate: (g: Record<string, unknown>) => void) => {
  const g = JSON.parse(readFileSync(grantFile(name), "utf8")) as Record<string, unknown>;
  mutate(g);
  writeFileSync(grantFile(name), `${JSON.stringify(g, null, 2)}\n`);
};

// ---------------------------------------------------------------------------
describe("bob#195 round 4, blocker 1 — boot compares the grant's OWN frozen fields with the packaged artifacts", () => {
  it("refuses a grant whose `agent` does not match the booted agent", async () => {
    await hireBuilder("ga1");
    writeGrantText("ga1", (g) => {
      g.agent = "someone-else";
    });
    let err: unknown;
    try {
      resolve("ga1");
    } catch (e) {
      err = e;
    }
    const msg = String((err as Error)?.message);
    expect(msg).toMatch(/agent/);
    expect(msg).toContain("someone-else");
    expect(msg).toContain("ga1");
    expect(msg).toMatch(/re-hire or re-adopt/);
  });

  it("refuses a grant whose `maxTools` does not equal the selected manifest's tool set", async () => {
    await hireBuilder("gt1");
    const g = readGrant(s.hostRoot, "gt1");
    if (!g) throw new Error("no grant");
    // WIDER than the manifest; bob.yaml still requests only the position's set,
    // so nothing but the grant-vs-manifest comparison can refuse this.
    writeGrant(s.hostRoot, { ...g, maxTools: [...g.maxTools, "ls"] });
    let err: unknown;
    try {
      resolve("gt1");
    } catch (e) {
      err = e;
    }
    const msg = String((err as Error)?.message);
    expect(msg).toMatch(/maxTools/);
    expect(msg).toContain("ls");
    expect(msg).toMatch(/re-hire or re-adopt/);
  });

  it("refuses a grant whose `maxCapabilities` does not equal the selected manifest's capability set", async () => {
    await hireBuilder("gc1");
    const g = readGrant(s.hostRoot, "gc1");
    if (!g) throw new Error("no grant");
    // bob.yaml requests none (the position's default is empty), so only the
    // grant-vs-manifest comparison can refuse this.
    writeGrant(s.hostRoot, { ...g, maxCapabilities: [...g.maxCapabilities, "observatory"] });
    let err: unknown;
    try {
      resolve("gc1");
    } catch (e) {
      err = e;
    }
    const msg = String((err as Error)?.message);
    expect(msg).toMatch(/maxCapabilities/);
    expect(msg).toContain("observatory");
    expect(msg).toMatch(/re-hire or re-adopt/);
  });

  it("refuses a grant whose `allowResidentShell` does not equal the packaged role's flag", async () => {
    await hireBuilder("gr1");
    const g = readGrant(s.hostRoot, "gr1");
    if (!g) throw new Error("no grant");
    expect(g.allowResidentShell).toBe(true); // the coder role grants a resident shell
    writeGrant(s.hostRoot, { ...g, allowResidentShell: false });
    let err: unknown;
    try {
      resolve("gr1");
    } catch (e) {
      err = e;
    }
    const msg = String((err as Error)?.message);
    expect(msg).toMatch(/allowResidentShell/);
    expect(msg).toContain("coder");
    expect(msg).toContain("false");
    expect(msg).toMatch(/re-hire or re-adopt/);
  });
});

// ---------------------------------------------------------------------------
describe("bob#195 round 4, blocker 2 — marker presence is the directory ENTRY, not the read", () => {
  it("a PRESENT marker whose read returns ENOENT (a dangling symlink) still refuses boot", async () => {
    await hireBuilder("mk5");
    const marker = bindingMarkerPath(join(s.agentsRoot, "mk5"));
    rmSync(grantFile("mk5"));
    // Replace the marker with a symlink whose target does not exist: the entry
    // is present (lstat sees it), the read returns ENOENT.
    rmSync(marker);
    symlinkSync(join(s.base, "does-not-exist.json"), marker);
    let err: unknown;
    try {
      resolve("mk5");
    } catch (e) {
      err = e;
    }
    const msg = String((err as Error)?.message);
    expect(msg).toMatch(/grant is missing/i);
    expect(msg).toContain(marker);
  });
});

// ---------------------------------------------------------------------------
describe("bob#195 round 4, blocker 3 — the override scan covers symlinks and ENFORCES agreement", () => {
  it("refuses an UNLISTED present SYMLINK entry under overrides/files/", () => {
    const agentDir = scratchAgentDir("ovs1");
    // A symlink entry the manifest does not allow-list. A symlink is not a
    // regular file, so the scan must SEE it and put it in the present list.
    symlinkSync("keep.md", join(overridesDir(agentDir), "files", "evil.md"));
    const pos = loadedPosition([{ path: "keep.md", kind: "skill" }], { "keep.md": "packaged\n" });
    let err: unknown;
    try {
      resolvePositionFiles(pos, agentDir);
    } catch (e) {
      err = e;
    }
    const msg = String((err as Error)?.message);
    expect(msg).toContain("evil.md");
    expect(msg).toMatch(/not allow-listed/);
  });

  it("refuses a file PRESENT under overrides/files/ but NOT DECLARED (agreement is enforced)", () => {
    const agentDir = scratchAgentDir("ovs2");
    writeFileSync(
      join(overridesDir(agentDir), "overrides.json"),
      `${JSON.stringify({ disable: { tools: [], capabilities: [] }, files: [] }, null, 2)}\n`,
    );
    writeFileSync(join(overridesDir(agentDir), "files", "keep.md"), "override\n");
    const pos = loadedPosition([{ path: "keep.md", kind: "skill" }], { "keep.md": "packaged\n" });
    let err: unknown;
    try {
      resolvePositionFiles(pos, agentDir);
    } catch (e) {
      err = e;
    }
    const msg = String((err as Error)?.message);
    expect(msg).toContain("keep.md");
    expect(msg).toMatch(/not declared/);
  });

  it("refuses a file DECLARED and allow-listed but ABSENT from overrides/files/ (agreement is enforced)", () => {
    const agentDir = scratchAgentDir("ovs3");
    writeFileSync(
      join(overridesDir(agentDir), "overrides.json"),
      `${JSON.stringify({ disable: { tools: [], capabilities: [] }, files: [{ path: "keep.md" }] }, null, 2)}\n`,
    );
    const pos = loadedPosition([{ path: "keep.md", kind: "skill" }], { "keep.md": "packaged\n" });
    let err: unknown;
    try {
      resolvePositionFiles(pos, agentDir);
    } catch (e) {
      err = e;
    }
    const msg = String((err as Error)?.message);
    expect(msg).toContain("keep.md");
    expect(msg).toMatch(/not present/);
  });
});
