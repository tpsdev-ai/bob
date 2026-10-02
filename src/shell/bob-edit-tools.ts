// bob-edit-tools.ts — bob#143 items 1 and 2, the pi-facing tools.
//
// TWO custom tools bob registers, each from its own allowance:
//
//   * `edit`        — pi's edit tool, wrapped so bob can resolve an oldText that
//                     differs only in runs of spaces/tabs (pi may still refuse
//                     the edit under its own matching). When pi has read
//                     the file and before it matches, an oldText that occurs
//                     exactly at more than one position, or nowhere exactly
//                     and at multiple normalised positions (overlaps included),
//                     is refused. On pi's exact/fuzzy
//                     match failure the wrapper resolves each oldText through
//                     edit-tolerance.ts: the exact pass first, and only for an
//                     oldText that occurs nowhere exactly the whitespace-run-
//                     normalised pass, which accepts only one normalised
//                     position (overlapping occurrences included). It hands
//                     pi's own tool the exact file substrings, so pi keeps its
//                     path resolution, write queue and diff. A successful
//                     normalised retry's result says how many edits needed the
//                     normalisation.
//   * `replace_lines` — replace an inclusive 1-based line range without
//                     reproducing the old lines. It reads the file, validates
//                     the range against that content, then writes the range back
//                     inside pi's per-file mutation queue — the LINE NUMBERS
//                     decide the range, so a range containing a line repeated
//                     elsewhere still lands.
//
// Neither tool invents a sandbox. Both BIND their read and their write to the
// workspace entry they checked (bob#273). The tolerant `edit` plugs bob's
// operations into pi's edit tool: each operation resolves and checks the
// ABSOLUTE path pi is about to open (a target outside the workspace root is
// refused), opens it with O_NOFOLLOW, and works from the descriptor only when
// its device and inode are the checked entry's; the write also requires the
// identity the read saw. `replace_lines` does the same with one O_RDWR
// descriptor it both reads and writes through. The edit call's inherited diff
// preview is disabled because it reads without these checks. This closes the
// checked canonical path's FINAL component swapped between the check and the
// open/write; an intermediate directory swapped for a symlink between the check
// and the open is NOT detected when the new path still leads to the same device
// and inode (Node exposes no openat on any platform this runs on, and O_NOFOLLOW
// guards only the final component). It is an in-process guard
// against MODEL MISTAKES: a hostile local process that can write the workspace
// is the OS boundary's job (bob#189, bob under nono), not this.

import type { FileHandle } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import {
  createEditToolDefinition,
  type EditOperations,
  type ToolDefinition,
  withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { checkWriteTargetVerified, openVerifiedWriteTarget } from "./confined-read.js";
import {
  EditMatchError,
  type EditRequest,
  locateTolerantEdits,
  refuseAmbiguousOldTextBeforePiMatch,
} from "./edit-tolerance.js";

// pi's not-found or duplicate-match errors. Access failures ("Could not edit
// file") must propagate untouched.
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
  // The input of the pi call about to run; its edits are checked when pi reads.
  check: (input: unknown) => void;
}

// Test seams for the check-to-open window, the verified-read-to-write window,
// and short writes. Production passes nothing.
export interface EditWriteHooks {
  betweenCheckAndOpen?: (canonicalPath: string, phase: "read" | "write") => void | Promise<void>;
  afterVerifiedRead?: (canonicalPath: string) => void | Promise<void>;
  wrapOpenedFileHandle?: (handle: FileHandle, phase: "read" | "write") => FileHandle;
}

export class IncompleteWriteError extends Error {
  override name = "IncompleteWriteError";
}

async function writeAll(fh: FileHandle, bytes: Buffer, path: string): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await fh.write(bytes, offset, bytes.length - offset, offset);
    if (bytesWritten <= 0) {
      throw new IncompleteWriteError(`bob: incomplete write to ${path}: no progress`);
    }
    offset += bytesWritten;
  }
}

// pi's edit operations, bound to the checked workspace entry. Each operation
// resolves and checks the ABSOLUTE path pi is about to open, runs the test hook,
// then opens it with O_NOFOLLOW and works from the descriptor only when its
// device and inode are the checked entry's; the write also requires the identity
// the read saw. One capture per edit execution: pi runs a response's tool calls
// in parallel by default, so a capture shared across calls could hold another
// file's content when the fallback reads it.
//
// The read rejects ambiguous exact matches, or ambiguous normalised matches
// when there is no exact match. It runs before pi matches, so pi's own count,
// which skips overlapping occurrences, never decides these cases.
function boundEditOperations(cwd: string, hooks: EditWriteHooks | undefined): CapturingOps {
  let captured = "";
  let pending: EditInput | undefined;
  let readIdentity: { dev: bigint; ino: bigint } | undefined;
  const openBound = async (
    absolutePath: string,
    phase: "read" | "write",
    expected?: { dev: bigint; ino: bigint },
  ) => {
    const checked = checkWriteTargetVerified(absolutePath, cwd);
    await hooks?.betweenCheckAndOpen?.(checked.path, phase);
    const fh = await openVerifiedWriteTarget(checked, absolutePath, {
      ...(phase === "read" ? { readOnly: true } : {}),
      ...(expected !== undefined ? { expected } : {}),
    });
    return hooks?.wrapOpenedFileHandle?.(fh, phase) ?? fh;
  };
  return {
    operations: {
      access: async (absolutePath) => {
        const fh = await openBound(absolutePath, "read");
        await fh.close();
      },
      readFile: async (absolutePath) => {
        const fh = await openBound(absolutePath, "read");
        try {
          const buffer = await fh.readFile();
          const st = await fh.stat({ bigint: true });
          readIdentity = { dev: st.dev, ino: st.ino };
          captured = buffer.toString("utf-8");
          await hooks?.afterVerifiedRead?.(absolutePath);
          refuseAmbiguousOldTextBeforePiMatch(
            captured,
            pending?.edits,
            String(pending?.path ?? ""),
          );
          return buffer;
        } finally {
          await fh.close();
        }
      },
      writeFile: async (absolutePath, text) => {
        const fh = await openBound(absolutePath, "write", readIdentity);
        try {
          const bytes = Buffer.from(text, "utf-8");
          await fh.truncate(0);
          await writeAll(fh, bytes, absolutePath);
        } finally {
          await fh.close();
        }
      },
    },
    content: () => captured,
    check: (input) => {
      pending = input as EditInput | undefined;
    },
  };
}

// Rewrite pi's success text to name how many edits needed the normalisation.
function noteNormalisation(result: unknown, count: number): unknown {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === "text" && typeof block.text === "string") {
        block.text = `${block.text} Matched ${count} edit(s) after normalising runs of spaces/tabs and ignoring trailing spaces/tabs.`;
      }
    }
  }
  return result;
}

// pi's edit tool, with the whitespace-run-tolerant retry in front of its
// failure, and bob's bound operations in front of pi's reads and writes.
// `hooks` is a test seam (see EditWriteHooks); production passes none.
export function createTolerantEditToolDefinition(
  cwd: string,
  hooks?: EditWriteHooks,
): ToolDefinition {
  const base = createEditToolDefinition(cwd);
  return {
    ...base,
    // pi's inherited call renderer reads the requested path for a diff preview
    // without using our checked operations. Let pi render this call generically.
    renderCall: undefined,
    async execute(
      callId: string,
      input: unknown,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) {
      // This execution's own capture and its own pi edit over it.
      const capturing = boundEditOperations(cwd, hooks);
      const runBase = createEditToolDefinition(cwd, { operations: capturing.operations })
        .execute as unknown as PiEditExecute;
      try {
        capturing.check(input);
        return await runBase(callId, input, signal, onUpdate, ctx);
      } catch (err) {
        if (err instanceof EditMatchError) throw err;
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
        const retry = { ...typed, edits: corrected };
        capturing.check(retry);
        const result = await runBase(callId, retry, signal, onUpdate, ctx);
        return noteNormalisation(result, normalizedCount);
      }
    },
  } as unknown as ToolDefinition;
}

// 1-based inclusive line spans, each including its own CRLF, LF, or CR terminator.
function lineSpans(content: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (const match of content.matchAll(/\r\n|\r|\n/g)) {
    const end = match.index + match[0].length;
    spans.push({ start, end });
    start = end;
  }
  if (start < content.length) spans.push({ start, end: content.length });
  return spans;
}

// `replace_lines` reads and writes through ONE O_RDWR descriptor, opened
// O_NOFOLLOW after the target is checked and used only while its device and
// inode are the checked entry's: the checked canonical path's FINAL component
// swapped for a symlink or another file before the open is refused.
// `hooks` is a test seam (see EditWriteHooks); production passes none.
export function createReplaceLinesToolDefinition(
  cwd: string,
  hooks?: EditWriteHooks,
): ToolDefinition {
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
      // against it, and a path that resolves outside it (absolute, through `..`
      // or through a symlink) is refused before reading file content or writing. An absolute
      // path inside the root is accepted. The checked entry's identity binds the
      // read and the write that follow to it.
      const requested = isAbsolute(path) ? path : resolve(cwd, path);
      const checked = checkWriteTargetVerified(requested, cwd);
      // Share pi's queue with edit/write. The read, range check, and write must
      // all see the same turn's preceding mutations before the next one starts.
      return withFileMutationQueue(checked.path, async () => {
        await hooks?.betweenCheckAndOpen?.(checked.path, "write");
        const opened = await openVerifiedWriteTarget(checked, path);
        const fh = hooks?.wrapOpenedFileHandle?.(opened, "write") ?? opened;
        try {
          let text: string;
          try {
            text = (await fh.readFile()).toString("utf-8");
            await hooks?.afterVerifiedRead?.(checked.path);
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
          // For nonempty newText without a terminator, keep the final selected line's terminator if present.
          const terminator = oldText.endsWith("\r\n")
            ? "\r\n"
            : oldText.endsWith("\n")
              ? "\n"
              : oldText.endsWith("\r")
                ? "\r"
                : "";
          const replacement =
            newText !== "" && terminator && !/[\r\n]$/.test(newText)
              ? `${newText}${terminator}`
              : newText;
          const bytes = Buffer.from(text.slice(0, from) + replacement + text.slice(to), "utf-8");
          await fh.truncate(0);
          await writeAll(fh, bytes, path);
          return {
            content: [{ type: "text", text: `Replaced lines ${startLine}-${endLine} in ${path}.` }],
          };
        } finally {
          await fh.close();
        }
      });
    },
  } as unknown as ToolDefinition;
}

/**
 * The bob-owned tools a session needs. Each is registered from its OWN
 * effective allowance: the tolerant `edit` (which shadows pi's built-in) when
 * `edit` is allowed, and `replace_lines` when the policy names it — a policy
 * may name either without the other. Registered as SDK custom tools, so the
 * tolerant `edit` shadows pi's built-in by name, and neither is active where
 * the allowlist does not name it.
 */
export function bobEditCustomTools(
  policy: { tools: readonly string[]; excludeTools: readonly string[] },
  cwd: string,
): ToolDefinition[] {
  const allows = (name: string): boolean =>
    policy.tools.includes(name) && !policy.excludeTools.includes(name);
  const tools: ToolDefinition[] = [];
  if (allows("edit")) tools.push(createTolerantEditToolDefinition(cwd));
  if (allows("replace_lines")) tools.push(createReplaceLinesToolDefinition(cwd));
  return tools;
}
