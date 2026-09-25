import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnNode } from "./cli-spawn.js";

// Closes tpsdev-ai/bob#149.
//
// The README's usage section must only name commands the CLI actually accepts.
// The test reads the `bob <command>` names the README carries in three places —
// inline code spans, fenced code blocks, and the Commands table — and fails if
// the CLI rejects any of them. It also fails if the retired `--interactive` flag
// appears as a word in a code span or code fence (table cells are not scanned for flags).
//
// Two vacuous-pass modes are closed:
//  - a plain-text Commands-table row (no backticks) is read as a table cell,
//    not skipped, so a `bob serve` row written in prose is caught;
//  - an empty extraction is refused: the names extracted from spans, fences and
//    the table must include run, launch, init and onboard, so the test can only pass because it
//    actually found them, not because it found nothing.
//
// The command matcher binds only within a single line: a `bob` at the end of a
// line must not catch an unrelated word (the, is) at the start of the next.

const CLI = join(import.meta.dir, "..", "dist", "cli.js");
// BOB_README lets the test run against a fixture copy of the README (used to
// prove the Commands-table read and the non-empty guard actually fire) without
// touching the real README.
const README = process.env.BOB_README
  ? process.env.BOB_README
  : join(import.meta.dir, "..", "README.md");

// Flags the CLI rejects, named in issue #149. Kept small and explicit rather than
// derived from `bob help`: the help lists what the CLI accepts, so it cannot name
// what the CLI rejects.
const RETIRED_FLAGS = ["--interactive"];

// The extracted names (spans, fences and the table) must include these, else the extraction is trusted to
// have found nothing (the empty-extraction vacuous-pass).
const REQUIRED_COMMANDS = ["run", "launch", "init", "onboard"];

// `bob` as a standalone command, matched within a single line only. A `bob`
// preceded by `/` (such as "bin/bob" in the repo-layout block) is not a
// command; the [ \t] gap (never \s, which includes \n) keeps a `bob` at the end
// of a line from binding to a word on the next.
const BOB_COMMAND = /(^|[ \t`])bob[ \t]+([a-z][\w-]*)/g;

// Every piece of code in the README: fenced ``` blocks and inline ` spans.
function codeChunks(md: string): string[] {
  const chunks: string[] = [];
  for (const m of md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) chunks.push(m[1]);
  for (const m of md.matchAll(/`([^`\n]+)`/g)) chunks.push(m[1]);
  return chunks;
}

// The command column (first cell) of each row in the `## Commands` markdown
// table, read as plain text — a row written in prose (no backticks) is still
// read. That prose row is the hole the vacuous-pass mode "a plain-text Commands
// table row names bob serve" left open in the previous round.
function commandsTableCells(md: string): string[] {
  const m = md.match(/(?:^|\n)#{2,}\s+Commands\b([\s\S]*?)(?:\n#{2,}\s|\n#\s|$)/);
  if (!m) return [];
  const cells: string[] = [];
  for (const line of m[1].split(/\n/)) {
    const t = line.trim();
    if (t.startsWith("|")) {
      // First cell sits between the leading `|` and the next `|`.
      const parts = t.split("|");
      if (parts.length >= 2) cells.push(parts[1] ?? "");
    }
  }
  return cells;
}

function commandsNamedIn(md: string): string[] {
  const found = new Set<string>();
  for (const chunk of [...codeChunks(md), ...commandsTableCells(md)]) {
    for (const line of chunk.split(/\n/)) {
      BOB_COMMAND.lastIndex = 0;
      for (const m of line.matchAll(BOB_COMMAND)) found.add(m[2]);
    }
  }
  return [...found];
}

function retiredFlagsNamedIn(md: string): string[] {
  const found = new Set<string>();
  for (const chunk of codeChunks(md)) {
    for (const raw of chunk.split(/[\s,]/)) {
      // A code span wraps its contents in backticks; the flag token may still
      // carry a leading ` from the span open or trailing ` from the span close.
      const token = raw.replace(/^`+/, "").replace(/`+$/, "");
      if (RETIRED_FLAGS.includes(token)) found.add(token);
    }
  }
  return [...found];
}

// The CLI prints "unknown command 'X'" (and exits non-zero) for a command it
// does not accept; every accepted command — even one missing its <name> — runs
// past that gate, so "unknown command" is the acceptance signal.
function cliAccepts(cmd: string): boolean {
  let out = "";
  try {
    out = spawnNode([CLI, cmd]);
  } catch (e) {
    out =
      ((e as { stdout?: string; stderr?: string }).stdout ?? "") +
      ((e as { stderr?: string }).stderr ?? "");
  }
  return !/unknown command/i.test(out);
}

// Control probe, added after a review round caught a vacuous-pass mode: if
// dist/cli.js is missing or crashes before dispatch, Node prints no "unknown
// command" line, and cliAccepts would then return true for *every* command, so
// the assertion below would pass while proving nothing. Running a made-up
// command that the dispatcher MUST refuse — and requiring the "unknown command"
// answer — proves the probe actually reached the command dispatcher before any
// cliAccepts result is trusted.
const CONTROL_CMD = "definitely-not-a-command";

function cliProbeOk(): { ok: boolean; out: string } {
  let out = "";
  try {
    out = spawnNode([CLI, CONTROL_CMD]);
  } catch (e) {
    out =
      ((e as { stdout?: string; stderr?: string }).stdout ?? "") +
      ((e as { stderr?: string }).stderr ?? "");
  }
  return { ok: /unknown command/i.test(out), out };
}

describe("README usage names only commands/flags the CLI accepts (#149)", () => {
  it("rejects `bob <command>` names the CLI does not accept", () => {
    const probe = cliProbeOk();
    if (!probe.ok) {
      throw new Error(
        "could not probe the CLI dispatcher: a made-up command did not yield " +
          "'unknown command', so dist/cli.js is missing or crashed before dispatch. " +
          "cliAccepts results cannot be trusted. Output:\n" +
          probe.out,
      );
    }
    const named = commandsNamedIn(readFileSync(README, "utf8"));
    // An empty extraction is itself a failure: with no `bob <command>` found,
    // the "rejects" assertion below passes vacuously. Require a non-empty set so
    // the test can only pass because the README actually named commands.
    if (named.length === 0) {
      throw new Error(
        "extracted zero `bob <command>` names from the README's Commands " +
          "table, code spans and fences; the 'rejects' assertion " +
          "below would pass while checking nothing",
      );
    }
    // The names extracted from spans, fences and the table must include the commands a bob
    // user will actually reach. If any is missing, either the README dropped it or
    // the extraction missed it; the "non-empty" check alone would not notice.
    for (const need of REQUIRED_COMMANDS) {
      if (!named.includes(need)) {
        throw new Error(
          `README code spans, fences and Commands table do not name the required command ` +
            `'bob ${need}' — either the README dropped it or the extraction missed it`,
        );
      }
    }
    const rejected = named.filter((c) => !cliAccepts(c));
    if (rejected.length) {
      throw new Error(
        `README names commands the CLI no longer accepts: ${rejected.join(", ")} ` +
          "(run 'bob help' for the real list)",
      );
    }
    expect(rejected).toEqual([]);
  }, 120_000);

  it("rejects retired flags in a code span or code fence", () => {
    const flagged = retiredFlagsNamedIn(readFileSync(README, "utf8"));
    if (flagged.length) {
      throw new Error(`README names flags the CLI rejects: ${flagged.join(", ")}`);
    }
    expect(flagged).toEqual([]);
  });

  it("reads plain-text Commands-table rows, and an empty table yields no names", () => {
    // A prose row (no backticks) must be read as a command — the vacuous-pass
    // mode that used to slip through when only spans and fences were read.
    const proseTable =
      "## Commands\n\n" +
      "| Command | What it does |\n" +
      "| ------- | ------------ |\n" +
      "| bob serve | a prose row, no backticks |\n" +
      "| `bob run <name>` | the backtick row |\n" +
      "\n## Section two\n\ntext.\n";
    const got = commandsNamedIn(proseTable);
    if (!got.includes("serve") || !got.includes("run")) {
      throw new Error("Commands table not read as expected: " + JSON.stringify(got));
    }
    // An empty Commands table must extract zero commands, so that the non-empty
    // guard in the file-reading test trips on it.
    const empty = "## Commands\n\n| Command | What it does |\n| ---- | ---- |\n\n## After\ntext.\n";
    if (commandsNamedIn(empty).length !== 0) {
      throw new Error("an empty Commands table should extract zero commands");
    }
    // The cross-line hole must stay closed: a `bob` at the end of one line
    // must not bind to `run` at the start of the next.
    const splitCommand = "in a fence:\n```\nbob\nrun\n```\n";
    if (commandsNamedIn(splitCommand).includes("run")) {
      throw new Error("a `bob` on one line wrongly bound to `run` on the next");
    }
    expect(got).toContain("serve");
  });
});
