// bob#183 — the openrouter provider. Round 2: the EFFECTIVE endpoint is pinned and
// the env var is the SOLE credential, enforced on the real run paths (runAgent +
// both runLaunch shapes), before any session or HTTP request. No network.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAgent } from "../../src/shell/init.js";
import { runAgent, runLaunch } from "../../src/shell/run.js";

const MODEL = "deepseek/deepseek-v4.1-flash";
const BASE_URL = "https://openrouter.ai/api/v1";
const SENTINEL = "sk-or-v1-THIS-IS-A-SENTINEL-KEY-DO-NOT-WRITE";

/** A session-factory spy: records calls and returns a minimal RunSession. */
function spyFactory() {
  const calls: Array<{ provider: string; model: string }> = [];
  const factory = async (cfg: { provider: string; model: string }) => {
    calls.push({ provider: cfg.provider, model: cfg.model });
    return {
      subscribe: () => () => {},
      prompt: async () => {},
      dispose: () => {},
    } as never;
  };
  return { factory, calls };
}

describe("openrouter provider (bob#183)", () => {
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

  it("(a) init renders bob.yaml + the pi config with the OpenRouter base URL and the DECLARED model", () => {
    const { agentDir, piDir } = scaffold("orra");
    const yaml = readFileSync(join(agentDir, "bob.yaml"), "utf8");
    expect(yaml).toContain("name: openrouter");
    expect(yaml).toContain(MODEL);
    const models = JSON.parse(readFileSync(modelsPath(piDir), "utf8"));
    expect(models.providers.openrouter.baseUrl).toBe(BASE_URL);
    expect(models.providers.openrouter.models).toEqual([{ id: MODEL, name: MODEL }]);
  });

  it("(b1) runAgent refuses BEFORE any session when OPENROUTER_API_KEY is unset", async () => {
    scaffold("orrb1");
    delete process.env.OPENROUTER_API_KEY;
    const { factory, calls } = spyFactory();
    await expect(
      runAgent({ name: "orrb1", prompt: "hi", agentsRoot, sessionFactory: factory }),
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(calls.length).toBe(0); // no session created
  });

  it("(b2) runLaunch (prompted) refuses BEFORE any session when the key is unset", async () => {
    scaffold("orrb2");
    delete process.env.OPENROUTER_API_KEY;
    const { factory, calls } = spyFactory();
    await expect(
      runLaunch({ name: "orrb2", prompt: "hi", agentsRoot, sessionFactory: factory }),
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(calls.length).toBe(0);
  });

  it("(b3) runLaunch (interactive) refuses BEFORE the interactive session when the key is unset", async () => {
    scaffold("orrb3");
    delete process.env.OPENROUTER_API_KEY;
    let interactiveCalled = false;
    await expect(
      runLaunch({
        name: "orrb3",
        agentsRoot,
        interactive: (() => {
          interactiveCalled = true;
          return 0;
        }) as never,
      }),
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(interactiveCalled).toBe(false);
  });

  it("(c) the rendered files AND the run log never contain the env value (sentinel)", async () => {
    const { agentDir, piDir } = scaffold("orrc");
    process.env.OPENROUTER_API_KEY = SENTINEL;
    // A spied run: the run log is written even with a fake session.
    const { factory } = spyFactory();
    await runAgent({ name: "orrc", prompt: "hi", agentsRoot, sessionFactory: factory });

    const targets = [
      join(agentDir, "bob.yaml"),
      join(agentDir, "bin", "orrc"),
      modelsPath(piDir),
      join(piDir, "auth.json"),
    ];
    const runsDir = join(agentDir, "runs");
    if (existsSync(runsDir)) {
      for (const f of readdirSync(runsDir).filter((n) => n.endsWith(".jsonl")))
        targets.push(join(runsDir, f));
    }
    for (const p of targets) {
      if (!existsSync(p)) continue;
      expect(readFileSync(p, "utf8"), `${p} must not contain the key`).not.toContain(SENTINEL);
    }
    // Prove the launcher + run log were actually inspected (a check that cannot fire is not a check).
    expect(existsSync(join(agentDir, "bin", "orrc"))).toBe(true);
    expect(existsSync(runsDir)).toBe(true);
  });

  it("item 1: an edited models.json endpoint is refused BEFORE any HTTP request", async () => {
    const { piDir } = scaffold("orr1");
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
    models.providers.openrouter.baseUrl = `http://127.0.0.1:${port}/v1`; // attacker URL
    writeFileSync(modelsPath(piDir), JSON.stringify(models, null, 2));

    const { factory, calls } = spyFactory();
    await expect(
      runAgent({ name: "orr1", prompt: "hi", agentsRoot, sessionFactory: factory }),
    ).rejects.toThrow(/resolves the endpoint to/);
    expect(calls.length).toBe(0); // no session
    await new Promise((r) => setTimeout(r, 50));
    expect(hits).toBe(0); // no request ever
  });

  it("item 2: a stored openrouter credential is refused; the env var is the sole credential", async () => {
    const { piDir } = scaffold("orr2");
    process.env.OPENROUTER_API_KEY = SENTINEL; // env key A
    writeFileSync(
      join(piDir, "auth.json"),
      JSON.stringify({ openrouter: { type: "api_key", key: "stored-key-B" } }, null, 2),
    );
    const { factory, calls } = spyFactory();
    await expect(
      runAgent({ name: "orr2", prompt: "hi", agentsRoot, sessionFactory: factory }),
    ).rejects.toThrow(/stored credential for openrouter/);
    expect(calls.length).toBe(0); // never uses B (or anything)
  });
});
