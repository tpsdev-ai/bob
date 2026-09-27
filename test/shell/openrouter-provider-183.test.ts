// bob#183 — the openrouter provider. Round 3: bob CONSTRUCTS the provider in
// memory inside the ONE session factory (fixed endpoint, env key passed in
// memory, openai-completions, no per-model baseUrl) and REFUSES any on-disk
// openrouter entry in models.json/auth.json. Every entry path goes through the
// factory, so every entry path gets it. No network.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runAlign } from "../../src/shell/align.js";
import { initAgent } from "../../src/shell/init.js";
import { runOnboard } from "../../src/shell/onboard.js";
import { runPersistent } from "../../src/shell/persistent.js";
import { createPiRunSession, runAgent, runLaunch } from "../../src/shell/run.js";
import {
  assertNoOnDiskOpenrouter,
  assertOpenrouterRuntimeUnchanged,
  buildOpenrouterProvider,
  guardedOpenrouterFetch,
  guardOpenrouterRegistration,
  OPENROUTER_API,
  OPENROUTER_API_KEY_PLACEHOLDER,
  OPENROUTER_BASE_URL,
  openrouterTransport,
  registerOpenrouterProvider,
  runInteractiveSession,
} from "../../src/shell/session.js";

const MODEL = "deepseek/deepseek-v4.1-flash";
const BASE_URL = "https://openrouter.ai/api/v1";
const SENTINEL = "sk-or-v1-THIS-IS-A-SENTINEL-KEY-DO-NOT-WRITE";

/** A session factory that runs the REAL factory (so the construction runs) and
 *  records whether a session was produced, then aborts before any turn. */
function abortingFactory(record: { cfg: unknown; created?: boolean }) {
  const stop = new Error("stop-after-factory");
  const factory = async (cfg: unknown) => {
    const session = await createPiRunSession(cfg as never);
    (session as unknown as { dispose(): void }).dispose();
    record.cfg = cfg;
    record.created = true;
    throw stop;
  };
  return factory;
}

/** Spy on pi's registerProvider and CAPTURE the ModelRuntime instance it runs on. */
function spyRegisterProviderCapture() {
  const real = ModelRuntime.prototype.registerProvider;
  const calls: Array<{ id: string; config: Record<string, unknown> }> = [];
  let instance: ModelRuntime | undefined;
  ModelRuntime.prototype.registerProvider = function (
    this: ModelRuntime,
    id: string,
    config: Record<string, unknown>,
  ) {
    instance = this;
    calls.push({ id, config });
    return real.call(this, id, config);
  };
  return {
    calls,
    get instance(): ModelRuntime | undefined {
      return instance;
    },
    restore() {
      ModelRuntime.prototype.registerProvider = real;
    },
  };
}

/** Spy on pi's extension registerProvider so a test sees bob's constructed def. */
function spyRegisterProvider() {
  const real = ModelRuntime.prototype.registerProvider;
  const calls: Array<{ id: string; config: Record<string, unknown> }> = [];
  ModelRuntime.prototype.registerProvider = function (
    this: ModelRuntime,
    id: string,
    config: never,
  ) {
    calls.push({ id, config: config as unknown as Record<string, unknown> });
    return real.call(this, id, config);
  };
  return {
    calls,
    restore: () => {
      ModelRuntime.prototype.registerProvider = real;
    },
  };
}

function assertConstructed(cfg: Record<string, unknown>) {
  expect(cfg.baseUrl).toBe(BASE_URL);
  expect(cfg.api).toBe("openai-completions");
  // pi holds ONLY bob's NON-SECRET placeholder — never the real key (round 6).
  expect(cfg.apiKey).toBe(OPENROUTER_API_KEY_PLACEHOLDER);
  expect(cfg.apiKey).not.toBe(process.env.OPENROUTER_API_KEY);
  // The provider carries bob's transport (streamSimple).
  expect(typeof cfg.streamSimple).toBe("function");
  const models = cfg.models as Array<Record<string, unknown>>;
  expect(models).toHaveLength(1);
  expect(models[0]!.id).toBe(MODEL);
  // NO per-model baseUrl: the endpoint comes from bob's provider, not the entry.
  expect(Object.hasOwn(models[0]!, "baseUrl")).toBe(false);
}

describe("openrouter provider (bob#183 round 3)", () => {
  let agentsRoot: string;
  let flairKeysDir: string;
  let servers: Server[] = [];
  const prevKey = process.env.OPENROUTER_API_KEY;
  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-or-agents-"));
    flairKeysDir = mkdtempSync(join(tmpdir(), "bob-or-keys-"));
  });
  afterEach(() => {
    for (const s of servers) s.close();
    servers = [];
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
    rmSync(agentsRoot, { recursive: true, force: true });
    rmSync(flairKeysDir, { recursive: true, force: true });
  });
  function scaffold(name: string) {
    const r = initAgent({
      name,
      role: "coder",
      provider: "openrouter",
      model: MODEL,
      agentsRoot,
      flairKeysDir,
      skipFlair: true,
    });
    return { agentDir: r.agentDir, piDir: join(r.agentDir, ".pi-agent") };
  }
  const modelsPath = (piDir: string) => join(piDir, "models.json");
  const authPath = (piDir: string) => join(piDir, "auth.json");

  it("(a) init declares the provider in bob.yaml and writes NO on-disk openrouter entry (bob owns it)", () => {
    const { agentDir, piDir } = scaffold("orra");
    const yaml = readFileSync(join(agentDir, "bob.yaml"), "utf8");
    expect(yaml).toContain("name: openrouter");
    expect(yaml).toContain(MODEL);
    const models = JSON.parse(readFileSync(modelsPath(piDir), "utf8"));
    expect(models.providers.openrouter).toBeUndefined();
    const auth = JSON.parse(readFileSync(authPath(piDir), "utf8"));
    expect(auth.openrouter).toBeUndefined();
  });

  it("(a2) the constructed provider: constant baseUrl, PLACEHOLDER key (never the real key), openai-completions, a transport, no per-model baseUrl", () => {
    process.env.OPENROUTER_API_KEY = SENTINEL;
    const cfg = buildOpenrouterProvider({ model: MODEL, apiKey: process.env.OPENROUTER_API_KEY! });
    assertConstructed(cfg as unknown as Record<string, unknown>);
  });

  it("(b1) runAgent creates the openrouter session ONLY through the factory, with the constructed provider", async () => {
    scaffold("orrb1");
    process.env.OPENROUTER_API_KEY = SENTINEL;
    const spy = spyRegisterProvider();
    try {
      const rec: { cfg: unknown } = { cfg: null };
      await expect(
        runAgent({
          name: "orrb1",
          prompt: "hi",
          agentsRoot,
          sessionFactory: abortingFactory(rec) as never,
        }),
      ).rejects.toThrow("stop-after-factory");
      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]!.id).toBe("openrouter");
      assertConstructed(spy.calls[0]!.config);
    } finally {
      spy.restore();
    }
  });

  it("(b2) runLaunch (prompted) routes through the same factory", async () => {
    scaffold("orrb2");
    process.env.OPENROUTER_API_KEY = SENTINEL;
    const spy = spyRegisterProvider();
    try {
      const rec: { cfg: unknown } = { cfg: null };
      await expect(
        runLaunch({
          name: "orrb2",
          prompt: "hi",
          agentsRoot,
          sessionFactory: abortingFactory(rec) as never,
        }),
      ).rejects.toThrow("stop-after-factory");
      expect(spy.calls).toHaveLength(1);
      assertConstructed(spy.calls[0]!.config);
    } finally {
      spy.restore();
    }
  });

  it("(b3) runLaunch (interactive) routes through the same factory", async () => {
    scaffold("orrb3");
    process.env.OPENROUTER_API_KEY = SENTINEL;
    const spy = spyRegisterProvider();
    try {
      let modeRan = false;
      await runLaunch({
        name: "orrb3",
        agentsRoot,
        interactive: ((i: never) =>
          runInteractiveSession({
            ...(i as object),
            modeFactory: () => ({
              run: async () => {
                modeRan = true;
              },
            }),
          })) as never,
      });
      expect(modeRan).toBe(true);
      expect(spy.calls).toHaveLength(1);
      assertConstructed(spy.calls[0]!.config);
    } finally {
      spy.restore();
    }
  });

  it("(b4) persistent routes through the same factory", async () => {
    scaffold("orrb4");
    process.env.OPENROUTER_API_KEY = SENTINEL;
    const spy = spyRegisterProvider();
    try {
      const rec: { cfg: unknown } = { cfg: null };
      await expect(
        runPersistent({
          name: "orrb4",
          agentsRoot,
          sessionFactory: abortingFactory(rec) as never,
          installSignalHandlers: false,
          keepAlive: () => Promise.resolve(),
          log: () => {},
        }),
      ).rejects.toThrow("stop-after-factory");
      expect(spy.calls).toHaveLength(1);
      assertConstructed(spy.calls[0]!.config);
    } finally {
      spy.restore();
    }
  });

  it("(b5) onboard routes through the same factory", async () => {
    const { agentDir } = scaffold("orrb5");
    process.env.OPENROUTER_API_KEY = SENTINEL;
    const spy = spyRegisterProvider();
    try {
      await runOnboard({
        name: "orrb5",
        role: "coder",
        agentDir,
        provider: "openrouter",
        model: MODEL,
        sessionRunner: ((i: never) =>
          runInteractiveSession({
            ...(i as object),
            modeFactory: () => ({ run: async () => {} }),
          })) as never,
      });
      expect(spy.calls).toHaveLength(1);
      assertConstructed(spy.calls[0]!.config);
    } finally {
      spy.restore();
    }
  });

  it("(b6) align routes through the same factory", async () => {
    const { agentDir } = scaffold("orrb6");
    process.env.OPENROUTER_API_KEY = SENTINEL;
    const spy = spyRegisterProvider();
    try {
      await runAlign({
        name: "orrb6",
        agentDir,
        sessionRunner: ((i: never) =>
          runInteractiveSession({
            ...(i as object),
            modeFactory: () => ({ run: async () => {} }),
          })) as never,
      });
      expect(spy.calls).toHaveLength(1);
      assertConstructed(spy.calls[0]!.config);
    } finally {
      spy.restore();
    }
  });

  it("(c) the run path's PERSISTED files never contain the env key (sentinel). NOTE: a live model turn cannot run offline, so no pi session/trajectory file is produced; this proves the files bob and the run path write (bob.yaml, launcher, pi config, run log) carry no key — not a pi session file", async () => {
    const { agentDir, piDir } = scaffold("orrc");
    process.env.OPENROUTER_API_KEY = SENTINEL;
    // The session object is a stub: offline there is no model turn, so pi writes
    // no session/trajectory file. What is REAL here is bob's run path — it writes
    // the launcher, the pi config and the per-run JSONL log this test inspects.
    const factory = async () =>
      ({
        subscribe: () => () => {},
        prompt: async () => {},
        dispose: () => {},
      }) as never;
    await runAgent({ name: "orrc", prompt: "hi", agentsRoot, sessionFactory: factory });

    const runsDir = join(agentDir, "runs");
    const targets = [
      join(agentDir, "bob.yaml"),
      join(agentDir, "bin", "orrc"),
      modelsPath(piDir),
      authPath(piDir),
    ];
    // REQUIRED: every named file must exist (a check that cannot fire is not a check).
    for (const p of targets) expect(existsSync(p), `expected ${p} to exist`).toBe(true);
    expect(existsSync(runsDir)).toBe(true);
    const logs = readdirSync(runsDir).filter((n) => n.endsWith(".jsonl"));
    expect(logs.length).toBeGreaterThanOrEqual(1);
    for (const p of [...targets, ...logs.map((n) => join(runsDir, n))]) {
      expect(readFileSync(p, "utf8"), `${p} must not contain the key`).not.toContain(SENTINEL);
    }
  });

  it("(2a) a per-model baseUrl in the file is NEUTRALIZED: the composed openrouter model keeps the constant endpoint", async () => {
    const { piDir } = scaffold("orr2a");
    // A tampered file: the selected model carries its own baseUrl AND the provider
    // does too. Drive pi's composer DIRECTLY and register bob's definition.
    const models = JSON.parse(readFileSync(modelsPath(piDir), "utf8"));
    models.providers = {
      openrouter: {
        baseUrl: "http://127.0.0.1:9/v1",
        models: [{ id: MODEL, name: MODEL, baseUrl: "http://127.0.0.1:9/model" }],
      },
    };
    writeFileSync(modelsPath(piDir), JSON.stringify(models, null, 2));

    const rt = await ModelRuntime.create({
      authPath: authPath(piDir),
      modelsPath: modelsPath(piDir),
    });
    rt.registerProvider("openrouter", buildOpenrouterProvider({ model: MODEL, apiKey: SENTINEL }));
    const model = rt.getModel("openrouter", MODEL);
    expect(model).toBeDefined();
    expect(model!.baseUrl).toBe(BASE_URL);
    expect(model!.baseUrl).not.toContain("127.0.0.1");
  });

  it("(2a-listener) the refusal happens BEFORE any request: a file endpoint is refused and a local listener is never hit", async () => {
    // What this test PROVES: the run is refused before any HTTP request — a
    // listener URL written into models.json is never hit. The URL proof (that the
    // composed model keeps bob's endpoint, not the file's) is the composer
    // assertion at the end of this test.
    const { piDir } = scaffold("orr2l");
    process.env.OPENROUTER_API_KEY = SENTINEL;
    let hits = 0;
    const srv = createServer((_req, res) => {
      hits++;
      res.end("{}");
    });
    servers.push(srv);
    const port = await new Promise<number>((res) =>
      srv.listen(0, "127.0.0.1", () => res((srv.address() as { port: number }).port)),
    );
    const models = JSON.parse(readFileSync(modelsPath(piDir), "utf8"));
    models.providers = {
      openrouter: {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        models: [{ id: MODEL, name: MODEL, baseUrl: `http://127.0.0.1:${port}/model` }],
      },
    };
    writeFileSync(modelsPath(piDir), JSON.stringify(models, null, 2));

    const rec: { cfg: unknown } = { cfg: null };
    await expect(
      runAgent({
        name: "orr2l",
        prompt: "hi",
        agentsRoot,
        sessionFactory: abortingFactory(rec) as never,
      }),
    ).rejects.toThrow(/providers\.openrouter entry/);
    expect(rec.cfg).toBeNull(); // no session ever created
    await new Promise((r) => setTimeout(r, 50));
    expect(hits).toBe(0);

    // And driving pi's COMPOSER directly, bob's registration keeps the constant
    // endpoint even with the file's per-model baseUrl present.
    const rt = await ModelRuntime.create({
      authPath: authPath(piDir),
      modelsPath: modelsPath(piDir),
    });
    rt.registerProvider("openrouter", buildOpenrouterProvider({ model: MODEL, apiKey: SENTINEL }));
    const composed = rt.getModel("openrouter", MODEL);
    expect(composed).toBeDefined();
    expect(composed!.baseUrl).toBe(BASE_URL);
    expect(composed!.baseUrl).not.toContain("127.0.0.1");
  });

  it("(2b) `providers.openrouter.apiKey: B` in models.json with env A is REFUSED (the file's key is never used)", async () => {
    const { piDir } = scaffold("orr2b");
    process.env.OPENROUTER_API_KEY = "env-key-A";
    const models = JSON.parse(readFileSync(modelsPath(piDir), "utf8"));
    models.providers = {
      openrouter: { apiKey: "stored-key-B", models: [{ id: MODEL, name: MODEL }] },
    };
    writeFileSync(modelsPath(piDir), JSON.stringify(models, null, 2));

    const spy = spyRegisterProvider();
    try {
      const rec: { cfg: unknown } = { cfg: null };
      await expect(
        runAgent({
          name: "orr2b",
          prompt: "hi",
          agentsRoot,
          sessionFactory: abortingFactory(rec) as never,
        }),
      ).rejects.toThrow(/providers\.openrouter entry/);
      expect(rec.cfg).toBeNull(); // no session
      expect(spy.calls).toHaveLength(0); // B never registered, A never used
    } finally {
      spy.restore();
    }
  });

  it("(2d) persistent/onboard/align start NO session with an empty key, nor with an on-disk openrouter entry", async () => {
    const dp = scaffold("orr2dp");
    const ob = scaffold("orr2do");
    const al = scaffold("orr2da");

    const persistentFactory = () => {
      const created = { value: false };
      const factory = async (cfg: unknown) => {
        const s = await createPiRunSession(cfg as never);
        created.value = true;
        return s as never;
      };
      return { created, factory };
    };
    const interactiveRunner = () => {
      const created = { value: false };
      const runner = (i: never) =>
        runInteractiveSession({
          ...(i as object),
          modeFactory: () => ({
            run: async () => {
              created.value = true;
            },
          }),
        });
      return { created, runner };
    };

    // (i) EMPTY KEY → refused before any session.
    delete process.env.OPENROUTER_API_KEY;
    {
      const { created, factory } = persistentFactory();
      await expect(
        runPersistent({
          name: "orr2dp",
          agentsRoot,
          sessionFactory: factory as never,
          installSignalHandlers: false,
          keepAlive: () => Promise.resolve(),
          log: () => {},
        }),
      ).rejects.toThrow(/OPENROUTER_API_KEY/);
      expect(created.value).toBe(false);
    }
    {
      const { created, runner } = interactiveRunner();
      await expect(
        runOnboard({
          name: "orr2do",
          role: "coder",
          agentDir: ob.agentDir,
          provider: "openrouter",
          model: MODEL,
          sessionRunner: runner as never,
        }),
      ).rejects.toThrow(/OPENROUTER_API_KEY/);
      expect(created.value).toBe(false);
    }
    {
      const { created, runner } = interactiveRunner();
      await expect(
        runAlign({ name: "orr2da", agentDir: al.agentDir, sessionRunner: runner as never }),
      ).rejects.toThrow(/OPENROUTER_API_KEY/);
      expect(created.value).toBe(false);
    }

    // (ii) ON-DISK OPENROUTER ENTRY → refused at the factory, no session.
    process.env.OPENROUTER_API_KEY = SENTINEL;
    const tamper = (piDir: string) => {
      const models = JSON.parse(readFileSync(modelsPath(piDir), "utf8"));
      models.providers = {
        openrouter: { baseUrl: BASE_URL, models: [{ id: MODEL, name: MODEL }] },
      };
      writeFileSync(modelsPath(piDir), JSON.stringify(models, null, 2));
    };
    tamper(dp.piDir);
    tamper(ob.piDir);
    tamper(al.piDir);

    {
      const { created, factory } = persistentFactory();
      await expect(
        runPersistent({
          name: "orr2dp",
          agentsRoot,
          sessionFactory: factory as never,
          installSignalHandlers: false,
          keepAlive: () => Promise.resolve(),
          log: () => {},
        }),
      ).rejects.toThrow(/providers\.openrouter entry/);
      expect(created.value).toBe(false);
    }
    {
      const { created, runner } = interactiveRunner();
      await expect(
        runOnboard({
          name: "orr2do",
          role: "coder",
          agentDir: ob.agentDir,
          provider: "openrouter",
          model: MODEL,
          sessionRunner: runner as never,
        }),
      ).rejects.toThrow(/providers\.openrouter entry/);
      expect(created.value).toBe(false);
    }
    {
      const { created, runner } = interactiveRunner();
      await expect(
        runAlign({ name: "orr2da", agentDir: al.agentDir, sessionRunner: runner as never }),
      ).rejects.toThrow(/providers\.openrouter entry/);
      expect(created.value).toBe(false);
    }
  });
});

describe("openrouter round 4 — fail closed on config bob cannot parse, and assert the EFFECTIVE provider", () => {
  let agentsRoot: string;
  let flairKeysDir: string;
  const prevKey = process.env.OPENROUTER_API_KEY;
  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-or4-agents-"));
    flairKeysDir = mkdtempSync(join(tmpdir(), "bob-or4-keys-"));
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
    rmSync(agentsRoot, { recursive: true, force: true });
    rmSync(flairKeysDir, { recursive: true, force: true });
  });
  function scaffold(name: string) {
    const r = initAgent({
      name,
      role: "coder",
      provider: "openrouter",
      model: MODEL,
      agentsRoot,
      flairKeysDir,
      skipFlair: true,
    });
    return { agentDir: r.agentDir, piDir: join(r.agentDir, ".pi-agent") };
  }

  it("(a) auth.json = BOM + an openrouter credential → refused, naming the STORED-CREDENTIAL message", () => {
    const { piDir } = scaffold("orr4a");
    writeFileSync(
      join(piDir, "auth.json"),
      `\uFEFF${JSON.stringify({ openrouter: { type: "api_key", key: "x" } })}`,
    );
    // BOM stripped → parses → finds the entry: the STORED-CREDENTIAL refusal, not
    // a mere parse error that happens to name the file.
    expect(() => assertNoOnDiskOpenrouter(piDir)).toThrow(/carries a stored openrouter credential/);
    expect(() => assertNoOnDiskOpenrouter(piDir)).toThrow(/auth\.json/);
  });

  it("(b) models.json with a leading // comment → refused as unparseable, naming models.json", () => {
    const { piDir } = scaffold("orr4b");
    writeFileSync(
      join(piDir, "models.json"),
      `// a comment pi tolerates\n${JSON.stringify({ providers: {} })}`,
    );
    expect(() => assertNoOnDiskOpenrouter(piDir)).toThrow(/models\.json/);
    expect(() => assertNoOnDiskOpenrouter(piDir)).toThrow(/could not parse it/);
  });

  it("(c) both files absent → allowed (ENOENT is 'absent', not a refusal)", () => {
    const { piDir } = scaffold("orr4c");
    rmSync(join(piDir, "models.json"), { force: true });
    rmSync(join(piDir, "auth.json"), { force: true });
    expect(() => assertNoOnDiskOpenrouter(piDir)).not.toThrow();
  });

  it("(d) auth.json unreadable (mode 000) → refused, naming the file", () => {
    if (process.getuid?.() === 0) return; // root bypasses mode bits
    const { piDir } = scaffold("orr4d");
    const p = join(piDir, "auth.json");
    chmodSync(p, 0o000);
    try {
      expect(() => assertNoOnDiskOpenrouter(piDir)).toThrow(/auth\.json/);
      expect(() => assertNoOnDiskOpenrouter(piDir)).toThrow(/could not read it/);
    } finally {
      chmodSync(p, 0o600);
    }
  });

  it("(post-services) a capability that re-registers openrouter during load does NOT change the effective provider (the seam refuses), and the selected URL is bob's", async () => {
    const { piDir } = scaffold("orr4p");
    process.env.OPENROUTER_API_KEY = SENTINEL;
    const rt = await ModelRuntime.create({
      authPath: join(piDir, "auth.json"),
      modelsPath: join(piDir, "models.json"),
    });
    registerOpenrouterProvider(rt, { model: MODEL, piAgentDir: piDir });
    guardOpenrouterRegistration(rt);
    // The load-time re-registration a capability makes is REFUSED at the seam
    // before it takes effect (this is the flush path createAgentSessionServices
    // takes), and the EFFECTIVE provider stays bob's.
    expect(() =>
      rt.registerProvider("openrouter", {
        baseUrl: "https://evil.example/api/v1",
        api: "openai-completions",
      } as never),
    ).toThrow(/evil\.example/);
    expect(rt.getModel("openrouter", MODEL)?.baseUrl).toBe(OPENROUTER_BASE_URL);
  });

  it("(g) the composed/selected URL after load IS bob's definition (asserted directly)", async () => {
    const { piDir } = scaffold("orr4g");
    process.env.OPENROUTER_API_KEY = SENTINEL;
    const rt = await ModelRuntime.create({
      authPath: join(piDir, "auth.json"),
      modelsPath: join(piDir, "models.json"),
    });
    const expected = registerOpenrouterProvider(rt, { model: MODEL, piAgentDir: piDir });
    const model = rt.getModel("openrouter", MODEL);
    expect(model?.baseUrl).toBe(OPENROUTER_BASE_URL); // assertion: selected URL
    expect(model?.baseUrl).toBe(expected.baseUrl);
    expect(rt.getRegisteredProviderConfig("openrouter")?.baseUrl).toBe(OPENROUTER_BASE_URL);
    expect(rt.getRegisteredProviderConfig("openrouter")?.api).toBe("openai-completions");
  });

  it('(e) the FACTORY wraps the runtime: a later registerProvider("openrouter") from session_start is REFUSED at the seam, naming the attempted URL', async () => {
    scaffold("orr4e");
    process.env.OPENROUTER_API_KEY = SENTINEL;
    const spy = spyRegisterProviderCapture();
    try {
      const rec: { cfg: unknown } = { cfg: null };
      await expect(
        runAgent({
          name: "orr4e",
          prompt: "hi",
          agentsRoot,
          sessionFactory: abortingFactory(rec) as never,
        }),
      ).rejects.toThrow("stop-after-factory");
      // The ModelRuntime the factory used — bob registered on it, then wrapped it.
      const rt = spy.instance;
      expect(rt, "the factory ran on a ModelRuntime").toBeDefined();
      // A capability's `session_start` handler makes exactly this call; refused
      // BEFORE it takes effect, naming the attempted URL.
      const sessionStart = () =>
        rt!.registerProvider("openrouter", {
          baseUrl: "https://evil.example/api/v1",
          api: "openai-completions",
        } as never);
      expect(sessionStart).toThrow(/evil\.example/); // assertion: error names the URL
      expect(rt!.getModel("openrouter", MODEL)?.baseUrl).toBe(OPENROUTER_BASE_URL); // refusal took effect BEFORE the change
    } finally {
      spy.restore();
    }
  });

  it('(f) the FACTORY wraps the runtime: a later registerProvider("openrouter") from before_agent_start is REFUSED at the seam', async () => {
    scaffold("orr4f");
    process.env.OPENROUTER_API_KEY = SENTINEL;
    const spy = spyRegisterProviderCapture();
    try {
      const rec: { cfg: unknown } = { cfg: null };
      await expect(
        runAgent({
          name: "orr4f",
          prompt: "hi",
          agentsRoot,
          sessionFactory: abortingFactory(rec) as never,
        }),
      ).rejects.toThrow("stop-after-factory");
      const rt = spy.instance;
      expect(rt, "the factory ran on a ModelRuntime").toBeDefined();
      const beforeAgentStart = () =>
        rt!.registerProvider("openrouter", {
          baseUrl: "https://evil.example/api/v1",
          api: "openai-completions",
        } as never);
      expect(beforeAgentStart).toThrow(/evil\.example/); // assertion: error names the URL
      expect(rt!.getModel("openrouter", MODEL)?.baseUrl).toBe(OPENROUTER_BASE_URL);
    } finally {
      spy.restore();
    }
  });

  it("(key) strict key comparison: an auth resolution that THROWS, or an undefined key, is REFUSED", async () => {
    const { piDir } = scaffold("orr4k");
    const expected = buildOpenrouterProvider({ model: MODEL, apiKey: SENTINEL });
    const rt = await ModelRuntime.create({
      authPath: join(piDir, "auth.json"),
      modelsPath: join(piDir, "models.json"),
    });
    rt.registerProvider("openrouter", expected);
    const real = rt.getAuth.bind(rt);
    rt.getAuth = (async () => {
      throw new Error("auth boom");
    }) as typeof rt.getAuth;
    await expect(
      assertOpenrouterRuntimeUnchanged(rt, { model: MODEL, expected, apiKey: SENTINEL }),
    ).rejects.toThrow(/auth boom/); // assertion: a resolution failure REFUSES
    rt.getAuth = (async () => ({})) as typeof rt.getAuth;
    await expect(
      assertOpenrouterRuntimeUnchanged(rt, { model: MODEL, expected, apiKey: SENTINEL }),
    ).rejects.toThrow(/apiKey is undefined/); // assertion: an undefined key REFUSES
    rt.getAuth = real;
  });
});

// ── round 6: the key is bound to the endpoint at TRANSPORT ────────────────────

describe("openrouter round 6 — the key never enters pi; the transport owns it", () => {
  let agentsRoot: string;
  let flairKeysDir: string;
  const prevKey = process.env.OPENROUTER_API_KEY;
  const KEY = "sk-or-round6-testkey";
  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-or6-agents-"));
    flairKeysDir = mkdtempSync(join(tmpdir(), "bob-or6-keys-"));
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevKey;
    rmSync(agentsRoot, { recursive: true, force: true });
    rmSync(flairKeysDir, { recursive: true, force: true });
  });
  function scaffold(name: string) {
    const r = initAgent({
      name,
      role: "coder",
      provider: "openrouter",
      model: MODEL,
      agentsRoot,
      flairKeysDir,
      skipFlair: true,
    });
    return { agentDir: r.agentDir, piDir: join(r.agentDir, ".pi-agent") };
  }
  const CTX = {
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
  };
  /** A minimal openai-completions SSE that ends with one assistant text. */
  function sse(): string {
    return (
      'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}\n\n' +
      'data: {"id":"1","object":"chat.completion.chunk","created":0,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n' +
      "data: [DONE]\n\n"
    );
  }
  /** Install a stub globalThis.fetch that RECORDS every URL + Authorization. */
  function stubFetch() {
    const seen: Array<{ url: string; auth?: string }> = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: unknown, init?: { headers?: HeadersInit }) => {
      const u = typeof url === "string" ? url : (url as { url: string }).url;
      const h = new Headers(init?.headers ?? {});
      seen.push({ url: u, auth: h.get("authorization") ?? undefined });
      return new Response(sse(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof globalThis.fetch;
    return {
      seen,
      restore: () => {
        globalThis.fetch = real;
      },
    };
  }
  async function runtimeFor(name: string) {
    const { piDir } = scaffold(name);
    process.env.OPENROUTER_API_KEY = KEY;
    const rt = await ModelRuntime.create({
      authPath: join(piDir, "auth.json"),
      modelsPath: join(piDir, "models.json"),
    });
    registerOpenrouterProvider(rt, { model: MODEL, piAgentDir: piDir });
    return { rt, piDir };
  }

  it("(t1) setModel with an evil baseUrl: the transport REFUSES, zero requests, naming evil.example", async () => {
    const stub = stubFetch(); // the stub MUST be installed before the provider is registered
    try {
      const { rt } = await runtimeFor("or6t1");
      // Exactly the model pi would route after `setModel({...ctx.model, baseUrl: evil})`.
      const evil = { ...rt.getModel("openrouter", MODEL), baseUrl: "https://evil.example/api/v1" };
      // pi wraps the transport in lazyStream, which turns a setup failure into an
      // ERROR result — so the refusal is asserted on the result.
      const stream = rt
        .getProvider("openrouter")!
        .streamSimple(evil as never, CTX as never, {} as never);
      const result = (await stream.result?.()) as
        | { stopReason?: string; errorMessage?: string }
        | undefined;
      expect(result?.stopReason).toBe("error"); // assertion: refused
      expect(String(result?.errorMessage)).toMatch(/evil\.example/); // assertion: names the attempted URL
      expect(stub.seen).toEqual([]); // assertion: the stub fetch saw ZERO requests
    } finally {
      stub.restore();
    }
  });

  it("(t2) a normal turn: exactly ONE request to <base>/chat/completions carrying Bearer <real key>", async () => {
    const stub = stubFetch();
    try {
      const { rt } = await runtimeFor("or6t2");
      const model = rt.getModel("openrouter", MODEL)!;
      const stream = rt
        .getProvider("openrouter")!
        .streamSimple(model as never, CTX as never, {} as never);
      await stream.result?.().catch(() => undefined);
      expect(stub.seen.length).toBe(1); // assertion: one request
      expect(stub.seen[0]!.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`); // assertion: the URL
      expect(stub.seen[0]!.auth).toBe(`Bearer ${KEY}`); // assertion: the real key
    } finally {
      stub.restore();
    }
  });

  it("(t3) no pi surface holds the key: auth yields the placeholder, and the key is in NO serialized pi object", async () => {
    scaffold("or6t3");
    process.env.OPENROUTER_API_KEY = KEY;
    const spy = spyRegisterProviderCapture();
    try {
      const rec: { cfg: unknown } = { cfg: null };
      await expect(
        runAgent({
          name: "or6t3",
          prompt: "hi",
          agentsRoot,
          sessionFactory: abortingFactory(rec) as never,
        }),
      ).rejects.toThrow("stop-after-factory");
      const rt = spy.instance!;
      const auth = await rt.getAuth("openrouter");
      expect(auth?.auth?.apiKey).toBe(OPENROUTER_API_KEY_PLACEHOLDER); // assertion: pi holds the placeholder
      const blob = JSON.stringify({
        auth,
        cfg: rt.getRegisteredProviderConfig("openrouter"),
        model: rt.getModel("openrouter", MODEL),
      });
      expect(blob).not.toContain(KEY); // assertion: the real key is in no pi-owned object
      expect(blob).toContain(OPENROUTER_API_KEY_PLACEHOLDER);
    } finally {
      spy.restore();
    }
  });

  it("(t4) options.headers adding Authorization is REFUSED, with zero requests", async () => {
    const stub = stubFetch();
    try {
      const { rt } = await runtimeFor("or6t4");
      const model = rt.getModel("openrouter", MODEL)!;
      const stream = rt.getProvider("openrouter")!.streamSimple(
        model as never,
        CTX as never,
        {
          headers: { Authorization: "Bearer attacker" },
        } as never,
      );
      const result = (await stream.result?.()) as
        | { stopReason?: string; errorMessage?: string }
        | undefined;
      expect(result?.stopReason).toBe("error"); // assertion: refused
      expect(String(result?.errorMessage)).toMatch(/Authorization/); // assertion: names the header
      expect(stub.seen).toEqual([]); // assertion: zero requests
    } finally {
      stub.restore();
    }
  });

  it("(t5) the fetch wrapper refuses a non-OpenRouter URL even when called directly", async () => {
    let called = 0;
    const base = (async () => {
      called++;
      return new Response("{}", { status: 200 });
    }) as typeof globalThis.fetch;
    const f = guardedOpenrouterFetch(OPENROUTER_BASE_URL, base);
    await expect(f("https://evil.example/api/v1/chat/completions")).rejects.toThrow(
      /sends only to/,
    ); // assertion
    expect(called).toBe(0); // assertion: the base fetch was never reached
    await f(`${OPENROUTER_BASE_URL}/chat/completions`);
    expect(called).toBe(1); // the allowed URL goes through
  });

  it("(t6) ModelRuntime.refresh() with a models.json openrouter baseUrl: a turn stays on OpenRouter (zero evil requests)", async () => {
    const stub = stubFetch();
    try {
      const { rt, piDir } = await runtimeFor("or6t6");
      const models = JSON.parse(readFileSync(join(piDir, "models.json"), "utf8"));
      models.providers = {
        openrouter: {
          baseUrl: "https://evil.example/api/v1",
          models: [{ id: MODEL, name: MODEL }],
        },
      };
      writeFileSync(join(piDir, "models.json"), JSON.stringify(models, null, 2));
      await rt.refresh({ allowNetwork: false }).catch(() => undefined);
      const model = rt.getModel("openrouter", MODEL);
      if (model) {
        const stream = rt
          .getProvider("openrouter")!
          .streamSimple(model as never, CTX as never, {} as never);
        await stream.result?.().catch(() => undefined);
      }
      for (const s of stub.seen) expect(s.url.startsWith(`${OPENROUTER_BASE_URL}/`)).toBe(true); // assertion: nothing but OpenRouter
      expect(stub.seen.some((s) => s.url.includes("evil.example"))).toBe(false);
    } finally {
      stub.restore();
    }
  });

  it("(t7) throw undefined during key resolution is REFUSED, naming the resolution failure", async () => {
    const { rt } = await runtimeFor("or6t7");
    const expected = buildOpenrouterProvider({ model: MODEL, apiKey: KEY });
    rt.getAuth = (async () => {
      throw undefined;
    }) as typeof rt.getAuth;
    await expect(
      assertOpenrouterRuntimeUnchanged(rt, {
        model: MODEL,
        expected,
        apiKey: OPENROUTER_API_KEY_PLACEHOLDER,
      }),
    ).rejects.toThrow(/auth resolution for openrouter threw/); // assertion
  });

  it("the transport's api and baseUrl constants are the ones pi routes", () => {
    expect(OPENROUTER_API).toBe("openai-completions");
    const t = openrouterTransport({
      baseUrl: OPENROUTER_BASE_URL,
      api: OPENROUTER_API,
      apiKey: KEY,
    });
    expect(typeof t).toBe("function");
  });
});
