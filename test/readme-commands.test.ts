import { describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Closes tpsdev-ai/bob#149.
//
// The README's usage section must only name commands and flags the CLI actually
// accepts. Before the fix it advertised `bob serve` (a retired command — a run
// with no prompt *is* the persistent mode); it named `--interactive` (the CLI
// rejects it); and it described scheduling as system cron, when the persistent
// `bob run` runtime fires bob.yaml `cron:` entries in-process.
//
// This test reads README.md, collects every `bob <command>` it names in code
// spans or code blocks, and fails if the CLI does not accept that command.
//
// The command matcher is deliberately strict. A `bob` preceded by `/` (such as
// "bin/bob" in the repo-layout block) is not a command, and a multi-line code
// chunk must not let a `bob` bind to an unrelated word (`the`, `is`) on a later
// line. Requiring whitespace / a backtick / start-of-chunk immediately before
// `bob` closes both holes.

const CLI = join(import.meta.dir, "..", "dist", "cli.js");
const README = join(import.meta.dir, "..", "README.md");

// Flags the CLI rejects, named in issue #149. Kept small and explicit rather than
// derived from `bob help`, which advertises `--interactive` in a "coming in a
// later PR" parenthetical — that would mask the very failure this guards.
const RETIRED_FLAGS = ["--interactive"];

// `bob` as a standalone command, not the tail of a path ("bin/bob"/"bob.yaml").
const BOB_COMMAND = /(^|[\s`])bob\s+([a-z][\w-]*)/g;

// Every piece of code in the README: fenced ``` blocks and inline ` spans.
function codeChunks(md: string): string[] {
  const chunks: string[] = [];
  for (const m of md.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) chunks.push(m[1]);
  for (const m of md.matchAll(/`([^`\n]+)`/g)) chunks.push(m[1]);
  return chunks;
}

function commandsNamedIn(md: string): string[] {
  const found = new Set<string>();
  for (const chunk of codeChunks(md)) {
    BOB_COMMAND.lastIndex = 0;
    for (const m of chunk.matchAll(BOB_COMMAND)) found.add(m[2]);
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
    out = execSync(`node ${CLI} ${cmd} 2>&1`, { encoding: "utf8" });
  } catch (e) {
    out =
      (e as { stdout?: string; stderr?: string }).stdout ?? (e as { stderr?: string }).stderr ?? "";
  }
  return !/unknown command/i.test(out);
}

describe("README usage names only commands/flags the CLI accepts (#149)", () => {
  it("rejects `bob <command>` names the CLI does not accept", () => {
    const rejected = commandsNamedIn(readFileSync(README, "utf8")).filter((c) => !cliAccepts(c));
    if (rejected.length) {
      throw new Error(
        `README names commands the CLI no longer accepts: ${rejected.join(", ")} ` +
          `(run 'bob help' for the real list)`,
      );
    }
    expect(rejected).toEqual([]);
  }, 120_000);

  it("rejects retired flags in a `bob` example", () => {
    const flagged = retiredFlagsNamedIn(readFileSync(README, "utf8"));
    if (flagged.length) {
      throw new Error(`README names flags the CLI rejects: ${flagged.join(", ")}`);
    }
    expect(flagged).toEqual([]);
  });
});
