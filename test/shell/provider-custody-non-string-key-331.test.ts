// bob#331 — a stored credential whose `key` is not a string references nothing.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { initAgent } from "../../src/shell/init.js";
import {
  piConfigValueEnvVarNames,
  piCredentialEnvNames,
} from "../../src/shell/provider-custody.js";
import { resolveRunConfig } from "../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../src/shell/session.js";

const PROVIDER = "ollama-cloud";
const MODEL = "kimi-k2.6";

// The non-string JSON values a malformed stored `key` can carry: a number, null,
// an object and an array are each results `JSON.parse` can produce for a `key`.
const NON_STRING_KEYS: readonly (readonly [string, unknown])[] = [
  ["a number", 5],
  ["null", null],
  ["an object", { name: "value" }],
  ["an array", ["value"]],
];

/** The rejection of `promise`, or `undefined` when it resolves. */
async function failure(promise: Promise<unknown>): Promise<Error | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

describe("bob#331 — a non-string stored key references nothing", () => {
  it("returns no names and does not throw for a number, null, an object and an array", () => {
    for (const [label, key] of NON_STRING_KEYS) {
      let names: readonly string[] = ["not-replaced"];
      expect(() => {
        names = piConfigValueEnvVarNames(key);
      }).not.toThrow();
      expect({ label, names: [...names] }).toEqual({ label, names: [] });
    }
  });
});

describe("bob#331 — a non-string stored key through the real session factory", () => {
  let tmpRoot: string;
  let keysRoot: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), "bob-331-"));
    keysRoot = mkdtempSync(join(tmpdir(), "bob-331-keys-"));
    for (const name of piCredentialEnvNames()) saved.set(name, process.env[name]);
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

  for (const [label, key] of NON_STRING_KEYS) {
    it(`constructs a session for a stored key that is ${label}`, async () => {
      const name = "credfix";
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
      const authPath = join(agentDir, ".pi-agent", "auth.json");
      writeFileSync(authPath, JSON.stringify({ [PROVIDER]: { type: "api_key", key } }));

      const { config, policy } = resolveRunConfig({ name, agentsRoot: tmpRoot });
      const factory = createBobRuntimeFactory({ config, policy });
      const result = await factory({ sessionManager: SessionManager.inMemory(config.cwd) });
      try {
        const runtime = result.services.modelRuntime as unknown as ModelRuntime;
        const bobError = await failure(runtime.getAuth(PROVIDER));
        const piRuntime = await ModelRuntime.create({
          authPath,
          modelsPath: join(agentDir, ".pi-agent", "models.json"),
        });
        const piError = await failure(piRuntime.getAuth(PROVIDER));
        // Construction succeeded; the malformed key fails with pi's own error,
        // where pi's own credential resolution fails.
        expect({ name: bobError?.name, message: bobError?.message }).toEqual({
          name: "ModelsError",
          message: piError?.message,
        });
      } finally {
        (result.session as unknown as { dispose(): void }).dispose();
      }
    });
  }
});
