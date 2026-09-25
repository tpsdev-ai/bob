// The bare-flag rule, in one place (#155).
//
// `bob run` and `bob install-service` have always read `--model` as "a flag with
// no value is not a value"; `bob align` now reads `--provider` and `--model` the
// same way, and all three go through `stringFlag`. These cases pin the rule
// itself, so the align cases in align.test.ts can assert the behaviour it
// produces (a bare flag leaves the agent's bob.yaml fields alone) without either
// file re-stating the rule.
import { describe, expect, it } from "bun:test";
import { stringFlag } from "../../src/shell/argv.js";

describe("stringFlag", () => {
  it("reads a flag that carries a value", () => {
    expect(stringFlag({ model: "claude-opus-4-7" }, "model")).toBe("claude-opus-4-7");
  });

  it("treats a bare flag as not given — the `true` parseArgs yields for `--model` alone", () => {
    // `bob run <name> --model` and `bob align <name> --model` parse to the
    // boolean true. `String(true)` would hand the session the model id "true";
    // undefined means "no override", which is what every caller wants.
    expect(stringFlag({ model: true }, "model")).toBeUndefined();
  });

  it("treats an absent flag as not given", () => {
    expect(stringFlag({}, "model")).toBeUndefined();
  });

  it("reads only the flag it was asked for", () => {
    const flags = { model: true, provider: "ollama-cloud" };
    expect(stringFlag(flags, "provider")).toBe("ollama-cloud");
    expect(stringFlag(flags, "model")).toBeUndefined();
  });

  it("keeps two flags' values apart (`--provider x --model` is a provider and no model)", () => {
    expect(stringFlag({ provider: "exe-dev-gateway", model: true }, "provider")).toBe(
      "exe-dev-gateway",
    );
    expect(stringFlag({ provider: "exe-dev-gateway", model: true }, "model")).toBeUndefined();
  });
});
