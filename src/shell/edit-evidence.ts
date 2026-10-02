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
  if (result === null || typeof result !== "object" || Array.isArray(result)) return false;
  const output = result as { details?: unknown; content?: unknown };
  if (!Array.isArray(output.content) || output.content.length === 0) return false;
  for (const block of output.content) {
    if (
      block === null ||
      typeof block !== "object" ||
      Array.isArray(block) ||
      block.type !== "text" ||
      typeof block.text !== "string" ||
      block.text.trim().length === 0
    )
      return false;
  }
  if (
    output.details !== undefined &&
    (output.details === null || typeof output.details !== "object" || Array.isArray(output.details))
  )
    return false;
  const details = output.details as Record<string, unknown> | undefined;
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
      return output.content.some((block) => success.test(block.text));
    }
    default:
      return false;
  }
}

export function isVerifiedFileEdit(toolName: string, isError: unknown, result: unknown): boolean {
  return isError === false && isFileEditTool(toolName) && hasEditSuccessEvidence(toolName, result);
}
