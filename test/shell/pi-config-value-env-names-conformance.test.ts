// The conformance pin for bob's copy of pi's reference grammar.
//
// pi 0.84.3 does not export `getConfigValueEnvVarNames` through its package
// specifier, so bob mirrors it in provider-custody.ts. A mirror drifts silently
// when pi changes, so this test loads pi's REAL function from its installed file
// (the exports map applies to package specifiers, not file paths) and asserts
// bob's copy returns exactly the same names for the same inputs.
//
// Test-only: production code never imports pi's internals. If pi's function is
// missing at the resolved path, the test FAILS naming the path — never skips —
// so a pi upgrade that moves it is noticed.
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

// Each row: an input and the names pi's grammar resolves. `undefined` is bob's
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
  ["trailing$", []],
  ["", []],
  [undefined, []],
];

describe("piConfigValueEnvVarNames conforms to pi's getConfigValueEnvVarNames", () => {
  it("returns exactly the names pi's real function returns for every grammar case", async () => {
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
