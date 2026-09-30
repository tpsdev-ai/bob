// bob#244 (web spec v3, slice R1a): the web composition rule on REAL pi
// sessions, built by bob's one session factory. Refusal is proven at the three
// points the factory audits:
//
//   CREATION  before anything is built (a web session that would hold a private
//             capability, a private-data built-in, a soul, a standing contract,
//             or history — including history that once held a private
//             capability — is refused before any extension loads);
//   REBIND    after the mode binds extensions (an extension's resources_discover
//             adds a skill: unclassified startup context);
//   RELOAD    after session.reload() (a reloaded extension adds a prompt
//             template: unclassified startup context).
//
// Each refusal is paired with the control that shows the same session is
// accepted without the private input, so the refusal is the rule's and not an
// accident of the fixture.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { capabilityConfigEnv, resolveCapabilities } from "../../src/shell/capability-loader.js";
import { WebCompositionError, webSessionSystemPrompt } from "../../src/shell/data-class.js";
import { initAgent } from "../../src/shell/init.js";
import { type RunSessionConfig, resolveRunConfig } from "../../src/shell/run.js";
import {
  auditWebSession,
  contractBlockFor,
  createBobRuntimeFactory,
} from "../../src/shell/session.js";
import type { ToolPolicy } from "../../src/shell/tool-allowlist.js";

// The env the factory writes (capability configs, the runtime-mode signal) is
// restored after each test, so nothing here leaks into another file's run.
const ENV_KEYS = [
  "BOB_CAP_WEB",
  "BOB_CAP_FIXTURE",
  "BOB_CAP_ANCHORED_EDIT",
  "BOB_CAP_FLAIR",
  "BOB_PERSISTENT",
] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: string;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  root = mkdtempSync(join(tmpdir(), "bob-web-comp-"));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(root, { recursive: true, force: true });
});

interface Agent {
  cwd: string;
  piAgentDir: string;
  config: RunSessionConfig;
  policy: ToolPolicy;
}

// A real agent on disk (bob.yaml, soul.md, .pi-agent) whose session config is
// then pointed at the capabilities under test. Everything lives under `root`.
function scaffold(parent = "agents"): Agent {
  const agentsRoot = join(root, parent);
  const res = initAgent({
    name: "webbot",
    role: "ea",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    contextWindow: 200_000,
    agentsRoot,
    flairKeysDir: join(root, ".flair", "keys"),
    skipFlair: true,
  });
  const { config, policy } = resolveRunConfig({ name: "webbot", agentsRoot });
  return {
    cwd: join(res.agentDir, "work"),
    piAgentDir: join(res.agentDir, ".pi-agent"),
    config,
    policy,
  };
}

// Resolve real capabilities through the catalog and the exports map, plus any
// probe extensions (path -> the capability name bob attributes it to).
function compose(
  agent: Agent,
  opts: {
    capabilities: string[];
    probes?: Array<{ path: string; as: string }>;
    tools?: string[];
    soul?: string;
    taskContract?: string;
    standingContract?: string;
  },
): { config: RunSessionConfig; policy: ToolPolicy } {
  const yaml = `capabilities:\n${opts.capabilities.map((c) => `  - ${c}`).join("\n")}\n`;
  const resolution = resolveCapabilities({ yamlText: yaml });
  const probes = opts.probes ?? [];
  const config: RunSessionConfig = {
    ...agent.config,
    appendSystemPrompt: opts.soul ?? "",
    extensionSources: [...resolution.extensionSources, ...probes.map((p) => p.path)],
    capabilityBySource: {
      ...Object.fromEntries(resolution.capabilities.map((c) => [c.piPackage, c.name])),
      ...Object.fromEntries(probes.map((p) => [p.path, p.as])),
    },
    capabilityEnv: capabilityConfigEnv(resolution),
  };
  delete config.taskContract;
  delete config.standingContract;
  if (opts.taskContract !== undefined) config.taskContract = opts.taskContract;
  if (opts.standingContract !== undefined) config.standingContract = opts.standingContract;
  const policy: ToolPolicy = {
    ...agent.policy,
    tools: opts.tools ?? [],
    excludeTools: [],
  };
  return { config, policy };
}

async function build(
  agent: Agent,
  composed: { config: RunSessionConfig; policy: ToolPolicy },
  sessionManager = SessionManager.inMemory(agent.cwd),
) {
  const logs: string[] = [];
  const exits: number[] = [];
  const factory = createBobRuntimeFactory({
    config: composed.config,
    policy: composed.policy,
    deps: { log: (m) => logs.push(m), exit: (code) => exits.push(code) },
  });
  const result = await factory({
    cwd: agent.cwd,
    agentDir: agent.piAgentDir,
    sessionManager: sessionManager as never,
  });
  const session = result.session as unknown as {
    getActiveToolNames(): string[];
    readonly systemPrompt: string;
    readonly sessionManager: unknown;
    reload(options?: unknown): Promise<void>;
    bindExtensions(bindings: unknown): Promise<void>;
    dispose(): void;
  };
  let disposals = 0;
  const dispose = session.dispose.bind(session);
  session.dispose = () => {
    disposals += 1;
    dispose();
  };
  return {
    session,
    cwd: result.services.cwd,
    loader: result.services.resourceLoader,
    logs,
    exits,
    disposals: () => disposals,
  };
}

// A probe extension file under `root`.
function probe(name: string, body: string): string {
  const dir = join(root, "probes");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.js`);
  writeFileSync(path, body);
  return path;
}

describe("the control: a public-only web session is composed", () => {
  it("web + fixture, no soul, the admitted task, fresh history: created, and the web extension loads with no tool", async () => {
    const agent = scaffold();
    const built = await build(
      agent,
      compose(agent, {
        capabilities: ["fixture", "web"],
        tools: ["bob_fixture_noop"],
        taskContract: "fetch the page the operator named",
      }),
    );
    try {
      expect(built.session.getActiveToolNames()).toEqual(["bob_fixture_noop"]);
      const loaded = built.loader.getExtensions().extensions;
      const web = loaded.find((e) => e.path.endsWith("/dist/capabilities/web/index.js"));
      expect(web, "the real web extension loaded").toBeDefined();
      expect([...(web?.tools.keys() ?? [])], "web registers no tool in R1a").toEqual([]);
      // The contract guard (bob's own, public row) is in the session too.
      expect(loaded.map((e) => e.path)).toContain("<inline:bob-contract-guard>");
      // A bind and a reload of the same session pass the rule as well.
      await built.session.bindExtensions({});
      await built.session.reload();
      expect(built.exits).toEqual([]);
    } finally {
      built.session.dispose();
    }
  });
});

describe("the system prompt a web session sends names nothing local", () => {
  // The agent lives under a directory whose name must never reach a web
  // session's prompt.
  const MARKER = "SENSITIVE-private-dir-7f3a";
  const TASK = "fetch the page the operator named";

  it("a real web session sends bob's reviewed prompt: no working directory, no pi install path", async () => {
    const agent = scaffold(join(MARKER, "agents"));
    expect(agent.cwd).toContain(MARKER);
    const composed = compose(agent, {
      capabilities: ["fixture", "web"],
      tools: ["bob_fixture_noop"],
      taskContract: TASK,
    });
    const built = await build(agent, composed);
    try {
      expect(built.cwd, "a web session has no workspace").toBe("/");
      const block = contractBlockFor(composed.config) as string;
      expect(built.session.systemPrompt).toBe(webSessionSystemPrompt([block]));
      expect(built.session.systemPrompt).not.toContain(MARKER);
      expect(built.session.systemPrompt).not.toContain(agent.cwd);
      expect(built.session.systemPrompt).not.toContain("pi-coding-agent");
      // The prompt still holds after a bind and a reload (pi rebuilds it).
      await built.session.bindExtensions({});
      await built.session.reload();
      expect(built.session.systemPrompt).toBe(webSessionSystemPrompt([block]));
      expect(built.exits).toEqual([]);
    } finally {
      built.session.dispose();
    }
  });

  it("the control: the same agent WITHOUT web sends pi's template, which names both", async () => {
    const agent = scaffold(join(MARKER, "agents"));
    const built = await build(
      agent,
      compose(agent, {
        capabilities: ["fixture"],
        tools: ["bob_fixture_noop"],
        taskContract: TASK,
      }),
    );
    try {
      expect(built.cwd).toBe(agent.cwd);
      expect(built.session.systemPrompt).toContain(`Current working directory: ${agent.cwd}`);
      expect(built.session.systemPrompt).toContain(MARKER);
      expect(built.session.systemPrompt).toContain("pi-coding-agent");
    } finally {
      built.session.dispose();
    }
  });

  it("the audit refuses a real session whose assembled prompt names local paths", async () => {
    // pi's own template, with the sensitive working directory, read by the
    // real audit as if the session held web: only the assembled prompt is wrong.
    const agent = scaffold(join(MARKER, "agents"));
    const composed = compose(agent, {
      capabilities: ["fixture"],
      tools: ["bob_fixture_noop"],
      taskContract: TASK,
    });
    const built = await build(agent, composed);
    try {
      const asWeb = {
        ...composed.config,
        capabilityBySource: Object.fromEntries(
          Object.keys(composed.config.capabilityBySource ?? {}).map((source) => [source, "web"]),
        ),
      };
      const audit = () =>
        auditWebSession({
          session: built.session,
          loader: built.loader,
          config: asWeb,
          contractBlock: contractBlockFor(composed.config) as string,
          checkedSessionManager: built.session.sessionManager,
        });
      expect(audit).toThrow(WebCompositionError);
      expect(audit).toThrow("the system prompt pi assembled is not the reviewed web prompt");
      let message = "";
      try {
        audit();
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toContain(MARKER);
    } finally {
      built.session.dispose();
    }
  });
});

describe("refused at CREATION, before anything is built", () => {
  // A probe that records its own load: its marker proves whether the factory
  // got as far as loading extensions.
  const markerProbe = (marker: string) =>
    `import { writeFileSync } from "node:fs";\nexport default function (pi) { writeFileSync(${JSON.stringify(marker)}, "loaded"); }\n`;

  it("web + a private capability is refused before any extension loads (and the public twin loads)", async () => {
    const agent = scaffold();
    const marker = join(root, "loaded.marker");
    const path = probe("marker", markerProbe(marker));

    const refused = compose(agent, { capabilities: ["web"], probes: [{ path, as: "flair" }] });
    await expect(build(agent, refused)).rejects.toThrow(`capability "flair" is private-class`);
    expect(existsSync(marker), "refused before the probe extension loaded").toBe(false);

    // The same probe attributed to a PUBLIC capability composes, and loads.
    const accepted = await build(
      agent,
      compose(agent, { capabilities: ["web"], probes: [{ path, as: "presence" }] }),
    );
    accepted.session.dispose();
    expect(existsSync(marker), "the control reached extension load").toBe(true);
  });

  it("web + a private-data built-in (read) is refused", async () => {
    const agent = scaffold();
    await expect(
      build(agent, compose(agent, { capabilities: ["fixture", "web"], tools: ["read"] })),
    ).rejects.toThrow(`pi's built-in tool "read" reads or writes local data`);
  });

  it("web + the agent's soul is refused (unattributed startup context)", async () => {
    const agent = scaffold();
    await expect(
      build(
        agent,
        compose(agent, { capabilities: ["web"], soul: agent.config.appendSystemPrompt }),
      ),
    ).rejects.toThrow(`startup context "soul" is private`);
    // The scaffold's soul is real content, not an empty string.
    expect(agent.config.appendSystemPrompt.length).toBeGreaterThan(0);
  });

  it("web + a standing contract (the persistent runtime's) is refused", async () => {
    const agent = scaffold();
    await expect(
      build(agent, compose(agent, { capabilities: ["web"], standingContract: "keep your duties" })),
    ).rejects.toThrow(`startup context "standing-contract" is private`);
  });

  it("a session whose history once held a private capability never becomes a web session", async () => {
    const agent = scaffold();
    const history = SessionManager.inMemory(agent.cwd);

    // 1. A real session composed with a PRIVATE capability (anchored-edit, whose
    //    read_lines returns workspace bytes), on this history.
    const privateSession = await build(
      agent,
      compose(agent, { capabilities: ["anchored-edit"], tools: ["read_lines"] }),
      history,
    );
    expect(privateSession.session.getActiveToolNames()).toEqual(["read_lines"]);
    // 2. The private tool's result lands in the history.
    history.appendMessage({
      role: "toolResult",
      toolCallId: "call-1",
      toolName: "read_lines",
      content: [{ type: "text", text: "L1#00000000 a private line of the workspace" }],
      isError: false,
      timestamp: Date.now(),
    } as never);
    privateSession.session.dispose();
    expect(history.getEntries().length).toBeGreaterThan(0);

    // 3. The same history (a resume) composed with web is refused.
    const web = compose(agent, { capabilities: ["fixture", "web"], tools: ["bob_fixture_noop"] });
    const refusal = await build(agent, web, history).then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(refusal).toBeInstanceOf(WebCompositionError);
    expect((refusal as Error).message).toMatch(/restores \d+ history entr/);

    // The control: the identical composition on a fresh history is accepted.
    const fresh = await build(agent, web);
    fresh.session.dispose();
  });
});

describe("refused at REBIND and RELOAD, on what pi composed", () => {
  it("RELOAD: a session whose history source changed after creation is ended", async () => {
    const agent = scaffold();
    const built = await build(
      agent,
      compose(agent, { capabilities: ["fixture", "web"], tools: ["bob_fixture_noop"] }),
    );
    // Something other than the factory swaps the session's history source.
    (built.session as unknown as { sessionManager: unknown }).sessionManager =
      SessionManager.inMemory(agent.cwd);
    await expect(built.session.reload()).rejects.toThrow(/history source changed/);
    expect(built.disposals(), "the session is disposed").toBe(1);
    expect(built.exits, "the process is ended").toEqual([1]);
  });

  // A skill and a prompt template an extension can add through pi's
  // resources_discover — startup context bob never composed.
  function skillDir(): string {
    const dir = join(root, "skills", "probe-skill");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: probe-skill\ndescription: A skill a capability discovered.\n---\nDo the probe thing.\n",
    );
    return join(root, "skills");
  }
  function promptFile(): string {
    const dir = join(root, "prompts");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "probe-prompt.md");
    writeFileSync(
      path,
      "---\ndescription: A prompt template a capability discovered.\n---\nHello.\n",
    );
    return path;
  }
  const discovers = (kind: "skillPaths" | "promptPaths", path: string) =>
    `export default function (pi) { pi.on("resources_discover", () => ({ ${kind}: [${JSON.stringify(path)}] })); }\n`;

  it("REBIND: a public-class extension that discovers a skill at bind ends the web session", async () => {
    const agent = scaffold();
    const path = probe("skill-at-bind", discovers("skillPaths", skillDir()));
    const built = await build(
      agent,
      compose(agent, { capabilities: ["web"], probes: [{ path, as: "presence" }] }),
    );
    // Creation passed: the skill does not exist until the bind.
    expect(built.loader.getSkills().skills).toEqual([]);

    await expect(built.session.bindExtensions({})).rejects.toThrow(
      /unclassified startup context: skill "probe-skill"/,
    );
    expect(built.disposals(), "the session is disposed").toBe(1);
    expect(built.exits, "the process is ended").toEqual([1]);
    expect(built.logs.join("\n")).toContain("refusing a web session");
  });

  it("REBIND control: the same extension in a session WITHOUT web binds (the rule is web's)", async () => {
    const agent = scaffold();
    const path = probe("skill-no-web", discovers("skillPaths", skillDir()));
    const built = await build(
      agent,
      compose(agent, { capabilities: ["fixture"], probes: [{ path, as: "presence" }] }),
    );
    try {
      await built.session.bindExtensions({});
      expect(built.loader.getSkills().skills.map((s) => s.name)).toEqual(["probe-skill"]);
      expect(built.exits).toEqual([]);
    } finally {
      built.session.dispose();
    }
  });

  it("RELOAD: an extension that starts discovering a prompt template on reload ends the web session", async () => {
    const agent = scaffold();
    const path = probe("prompt-on-reload", "export default function (pi) {}\n");
    const built = await build(
      agent,
      compose(agent, { capabilities: ["web"], probes: [{ path, as: "presence" }] }),
    );
    // Bound with a real binding, so pi's reload re-runs session_start and
    // resources_discover. The first bind passes: nothing is discovered yet.
    await built.session.bindExtensions({ onError: () => {} });
    expect(built.exits).toEqual([]);

    writeFileSync(path, discovers("promptPaths", promptFile()));
    await expect(built.session.reload()).rejects.toThrow(
      /unclassified startup context: prompt template "probe-prompt"/,
    );
    expect(built.disposals(), "the session is disposed").toBe(1);
    expect(built.exits, "the process is ended").toEqual([1]);
  });
});
