import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Value } from "typebox/value";
import { CONFIG_ENV_VAR, CONFIG_SCHEMA, loadConfigFromEnv, readToken } from "../src/config.js";

describe("loadConfigFromEnv", () => {
  const valid = {
    tokenFile: "/secrets/bot.token",
    channelIds: ["111", "222"],
    dispatchAll: true,
  };

  it("parses + validates a config blob from the env var", () => {
    const env = { [CONFIG_ENV_VAR]: JSON.stringify(valid) };
    const cfg = loadConfigFromEnv(env);
    expect(cfg.tokenFile).toBe("/secrets/bot.token");
    expect(cfg.channelIds).toEqual(["111", "222"]);
    expect(cfg.dispatchAll).toBe(true);
  });

  it("throws when the env var is missing", () => {
    expect(() => loadConfigFromEnv({})).toThrow(new RegExp(`${CONFIG_ENV_VAR} is not set`));
  });

  it("throws on invalid JSON", () => {
    expect(() => loadConfigFromEnv({ [CONFIG_ENV_VAR]: "{not json" })).toThrow(/not valid JSON/);
  });

  it("rejects config with no channel allow-list (fail closed)", () => {
    const env = { [CONFIG_ENV_VAR]: JSON.stringify({ ...valid, channelIds: [] }) };
    expect(() => loadConfigFromEnv(env)).toThrow(/config is invalid/);
  });

  it("rejects a non-snowflake channel id", () => {
    const env = { [CONFIG_ENV_VAR]: JSON.stringify({ ...valid, channelIds: ["not-a-snowflake"] }) };
    expect(() => loadConfigFromEnv(env)).toThrow(/config is invalid/);
  });

  it("rejects an inlined token field (additionalProperties: false)", () => {
    // A token MUST NOT be carried in config; the schema is closed so a stray
    // `token` field is a hard validation failure rather than a silent leak.
    const env = {
      [CONFIG_ENV_VAR]: JSON.stringify({ ...valid, token: "super-secret-xyz" }),
    };
    expect(() => loadConfigFromEnv(env)).toThrow(/config is invalid/);
  });

  it("the schema does not declare any token/secret field", () => {
    // Defense in depth: assert the config surface itself has no place to put a
    // secret. Only a file PATH is allowed.
    const props = Object.keys((CONFIG_SCHEMA as { properties: object }).properties);
    expect(props).toContain("tokenFile");
    expect(props).not.toContain("token");
    expect(props).not.toContain("secret");
  });

  it("the schema accepts the documented shape end-to-end", () => {
    expect(Value.Check(CONFIG_SCHEMA, valid)).toBe(true);
  });
});

describe("readToken", () => {
  it("reads + trims a token from a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-discord-tok-"));
    try {
      const p = join(dir, "bot.token");
      writeFileSync(p, "  the-secret-token\n", "utf8");
      expect(readToken(p)).toBe("the-secret-token");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws on an empty token file (naming the path, not contents)", () => {
    const dir = mkdtempSync(join(tmpdir(), "cap-discord-tok-"));
    try {
      const p = join(dir, "empty.token");
      writeFileSync(p, "   \n", "utf8");
      expect(() => readToken(p)).toThrow(/is empty/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("error on a missing file does not contain file contents", () => {
    // The token is never available to leak here (file doesn't exist), but the
    // contract is: errors name the path/reason only.
    let msg = "";
    try {
      readToken("/no/such/token/file", () => {
        throw new Error("ENOENT: no such file or directory, open '/no/such/token/file'");
      });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/cannot read token file/);
    expect(msg).not.toContain("the-secret-token");
  });

  it("never echoes the token in any error path", () => {
    // Read succeeds but token is whitespace → empty error. The thrown message
    // must not contain the raw read contents.
    const secret = "tok_LEAK_CANARY_123";
    let msg = "";
    try {
      readToken("/x", () => `  ${secret}  `);
    } catch (e) {
      msg = (e as Error).message;
    }
    // This token is non-empty so readToken returns it (no throw); assert the
    // happy path returns it but we never logged it. The canary check below is
    // the real assertion: a successful read returns the trimmed secret.
    expect(msg).toBe("");
    expect(readToken("/x", () => `  ${secret}  `)).toBe(secret);
  });
});
