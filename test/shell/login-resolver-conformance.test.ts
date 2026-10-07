import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { subscriptionCredentialCheck } from "../../src/shell/login.js";

type ResolveConfigValue = (config: string, env?: Record<string, string>) => string | undefined;

async function loadPiResolveConfigValue(): Promise<ResolveConfigValue> {
  const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
  const packageDir = dirname(dirname(fileURLToPath(entry)));
  const path = join(packageDir, "dist", "core", "resolve-config-value.js");
  const module = (await import(pathToFileURL(path).href)) as { resolveConfigValue?: unknown };
  if (typeof module.resolveConfigValue !== "function") {
    throw new Error(`pi's resolveConfigValue is not a function at ${path}`);
  }
  return module.resolveConfigValue as ResolveConfigValue;
}

const NAME = "BOB_LOGIN_PARITY_DISPOSABLE";
const UNSET = "BOB_LOGIN_PARITY_UNSET";
const BRACED = `\${${NAME}}`;
const PROVIDER = "openai-codex";

describe("doctor resolution against pi's real resolveConfigValue", () => {
  let dir: string;
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bob-login-parity-"));
    // "1x" is the name a widened name-start rule would read from `$1x`; clear it so
    // the result never depends on the runner's environment.
    for (const name of [NAME, UNSET, "1x"]) {
      saved.set(name, process.env[name]);
      delete process.env[name];
    }
  });

  afterEach(() => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    saved.clear();
    rmSync(dir, { recursive: true, force: true });
  });

  function doctor(key: string, env?: Record<string, string>): "ok" | "fail" {
    writeFileSync(
      join(dir, "auth.json"),
      JSON.stringify({ [PROVIDER]: { type: "api_key", key, env } }),
    );
    return subscriptionCredentialCheck({ name: "parity", provider: PROVIDER, piAgentDir: dir })
      .status;
  }

  it("matches pi's non-empty resolution decisions for the listed templates", async () => {
    const resolve = await loadPiResolveConfigValue();
    process.env[NAME] = "disposable-ambient";
    const rows: readonly (readonly [
      string,
      Record<string, string> | undefined,
      string | undefined,
    ])[] = [
      ["disposable-literal", undefined, "disposable-literal"],
      ["", undefined, ""],
      [`$$${NAME}`, undefined, `$${NAME}`],
      ["$!printf disposable", undefined, "!printf disposable"],
      [`$${NAME}`, undefined, "disposable-ambient"],
      [BRACED, undefined, "disposable-ambient"],
      [`$${NAME}`, { [NAME]: "disposable-stored" }, "disposable-stored"],
      [BRACED, { [NAME]: "disposable-stored" }, "disposable-stored"],
      [`$${NAME}`, { [NAME]: "" }, "disposable-ambient"],
      [BRACED, { [NAME]: "" }, "disposable-ambient"],
      [`$${UNSET}`, undefined, undefined],
      [`\${${UNSET}}`, undefined, undefined],
      [`$${UNSET}`, { [UNSET]: "" }, undefined],
      [`prefix-$${UNSET}-suffix`, undefined, undefined],
      [`$${NAME}-$${UNSET}`, undefined, undefined],
      ["$" + "{BROKEN", undefined, "$" + "{BROKEN"],
      ["$" + "{}", undefined, "$" + "{}"],
      ["$" + "{1NAME}", undefined, "$" + "{1NAME}"],
      ["$1x", undefined, "$1x"],
      ["$-x", undefined, "$-x"],
      ["trailing$", undefined, "trailing$"],
    ];
    for (const [key, env, expected] of rows) {
      const resolved = resolve(key, env);
      expect({ key, resolved }).toEqual({ key, resolved: expected });
      expect({ key, status: doctor(key, env) }).toEqual({
        key,
        status: resolved ? "ok" : "fail",
      });
    }
    delete process.env[NAME];
    for (const key of [`$${NAME}`, BRACED]) {
      expect(resolve(key)).toBeUndefined();
      expect(doctor(key)).toBe("fail");
    }
  });

  it("refuses placeholders and command references that pi resolves", async () => {
    const resolve = await loadPiResolveConfigValue();
    for (const placeholder of ["REPLACE_WITH_YOUR_API_KEY", "exe-gateway-placeholder"]) {
      expect(resolve(placeholder)).toBe(placeholder);
      expect(doctor(placeholder)).toBe("fail");
      process.env[NAME] = placeholder;
      for (const key of [`$${NAME}`, BRACED]) {
        expect(resolve(key)).toBe(placeholder);
        expect(doctor(key)).toBe("fail");
        expect(resolve(key, { [NAME]: placeholder })).toBe(placeholder);
        expect(doctor(key, { [NAME]: placeholder })).toBe("fail");
      }
    }
    const command = "!printf bob-login-disposable";
    expect(resolve(command)).toBe("bob-login-disposable");
    expect(doctor(command)).toBe("fail");
  });

  it("refuses a command without creating its trace file", () => {
    const traceName = "command-executed";
    const tracePath = join(dir, traceName).replaceAll("'", "'\\''");
    expect(doctor(`!printf disposable > '${tracePath}'; printf disposable`)).toBe("fail");
    expect(readdirSync(dir)).not.toContain(traceName);
  });
});
