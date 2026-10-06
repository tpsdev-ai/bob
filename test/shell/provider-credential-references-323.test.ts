// bob#323 — the session factory's environment scrub keeps the environment
// variables the SELECTED provider's stored credential references.
//
// A pi-managed row (pi/disk) stores its credential in the agent's auth.json,
// and `key` may be a reference such as "$NAME". pi resolves that reference when
// the session's runtime reads the credential, which is AFTER the scrub, so the
// scrub must not remove NAME. The fixture uses neutral names and disposable
// values only: no real key is ever written.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { initAgent } from "../../src/shell/init.js";
import { piCredentialEnvNames } from "../../src/shell/provider-custody.js";
import { resolveRunConfig } from "../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../src/shell/session.js";

// A code-owned pi/disk row: pi reads this provider's credential from auth.json.
const PROVIDER = "ollama-cloud";
const MODEL = "kimi-k2.6";
// Both names are in pi's credential table, so the scrub WOULD delete them.
const REFERENCED = "DEEPSEEK_API_KEY";
const UNRELATED = "GROQ_API_KEY";
const DISPOSABLE = "disposable-not-a-real-key";

describe("bob#323 — the scrub keeps a stored credential's environment references", () => {
  let tmpRoot: string;
  let keysRoot: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "bob-323-"));
    keysRoot = mkdtempSync(join(tmpdir(), "bob-323-keys-"));
    for (const name of [...piCredentialEnvNames(), REFERENCED, UNRELATED]) {
      saved.set(name, process.env[name]);
    }
  });
  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
    rmSync(tmpRoot, { recursive: true, force: true });
    rmSync(keysRoot, { recursive: true, force: true });
  });

  it("a stored credential that references an env var still resolves; an unrelated credential variable is removed", async () => {
    const name = "credref";
    const { agentDir } = initAgent({
      name,
      role: "coder",
      provider: PROVIDER,
      model: MODEL,
      contextWindow: 200_000,
      agentsRoot: tmpRoot,
      flairKeysDir: keysRoot,
      skipFlair: true,
    });
    writeFileSync(
      join(agentDir, ".pi-agent", "auth.json"),
      JSON.stringify({ [PROVIDER]: { type: "api_key", key: `$${REFERENCED}` } }),
    );
    process.env[REFERENCED] = DISPOSABLE;
    process.env[UNRELATED] = DISPOSABLE;

    const { config, policy } = resolveRunConfig({ name, agentsRoot: tmpRoot });
    const factory = createBobRuntimeFactory({ config, policy });
    const result = await factory({ sessionManager: SessionManager.inMemory(config.cwd) });
    try {
      const runtime = result.services.modelRuntime as unknown as ModelRuntime;
      // The REAL pi resolver reads auth.json and interpolates the reference.
      const auth = await runtime.getAuth(PROVIDER);
      expect(auth?.auth.apiKey).toBe(DISPOSABLE);
      // A pi credential variable the stored credential does not reference is
      // still removed.
      expect(process.env[UNRELATED]).toBeUndefined();
    } finally {
      (result.session as unknown as { dispose(): void }).dispose();
    }
  });
});
