// The bare-flag rule, in one place (#155).
//
// `bob run` and `bob install-service` have always read `--model` as "a flag with
// no value is not a value"; `bob align` now reads `--provider` and `--model` the
// same way, and all three go through `stringFlag`. These cases pin the rule
// itself, so the align cases in align.test.ts can assert the behaviour it
// produces (a bare flag leaves the agent's bob.yaml fields alone) without either
// file re-stating the rule.
import { describe, expect, it } from "bun:test";
import {
  BOOLEAN_FLAGS,
  boolFlag,
  parseArgs,
  stringFlag,
  UsageError,
} from "../../src/shell/argv.js";

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

  it("reads --key= (empty value) on a VALUE flag as the empty string, which stringFlag treats as not given", () => {
    const parsed = parseArgs(["align", "testbot", "--model="]);
    expect(parsed.flags.model).toBe("");
    expect(stringFlag(parsed.flags, "model")).toBeUndefined();
    expect(parseArgs(["run", "--model"]).flags.model).toBe(true);
  });

  // --- Declared boolean flags: validated at parse time, by whitelist (#173 round 3) ---
  it("declares every boolean flag the CLI reads", () => {
    expect([...BOOLEAN_FLAGS].sort()).toEqual(
      ["dry-run", "force", "interactive", "no-flair", "no-interactive"].sort(),
    );
  });

  it("parses a boolean's bare, =true and =false forms to booleans", () => {
    expect(parseArgs(["onboard", "x", "--dry-run"]).flags["dry-run"]).toBe(true);
    expect(parseArgs(["onboard", "x", "--dry-run=true"]).flags["dry-run"]).toBe(true);
    expect(parseArgs(["onboard", "x", "--dry-run=false"]).flags["dry-run"]).toBe(false);
  });

  it("refuses any other boolean spelling AT PARSE TIME, before a command could run", () => {
    for (const bad of ["--dry-run=yes", "--dry-run=1", "--dry-run=TRUE", "--dry-run="]) {
      expect(() => parseArgs(["onboard", "x", bad])).toThrow(UsageError);
      expect(() => parseArgs(["onboard", "x", bad])).toThrow("--dry-run takes no value");
    }
  });

  it("a repeated boolean cannot hide an invalid earlier value (each occurrence is validated)", () => {
    expect(() => parseArgs(["onboard", "x", "--dry-run=yes", "--dry-run=false"])).toThrow(
      "got 'yes'",
    );
    // valid repeats: the last one wins, as for every flag
    expect(parseArgs(["onboard", "x", "--dry-run=true", "--dry-run=false"]).flags["dry-run"]).toBe(
      false,
    );
  });

  it("a boolean flag never takes the next token as its value (`--dry-run testbot` keeps the name)", () => {
    const parsed = parseArgs(["onboard", "--dry-run", "testbot"]);
    expect(parsed.flags["dry-run"]).toBe(true);
    expect(parsed.positional).toEqual(["testbot"]);
  });

  it("refuses the space form `--force false` rather than leaving `false` as a stray positional", () => {
    // `--force false` would otherwise parse as force ON plus a positional "false" —
    // the unsafe direction for a flag that overwrites an existing agent dir.
    expect(() => parseArgs(["onboard", "x", "--force", "false"])).toThrow("--force=false");
    expect(() => parseArgs(["onboard", "x", "--force", "true"])).toThrow(UsageError);
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

// `boolFlag` is the second guard: the same whitelist for a flag map built by
// hand, or for a boolean a caller reads that BOOLEAN_FLAGS does not declare.
describe("boolFlag", () => {
  it("reads absent as false, and booleans as themselves", () => {
    expect(boolFlag({}, "dry-run")).toBe(false);
    expect(boolFlag({ "dry-run": true }, "dry-run")).toBe(true);
    expect(boolFlag({ "dry-run": false }, "dry-run")).toBe(false);
  });

  it("accepts only the strings 'true' and 'false'; anything else — including the empty string — is a UsageError", () => {
    expect(boolFlag({ "dry-run": "true" }, "dry-run")).toBe(true);
    expect(boolFlag({ "dry-run": "false" }, "dry-run")).toBe(false);
    for (const bad of ["yes", "1", "TRUE", ""]) {
      expect(() => boolFlag({ "dry-run": bad }, "dry-run")).toThrow(UsageError);
    }
  });
});
