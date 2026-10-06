// bob#323 — real provider variable names with disposable fixture values.
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

describe("bob#323 — stored credential references during the scrub", () => {
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

  async function checkCredential(
    env: Record<string, string> | undefined,
    expectedKey: string,
    expectedAmbient: string | undefined,
    otherCredential?: { type: "api_key"; key: string },
  ) {
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
      JSON.stringify({
        [PROVIDER]: { type: "api_key", key: `$${REFERENCED}`, env },
        ...(otherCredential ? { groq: otherCredential } : {}),
      }),
    );
    process.env[REFERENCED] = DISPOSABLE;
    process.env[UNRELATED] = DISPOSABLE;

    const { config, policy } = resolveRunConfig({ name, agentsRoot: tmpRoot });
    const factory = createBobRuntimeFactory({ config, policy });
    const result = await factory({ sessionManager: SessionManager.inMemory(config.cwd) });
    try {
      const runtime = result.services.modelRuntime as unknown as ModelRuntime;
      const auth = await runtime.getAuth(PROVIDER);
      expect(auth?.auth.apiKey).toBe(expectedKey);
      expect(process.env[REFERENCED]).toBe(expectedAmbient);
      expect(process.env[UNRELATED]).toBeUndefined();
    } finally {
      (result.session as unknown as { dispose(): void }).dispose();
    }
  }

  it("resolves the stored override and removes the referenced ambient variable", async () => {
    const override = "disposable-stored-override";
    await checkCredential({ [REFERENCED]: override }, override, undefined);
  });

  it("keeps and resolves the ambient variable when credential.env is absent", async () => {
    await checkCredential(undefined, DISPOSABLE, DISPOSABLE);
  });

  it("keeps and resolves the ambient variable when the named override is absent", async () => {
    await checkCredential({}, DISPOSABLE, DISPOSABLE);
  });

  it("keeps and resolves the ambient variable when the named override is empty", async () => {
    await checkCredential({ [REFERENCED]: "" }, DISPOSABLE, DISPOSABLE);
  });

  it("uses a whitespace override and removes the referenced ambient variable", async () => {
    await checkCredential({ [REFERENCED]: " " }, " ", undefined);
  });

  it("removes the variable referenced only by another provider's stored credential", async () => {
    await checkCredential(undefined, DISPOSABLE, DISPOSABLE, {
      type: "api_key",
      key: `$${UNRELATED}`,
    });
  });
});
