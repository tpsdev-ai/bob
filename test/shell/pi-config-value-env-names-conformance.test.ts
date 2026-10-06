// Compare the listed cases with pi's private name extractor.
import { describe, expect, it } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { piConfigValueEnvVarNames } from "../../src/shell/provider-custody.js";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

/** The absolute path of pi's private reference-grammar module in the install. */
function piResolveConfigValuePath(): string {
  const entry = import.meta.resolve(PI_PACKAGE);
  const packageDir = dirname(dirname(fileURLToPath(entry)));
  return join(packageDir, "dist", "core", "resolve-config-value.js");
}

/** Load pi's real `getConfigValueEnvVarNames`, or throw naming the path. */
async function loadPiGetConfigValueEnvVarNames(): Promise<(config: string) => string[]> {
  const path = piResolveConfigValuePath();
  let module: { getConfigValueEnvVarNames?: unknown };
  try {
    module = (await import(pathToFileURL(path).href)) as {
      getConfigValueEnvVarNames?: unknown;
    };
  } catch (error) {
    throw new Error(
      `pi's getConfigValueEnvVarNames is missing at ${path}: the conformance test cannot run (${String(error)})`,
    );
  }
  const fn = module.getConfigValueEnvVarNames;
  if (typeof fn !== "function") {
    throw new Error(`pi's getConfigValueEnvVarNames is not a function at ${path}`);
  }
  return fn as (config: string) => string[];
}

// Each row: an input and the names pi's grammar extracts. `undefined` is bob's
// own defensive case — pi's function takes a string — so it is checked against
// the expectation alone. The brace forms are concatenated so the linter's
// template-placeholder rule does not read them as template strings.
const TABLE: readonly (readonly [string | undefined, readonly string[]])[] = [
  ["$NAME", ["NAME"]],
  ["$" + "{NAME}", ["NAME"]],
  ["prefix-$NAME-suffix", ["NAME"]],
  ["$A and $B", ["A", "B"]],
  ["$A-$A", ["A"]],
  ["$$NAME", []],
  ["$!NAME", []],
  ["!command --flag", []],
  ["$" + "{NAME", []],
  ["$" + "{}", []],
  ["$" + "{1NAME}", []],
  ["$1x", []],
  ["$-x", []],
  ["$" + "{1x}", []],
  ["trailing$", []],
  ["", []],
  [undefined, []],
];

describe("piConfigValueEnvVarNames listed cases", () => {
  it("matches pi's real name extractor for the listed cases", async () => {
    const piNames = await loadPiGetConfigValueEnvVarNames();
    for (const [input, expected] of TABLE) {
      if (input === undefined) {
        expect([...piConfigValueEnvVarNames(undefined)]).toEqual([...expected]);
        continue;
      }
      const fromPi = piNames(input);
      expect({ input, fromPi }).toEqual({ input, fromPi: [...expected] });
      expect({ input, fromBob: [...piConfigValueEnvVarNames(input)] }).toEqual({
        input,
        fromBob: fromPi,
      });
    }
  });
});
