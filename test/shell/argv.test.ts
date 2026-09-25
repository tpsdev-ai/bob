// The bare-flag rule, in one place (#155).
//
// `bob run` and `bob install-service` have always read `--model` as "a flag with
// no value is not a value"; `bob align` now reads `--provider` and `--model` the
// same way, and all three go through `stringFlag`. These cases pin the rule
// itself, so the align cases in align.test.ts can assert the behaviour it
// produces (a bare flag leaves the agent's bob.yaml fields alone) without either
// file re-stating the rule.
import { describe, expect, it } from "bun:test";
import { parseArgs, stringFlag } from "../../src/shell/argv.js";

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

// `parseArgs` (moved out of cli.ts so a unit can import it WITHOUT running the
// CLI's top-level main()) — the CLI argument parser the subcommands all share.
describe("parseArgs", () => {
  // --- The --key=value fix (#170) ---
  it("reads --key=value as the key's value without consuming the next token", () => {
    // The bug: `--model=foo` was parsed as a flag literally named
    // `model=foo`, and when the next token was not a flag it was taken as the
    // value — so `bob run --model=foo ember "task"` swallowed the agent name
    // `ember`. With the fix the positional survives.
    const parsed = parseArgs(["run", "--model=foo", "ember", "task"]);
    expect(parsed.command).toBe("run");
    expect(parsed.flags.model).toBe("foo");
    expect(parsed.positional).toEqual(["ember", "task"]);
  });

  it("parses several --key=value forms, none eating the next token", () => {
    const parsed = parseArgs(["run", "--model=foo", "--provider=bar", "ember", "task"]);
    expect(parsed.flags).toEqual({ model: "foo", provider: "bar" });
    expect(parsed.positional).toEqual(["ember", "task"]);
  });

  it("treats --key= (empty value) as a bare flag, exactly like --key alone", () => {
    expect(parseArgs(["align", "testbot", "--model="]).flags.model).toBe(true);
    expect(parseArgs(["run", "--model"]).flags.model).toBe(true);
  });

  // --- Today's behaviour (pinned; NO code change) ---
  it("an empty-string VALUE after a flag is a bare flag (the !next rule: the empty string is falsy)", () => {
    // `--provider ""`: the empty string is a token, and `""` is falsy, so the
    // valueless-flag branch stores the boolean true. This is what main does, and
    // the fix does not change it.
    expect(parseArgs(["align", "testbot", "--provider", ""]).flags.provider).toBe(true);
  });

  it("a repeated flag keeps the LAST value (the object key is overwritten)", () => {
    expect(parseArgs(["run", "--model", "a", "--model", "b"]).flags.model).toBe("b");
  });
});
