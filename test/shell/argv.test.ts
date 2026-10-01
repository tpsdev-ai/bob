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
  countFlag,
  parseArgs,
  secondsFlagToMs,
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
      ["dry-run", "flair", "force", "interactive", "no-flair", "no-interactive"].sort(),
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

// bob#135 — the numeric flags behind `bob run`'s bounds. A bare, empty or
// out-of-range value is refused by name before any run starts, never armed as a
// nonsense deadline.
describe("secondsFlagToMs", () => {
  it("reads a whole number of seconds as milliseconds", () => {
    expect(secondsFlagToMs({ timeout: "90" }, "timeout")).toBe(90_000);
    expect(secondsFlagToMs({ timeout: "2147483" }, "timeout")).toBe(2_147_483_000);
  });

  it("treats an absent flag as not given, but a bare or empty flag as a UsageError", () => {
    expect(secondsFlagToMs({}, "timeout")).toBeUndefined();
    expect(() => secondsFlagToMs({ timeout: true }, "timeout")).toThrow(UsageError);
    expect(() => secondsFlagToMs({ timeout: "" }, "timeout")).toThrow(UsageError);
  });

  it("refuses zero, negative, non-integer, past-the-timer-range and unsafe values", () => {
    for (const bad of ["0", "-1", "1.5", "abc"]) {
      expect(() => secondsFlagToMs({ timeout: bad }, "timeout")).toThrow(/--timeout/);
    }
    // 2147484 s → 2147484000 ms; setTimeout clamps that to 1 ms.
    expect(() => secondsFlagToMs({ timeout: "2147484" }, "timeout")).toThrow(
      /at most 2147483 seconds/,
    );
    // Past Number.MAX_SAFE_INTEGER, so the converted ms is not a safe integer.
    expect(() => secondsFlagToMs({ timeout: "9007199254740993" }, "timeout")).toThrow(
      /at most 2147483 seconds/,
    );
  });
});

describe("countFlag", () => {
  it("reads a non-negative whole number up to the cap", () => {
    expect(countFlag({ "turn-retries": "0" }, "turn-retries")).toBe(0);
    expect(countFlag({ "turn-retries": "3" }, "turn-retries")).toBe(3);
    expect(countFlag({ "turn-retries": "100" }, "turn-retries")).toBe(100);
  });

  it("treats an absent flag as not given, but a bare or empty flag as a UsageError", () => {
    expect(countFlag({}, "turn-retries")).toBeUndefined();
    expect(() => countFlag({ "turn-retries": true }, "turn-retries")).toThrow(UsageError);
    expect(() => countFlag({ "turn-retries": "" }, "turn-retries")).toThrow(UsageError);
  });

  it("refuses a negative, fractional, non-numeric, unsafe or past-the-cap value", () => {
    for (const bad of ["-1", "1.5", "abc"]) {
      expect(() => countFlag({ "turn-retries": bad }, "turn-retries")).toThrow(/--turn-retries/);
    }
    expect(() => countFlag({ "turn-retries": "101" }, "turn-retries")).toThrow(/between 0 and 100/);
    expect(() => countFlag({ "turn-retries": "9007199254740993" }, "turn-retries")).toThrow(
      /between 0 and 100/,
    );
  });
});
