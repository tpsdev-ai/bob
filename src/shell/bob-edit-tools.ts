// bob-edit-tools.ts — bob#143 items 1 and 2, the pi-facing tools.
//
// TWO custom tools bob registers on a session that allows `edit`:
//
//   * `edit`        — pi's edit tool, wrapped so a model whose oldText differs
//                     only in runs of spaces/tabs still lands. The wrapper calls
//                     pi's edit FIRST; on an exact/fuzzy match failure it
//                     resolves each oldText through edit-tolerance.ts (exact,
//                     then a unique whitespace-run-normalised match) and hands
//                     pi's own tool the exact file substrings, so pi keeps its
//                     path resolution, write queue and diff. The result says how
//                     many edits needed the normalisation.
//   * `replace_lines` — replace an inclusive 1-based line range without
//                     reproducing the old lines. It reads the file, validates
//                     the range against that content, then writes the range back
//                     directly — the LINE NUMBERS decide the range, so a range
//                     containing a line repeated elsewhere still lands.
//
// Neither tool invents a sandbox. The tolerant `edit` resolves and writes
// through pi's edit tool exactly as pi does (pi resolves absolute paths as
// given). `replace_lines` writes with bob's own write control, confined to the
// run's workspace root (confined-read.ts's checkWriteTarget).

import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  createEditToolDefinition,
  type EditOperations,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checkWriteTarget } from "./confined-read.js";
import { type EditRequest, locateTolerantEdits } from "./edit-tolerance.js";

// pi's edit failure messages that mean "the oldText did not match": NOT the
// access failure ("Could not edit file"), which must propagate untouched.
const MATCH_ERROR =
  /^(Could not find (?:the exact text|edits\[\d+\])|Found \d+ occurrences of (?:the text|edits\[\d+\]))/;

type EditInput = { path: string; edits: EditRequest[] };

type PiEditExecute = (
  callId: string,
  input: unknown,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: unknown,
) => Promise<unknown>;

interface CapturingOps {
  operations: EditOperations;
  content: () => string;
}

// pi's default local operations, with the file's content captured so the caller
// can match against exactly what pi resolved and read.
function capturingOperations(): CapturingOps {
  let captured = "";
  return {
    operations: {
      access: (absolutePath) => access(absolutePath, constants.R_OK | constants.W_OK),
      readFile: async (absolutePath) => {
        const buffer = await readFile(absolutePath);
        captured = buffer.toString("utf-8");
        return buffer;
      },
      writeFile: (absolutePath, text) => writeFile(absolutePath, text, "utf-8"),
    },
    content: () => captured,
  };
}

// Rewrite pi's success text to name how many edits needed the normalisation.
function noteNormalisation(result: unknown, count: number): unknown {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        block.text = `${block.text} Matched ${count} edit(s) after normalising runs of spaces/tabs and ignoring trailing whitespace.`;
      }
    }
  }
  return result;
}

// pi's edit tool, with the whitespace-run-tolerant retry in front of its failure.
export function createTolerantEditToolDefinition(cwd: string): ToolDefinition {
  const capturing = capturingOperations();
  const base = createEditToolDefinition(cwd, { operations: capturing.operations });
  const runBase = base.execute as unknown as PiEditExecute;
  return {
    ...base,
    async execute(
      callId: string,
      input: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) {
      try {
        return await runBase(callId, input, signal, onUpdate, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (!MATCH_ERROR.test(message)) throw err;
        const typed = input as EditInput;
        const edits = Array.isArray(typed?.edits) ? typed.edits : [];
        const { edits: located, normalizedCount } = locateTolerantEdits(
          capturing.content(),
          edits,
          String(typed?.path ?? ""),
        );
        if (normalizedCount === 0) throw err;
        const corrected = [...located]
          .sort((a, b) => a.editIndex - b.editIndex)
          .map((edit) => ({ oldText: edit.oldText, newText: edit.newText }));
        const result = await runBase(callId, { ...typed, edits: corrected }, signal, onUpdate, ctx);
        return noteNormalisation(result, normalizedCount);
      }
    },
  } as unknown as ToolDefinition;
}

// 1-based inclusive line spans, each including its own line terminator.
function lineSpans(content: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    if (newline === -1) {
      spans.push({ start, end: content.length });
      break;
    }
    spans.push({ start, end: newline + 1 });
    start = newline + 1;
  }
  return spans;
}

export function createReplaceLinesToolDefinition(cwd: string): ToolDefinition {
  return {
    name: "replace_lines",
    label: "replace_lines",
    description:
      "Replace an inclusive 1-based line range of a file with new text, without reproducing the old lines. Use it instead of edit when oldText keeps failing to match. newText may be empty to delete the range.",
    parameters: Type.Object(
      {
        path: Type.String({ description: "Path to the file (relative or absolute)" }),
        startLine: Type.Integer({
          minimum: 1,
          description: "First line to replace (1-based, inclusive)",
        }),
        endLine: Type.Integer({
          minimum: 1,
          description: "Last line to replace (1-based, inclusive)",
        }),
        newText: Type.String({
          description: "Replacement text (may be empty to delete the range)",
        }),
      },
      { additionalProperties: false },
    ),
    async execute(_callId: string, input: unknown) {
      const { path, startLine, endLine, newText } = input as {
        path: string;
        startLine: number;
        endLine: number;
        newText: string;
      };
      // Confine the write to the run's workspace root: a relative path resolves
      // against it, and an absolute path, a `..` escape or an escaping symlink
      // resolves outside it and is refused before any read or write.
      const requested = isAbsolute(path) ? path : resolve(cwd, path);
      const target = checkWriteTarget(requested, cwd);
      // Read the file's real content, then validate the range against it — no
      // write happens before this check.
      let text: string;
      try {
        text = await readFile(target, "utf-8");
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(`replace_lines: could not read ${path}: ${message}`);
      }
      const spans = lineSpans(text);
      if (startLine > endLine) {
        throw new Error(
          `replace_lines: inverted range in ${path}: startLine ${startLine} > endLine ${endLine}.`,
        );
      }
      if (startLine < 1 || endLine > spans.length) {
        throw new Error(
          `replace_lines: out-of-range in ${path}: lines ${startLine}-${endLine}, but the file has ${spans.length} line(s).`,
        );
      }
      const from = spans[startLine - 1].start;
      const to = spans[endLine - 1].end;
      const oldText = text.slice(from, to);
      // Preserve the range's own trailing newline when the replacement omits one.
      const replacement =
        newText !== "" && oldText.endsWith("\n") && !newText.endsWith("\n")
          ? `${newText}\n`
          : newText;
      await writeFile(target, text.slice(0, from) + replacement + text.slice(to), "utf-8");
      return {
        content: [{ type: "text", text: `Replaced lines ${startLine}-${endLine} in ${path}.` }],
      };
    },
  } as unknown as ToolDefinition;
}

/**
 * The bob-owned tools a session needs when it allows `edit`: the tolerant `edit`
 * (which shadows pi's built-in) and `replace_lines`. Empty when `edit` is not
 * effectively allowed, so a resident agent without the shell grant does not get
 * them. Registered as SDK custom tools, so the tolerant `edit` shadows pi's
 * built-in by name; `replace_lines` is active where the allowlist names it (the
 * `coder`, `writer` and `custom` roles and the `builder` position).
 */
export function bobEditCustomTools(
  policy: { tools: readonly string[]; excludeTools: readonly string[] },
  cwd: string,
): ToolDefinition[] {
  if (!(policy.tools.includes("edit") && !policy.excludeTools.includes("edit"))) return [];
  return [createTolerantEditToolDefinition(cwd), createReplaceLinesToolDefinition(cwd)];
}
