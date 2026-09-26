import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { type SpawnError, spawnNode } from "./cli-spawn.js";

const CLI = join(import.meta.dir, "..", "dist", "cli.js");

// Control probe: a made-up command the dispatcher MUST refuse. If dist/cli.js
// is missing or crashes before dispatch, Node prints no "unknown command"
// line, and the per-command assertions below would read every failure as
// "not unknown" and pass vacuously. Requiring this control to refuse a
// made-up command proves the probe reached the command dispatcher before any
// per-command result is trusted.
const CONTROL_CMD = "definitely-not-a-command";

/**
 * Probes that dist/cli.js reached the command dispatcher (and did not miss or
 * crash before it), so the per-command "unknown command" checks below are
 * trusted rather than passing vacuously.
 */
function cliProbeOk(): { ok: boolean; out: string } {
  let out = "";
  try {
    out = spawnNode([CLI, CONTROL_CMD]);
  } catch (e) {
    out =
      (e as { stdout?: string; stderr?: string }).stdout ?? (e as { stderr?: string }).stderr ?? "";
  }
  return { ok: /unknown command/i.test(out), out };
}

// Every command `bob help` advertises must be one the dispatcher actually
// accepts. A command the help lists but the switch rejects surfaces as
// "unknown command '<name>'" — exactly the `office join <name>` mismatch
// (#161): the help advertised a surface the CLI never had, and the dispatch
// refused it.

// Collect the command headers from the Commands: section only. A command line
// starts at exactly two spaces; every description continuation is indented
// further, so `^  \S` isolates the headers while ignoring the prose.
function advertisedCommands(help: string): string[] {
  const lines = help.split("\n");
  const start = lines.findIndex((l) => l.trim() === "Commands:");
  if (start === -1) throw new Error("help has no Commands: section");
  const cmds: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") break; // the Commands: section ends at the blank line
    const m = line.match(/^\s{2}(\S+)/);
    if (m) cmds.push(m[1]);
  }
  // Dedupe while preserving order: "run <name>" and "run <name> <prompt>"
  // both parse to the same command header.
  return [...new Set(cmds)];
}

describe("help matches dispatch (#161)", () => {
  // The built CLI's help is the contract under test, so run the compiled
  // dist, not the source.
  const help = spawnNode([CLI, "help"]);
  const commands = advertisedCommands(help);

  // Prove the CLI probe reached the dispatcher before trusting any per-command
  // result; a missing/crashing dist/cli.js prints no "unknown command" and would
  // leave every failing spawn reading as "not unknown" (a vacuous pass).
  it("the CLI probe reaches the command dispatcher", () => {
    const probe = cliProbeOk();
    if (!probe.ok) {
      throw new Error(
        "could not probe the CLI dispatcher: a made-up command did not yield " +
          "'unknown command', so dist/cli.js is missing or crashed before dispatch. " +
          "The help-vs-dispatch cases below are untrustworthy. Output:\n" +
          probe.out,
      );
    }
    expect(probe.ok).toBe(true);
  });

  // Guard against a vacuous pass: if the parser found nothing, every
  // per-command case below would be skipped and the test would appear green.
  it("the help lists a non-trivial set of commands", () => {
    expect(commands.length).toBeGreaterThan(5);
    expect(commands).toContain("onboard");
  });

  // One case per advertised command, so each spawn gets its own budget and a
  // distinct name in the report (the same race a single test spawning several
  // commands hit — see test/cli.test.ts).
  it.each(commands)("%s is not rejected as an unknown command", (cmd) => {
    let output = "";
    let killed = false;
    try {
      spawnNode([CLI, cmd]);
    } catch (err) {
      const cause = err as SpawnError;
      // A kill/timeout (a termination signal, or killed) means the command
      // never completed: fail here rather than reading partial captured
      // output as "not unknown" (accepted).
      killed = cause.killed || Boolean(cause.signal);
      output = cause.stdout;
    }
    // A command that timed out (killed) never completed; the test must fail.
    if (killed) {
      throw new Error(`spawn for command '${cmd}' was killed (timed out)`);
    }
    // A real, dispatched command may still exit non-zero (e.g. a bare `bob
    // onboard` prints "missing <name>"). We assert only that it is not
    // refused as unknown — the help-vs-dispatch gap #161.
    expect(output).not.toContain("unknown command");
  });
});
