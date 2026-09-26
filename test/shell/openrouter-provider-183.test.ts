// bob#183 — the openrouter provider. Round 3: bob CONSTRUCTS the provider in
// memory inside the ONE session factory (fixed endpoint, env key passed in
// memory, openai-completions, no per-model baseUrl) and REFUSES any on-disk
// openrouter entry in models.json/auth.json. Every entry path goes through the
// factory, so every entry path gets it. No network.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  buildOpenrouterProvider,
  OPENROUTER_BASE_URL,
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
  expect(cfg.apiKey).toBe(process.env.OPENROUTER_API_KEY);
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

  it("(a2) the constructed provider: constant baseUrl, env key, openai-completions, no per-model baseUrl", () => {
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

  it("(c) the rendered files AND the run log never contain the env value (sentinel); every inspected file MUST exist", async () => {
    const { agentDir, piDir } = scaffold("orrc");
    process.env.OPENROUTER_API_KEY = SENTINEL;
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

  it("(2a-listener) a file endpoint is REFUSED before any session, and a local listener is never hit", async () => {
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
