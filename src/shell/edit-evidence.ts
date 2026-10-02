// bob#283 — the ONE rule for a "verified edit": a write-class FILE-EDIT tool
// whose execution ended without an error, without a refusal, and with the
// tool's own success evidence in its result.
//
// A write-class row is not enough on its own. `run`/`bash`/`powershell` are
// writer rows (a command can change anything) but they are commands, not file
// edits; `flair_write` and the other writer tools (a memory write, an egress)
// are not file edits either. Only the names below carry per-file success
// evidence, read from their implementations:
//   edit_lines, insert_after  details.fingerprint (F# + 16 hex), details.lineDelta
//   write_file                details.fingerprint, details.bytes
//   edit                      details.diff, nonblank
//   write                     a text block "Successfully wrote N bytes to <path>"
//   replace_lines             a text block "Replaced lines A-B in <path>."
// A refusal (`details.refused`, the shape the setup tools return) is never
// evidence, and a name with no row is never evidence: an unknown tool is not a
// success.

import { TOOL_EFFECTS } from "./tool-allowlist.js";

// Writer effects that run a command or a request rather than editing a file.
const COMMAND_RUNNER_TOOLS: ReadonlySet<string> = new Set(["run", "bash", "powershell"]);

/** True when the name is a write-class FILE-EDIT tool. */
export function isFileEditTool(toolName: string): boolean {
  return (
    Object.hasOwn(TOOL_EFFECTS, toolName) &&
    TOOL_EFFECTS[toolName] === "writer" &&
    !COMMAND_RUNNER_TOOLS.has(toolName)
  );
}

export function hasEditSuccessEvidence(toolName: string, result: unknown): boolean {
  if (result === null || typeof result !== "object") return false;
  const output = result as { details?: Record<string, unknown>; content?: unknown };
  const details = output.details;
  // A refusal is not an edit, whatever else the result carries.
  if (details?.refused) return false;
  switch (toolName) {
    case "edit_lines":
    case "insert_after":
      return (
        typeof details?.fingerprint === "string" &&
        /^F#[0-9a-f]{16}$/.test(details.fingerprint) &&
        Number.isSafeInteger(details.lineDelta)
      );
    case "write_file":
      return (
        typeof details?.fingerprint === "string" &&
        /^F#[0-9a-f]{16}$/.test(details.fingerprint) &&
        typeof details.bytes === "number" &&
        Number.isSafeInteger(details.bytes) &&
        details.bytes >= 0
      );
    case "edit":
      return typeof details?.diff === "string" && details.diff.trim().length > 0;
    case "write":
    case "replace_lines": {
      const success =
        toolName === "write"
          ? /^Successfully wrote \d+ bytes to [\s\S]+$/
          : /^Replaced lines [1-9]\d*-[1-9]\d* in [\s\S]+\.$/;
      return (
        Array.isArray(output.content) &&
        output.content.some(
          (block) =>
            block?.type === "text" && typeof block.text === "string" && success.test(block.text),
        )
      );
    }
    default:
      return false;
  }
}

export function isVerifiedFileEdit(toolName: string, isError: unknown, result: unknown): boolean {
  return isError === false && isFileEditTool(toolName) && hasEditSuccessEvidence(toolName, result);
}
