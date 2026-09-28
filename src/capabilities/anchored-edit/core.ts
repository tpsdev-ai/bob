// anchored-edit — the byte-exact, anchor-keyed file editing core for local
// builders (bob#185, slice 1).
//
// WHY THIS EXISTS. A local model that edits code by RETYPING whole files drifts:
// it loses final newlines, flips CRLF to LF, drops a BOM, and hallucinates
// changes it never made. This capability replaces whole-file rewriting with
// addressable line edits: a read returns a fingerprint for the file and an
// anchor token per line; a mutation names the lines it changes and the
// fingerprint it is editing. The tool splices RAW BYTE SPANS, so every byte
// outside the affected span is unchanged, and a call that would rewrite more
// than half a file is refused by a tripwire.
//
// This module is the testable core: pure byte logic (anchors, fingerprints,
// line model, splices) plus the session that applies the path rules, the
// per-path critical section and the tripwire. `capability.ts` is the thin
// adapter that registers the four pi tools; `index.ts` is the pi extension
// factory.
//
// The model, in one place:
//   * anchor token     L<n>#<h>, <h> = 8 lowercase hex of FNV-1a 32 over the
//                      line's UTF-8 bytes with the terminator and a trailing \r
//                      stripped. Fixed, unseeded. The line NUMBER is not folded
//                      into the hash — position already travels in the token.
//   * fingerprint      F#<16 hex>, the first 16 hex of SHA-256 over the raw file
//                      bytes (BOM included). Every mutation of an existing file
//                      must carry the current fingerprint.
//   * read_lines       header (fingerprint, line count, dominant ending, BOM)
//                      plus one `L<n>#<h> <content>` per line; pages of <=200
//                      lines and <=16 KiB, and the header says when it cut.
//   * edit_lines       replaces lines from..to inclusive; empty new_text deletes.
//   * insert_after     inserts after a real anchor, or L0 for before line 1.
//   * write_file       exclusive creation; takes no fingerprint.
//
// Documented GAPS live in README.md (cross-process race, bash outside the
// guards, slice-2 items) — read it before trusting this as a sandbox.

import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// --- limits (fixed in slice 1; no bob.yaml path can raise them) --------------

export const MAX_LINES_PER_PAGE = 200;
export const MAX_OUTPUT_BYTES = 16 * 1024;
export const MAX_LINE_CHARS = 2000;

// --- refusals ----------------------------------------------------------------

// A refusal carries the rule that fired and any signals the caller records in
// the structured tool result. `signals` names are stable: edit_without_read,
// stale_anchor, budget_stop.
export class Refusal extends Error {
  readonly signals: readonly string[];
  constructor(message: string, signals: readonly string[] = []) {
    super(message);
    this.name = "Refusal";
    this.signals = signals;
  }
}

// --- line model --------------------------------------------------------------

export interface RawLine {
  content: Buffer;
  // "" (unterminated final line), "\n", or "\r\n".
  terminator: "" | "\n" | "\r\n";
}

export interface ParsedFile {
  bom: boolean;
  lines: RawLine[];
}

// Split raw file bytes into lines, remembering each line's exact terminator.
// A trailing newline does NOT create a phantom empty last line; an empty file
// has zero lines.
export function splitRawLines(raw: Buffer): RawLine[] {
  const lines: RawLine[] = [];
  let idx = 0;
  for (;;) {
    const nl = raw.indexOf(0x0a, idx);
    if (nl === -1) {
      if (idx < raw.length) lines.push({ content: raw.subarray(idx), terminator: "" });
      break;
    }
    const seg = raw.subarray(idx, nl);
    if (seg.length > 0 && seg[seg.length - 1] === 0x0d) {
      lines.push({ content: seg.subarray(0, seg.length - 1), terminator: "\r\n" });
    } else {
      lines.push({ content: seg, terminator: "\n" });
    }
    idx = nl + 1;
    if (idx === raw.length) break; // file ended with a separator: no extra line
  }
  return lines;
}

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export function parseFile(raw: Buffer): ParsedFile {
  const bom = raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf;
  return { bom, lines: splitRawLines(bom ? raw.subarray(3) : raw) };
}

// Bytes that the line's anchor hash covers: the content with its terminator
// stripped and a trailing \r stripped.
export function hashBytes(line: RawLine): Buffer {
  let c = line.content;
  if (c.length > 0 && c[c.length - 1] === 0x0d) c = c.subarray(0, c.length - 1);
  return c;
}

// FNV-1a 32 over a byte string. Fixed, unseeded, no line number folded in.
export function fnv1a32(bytes: Buffer): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function anchorHashOf(line: RawLine): string {
  return fnv1a32(hashBytes(line)).toString(16).padStart(8, "0");
}

export function anchorToken(lineNo: number, line: RawLine): string {
  return `L${lineNo}#${anchorHashOf(line)}`;
}

export function fingerprintOf(raw: Buffer): string {
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

export type Eol = "lf" | "crlf" | "mixed";

// The dominant line ending. Ties (and files with no endings at all) are LF.
export function dominantEol(lines: readonly RawLine[]): Eol {
  let lf = 0;
  let crlf = 0;
  for (const l of lines) {
    if (l.terminator === "\n") lf++;
    else if (l.terminator === "\r\n") crlf++;
  }
  if (lf === 0 && crlf === 0) return "lf";
  if (crlf > lf) return "crlf";
  if (lf > crlf) return "lf";
  return "lf"; // tie -> lf
}

export function eolString(eol: Eol): "\n" | "\r\n" {
  return eol === "crlf" ? "\r\n" : "\n";
}

// Classify a file's line endings for the read header.
export function eolLabel(lines: readonly RawLine[]): Eol {
  let lf = 0;
  let crlf = 0;
  for (const l of lines) {
    if (l.terminator === "\n") lf++;
    else if (l.terminator === "\r\n") crlf++;
  }
  if (lf > 0 && crlf > 0) return "mixed";
  if (crlf > 0) return "crlf";
  return "lf";
}

// --- input text --------------------------------------------------------------

// Split caller-supplied text into logical lines. Separators are LF or CRLF; one
// terminal empty segment produced by a trailing separator is discarded, so "\n"
// is one blank line. A lone CR is refused.
export function parseNewText(text: string): string[] {
  if (/\r(?!\n)/.test(text)) {
    throw new Refusal("input text contains a lone CR — use LF or CRLF line endings.");
  }
  const parts = text.split(/\r\n|\n/);
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

// --- read_lines rendering ----------------------------------------------------

export interface ReadResult {
  text: string;
  fingerprint: string;
  lineCount: number;
}

// Decode a line's content for display, truncating past the display cap. The
// anchor hash already covers the FULL line, so a truncated line is still
// addressable.
function displayLine(content: Buffer): { text: string; truncated: boolean } {
  const text = content.toString("utf8");
  const chars = [...text];
  if (chars.length <= MAX_LINE_CHARS) return { text, truncated: false };
  return { text: chars.slice(0, MAX_LINE_CHARS).join(""), truncated: true };
}

// Render `raw` as a read_lines result. start/end are 1-based inclusive line
// numbers. At most MAX_LINES_PER_PAGE lines and MAX_OUTPUT_BYTES bytes; the
// header states when a page was cut.
export function renderReadLines(raw: Buffer, start?: number, end?: number): ReadResult {
  if (raw.includes(0)) {
    throw new Refusal("file contains a NUL byte — refusing to read a binary file.");
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Refusal("file is not valid UTF-8 — refusing to read a binary file.");
  }
  const { bom, lines } = parseFile(raw);
  const fp = fingerprintOf(raw);
  const eol = dominantEol(lines);
  const total = lines.length;
  const from = start === undefined ? 1 : start;
  const to = end === undefined ? total : end;
  if (from < 1 || (total > 0 && from > total)) {
    throw new Refusal(`read_lines start=${from} is out of range: the file has ${total} lines.`);
  }
  const boundedEnd = Math.max(from - 1, Math.min(to, total));
  const pageEnd = Math.min(boundedEnd, from - 1 + MAX_LINES_PER_PAGE);
  const cutByLines = boundedEnd > pageEnd;

  const header =
    `F#${fp} lines=${total} eol=${eol} bom=${bom ? "yes" : "no"}` +
    (from !== 1 || pageEnd !== total ? ` showing=${from}-${pageEnd}` : "");

  const bodyLines: string[] = [];
  let bytes = Buffer.byteLength(header, "utf8") + 1;
  let cutByBytes = false;
  for (let n = from; n <= pageEnd; n++) {
    const { text: t, truncated } = displayLine(lines[n - 1].content);
    const marker = truncated
      ? ` …[truncated, ${[...lines[n - 1].content.toString("utf8")].length} chars total]`
      : "";
    const rendered = `${anchorToken(n, lines[n - 1])} ${t}${marker}`;
    const cost = Buffer.byteLength(rendered, "utf8") + 1;
    if (bytes + cost > MAX_OUTPUT_BYTES) {
      cutByBytes = true;
      break;
    }
    bytes += cost;
    bodyLines.push(rendered);
  }

  const notes: string[] = [];
  if (cutByLines || cutByBytes) {
    const lastShown = from + bodyLines.length - 1;
    notes.push(
      `page cut at line ${lastShown} of ${total}; more lines need another read_lines(start=${lastShown + 1}).`,
    );
  }
  const out = [header, ...bodyLines, ...notes].join("\n");
  return { text: out, fingerprint: fp, lineCount: total };
}

// --- edit splices (pure) -----------------------------------------------------

export interface SpliceResult {
  raw: Buffer;
  // Original bytes in the affected span that were removed or replaced.
  removedBytes: number;
  writtenLineNumbers: number[];
  lineDelta: number;
}

function renderLines(newLines: readonly string[], sep: string, lastTerminated: boolean): Buffer {
  const parts: string[] = [];
  for (let i = 0; i < newLines.length; i++) {
    const last = i === newLines.length - 1;
    parts.push(newLines[i] + (last && !lastTerminated ? "" : sep));
  }
  return Buffer.from(parts.join(""), "utf8");
}

// The dominant separator for a file, computed on the ORIGINAL lines.
function sepFor(lines: readonly RawLine[]): string {
  return eolString(dominantEol(lines));
}

// True when the file ends with a line terminator.
function hasFinalNewline(lines: readonly RawLine[]): boolean {
  return lines.length > 0 && lines[lines.length - 1].terminator !== "";
}

// Replace lines from..to (1-based, inclusive) with newLines (already parsed).
export function applyEditLines(
  raw: Buffer,
  from: number,
  to: number,
  newLines: readonly string[],
): SpliceResult {
  const { bom, lines } = parseFile(raw);
  const before = bom ? BOM : Buffer.alloc(0);
  const body = bom ? raw.subarray(3) : raw;
  if (lines.length === 0) {
    throw new Refusal("edit_lines needs an existing non-empty file; the file has no lines.");
  }
  if (from < 1 || to < from || to > lines.length) {
    throw new Refusal(
      `edit_lines range ${from}..${to} is out of range: the file has ${lines.length} lines.`,
    );
  }
  for (let n = from; n <= to; n++) {
    if ([...lines[n - 1].content.toString("utf8")].length > MAX_LINE_CHARS) {
      throw new Refusal(
        `edit_lines refuses to touch line ${n}: it is longer than the ${MAX_LINE_CHARS}-character display cap, so the model never saw it in full. Re-read is not possible; split the line with another tool.`,
      );
    }
  }
  const sep = sepFor(lines);
  const finalNl = hasFinalNewline(lines);

  const prefixEnd = byteStart(body, lines, from);
  const suffixStart = byteEnd(body, lines, to);
  const span = body.subarray(prefixEnd, suffixStart).length;

  const tail = to === lines.length;
  let lastTerminated: boolean;
  if (newLines.length === 0) {
    lastTerminated = false; // deletion: rely on the suffix/prefix below
  } else if (tail) {
    lastTerminated = finalNl;
  } else {
    lastTerminated = true;
  }
  const mid = newLines.length === 0 ? Buffer.alloc(0) : renderLines(newLines, sep, lastTerminated);

  // When the range is the tail and the result is now shorter than the prefix's
  // last line, the prefix's own separator is the adjacent one and stays. The old
  // final-newline state is kept: if the file had no final newline, the prefix's
  // last line must lose its terminator too.
  let prefix = body.subarray(0, prefixEnd);
  if (newLines.length === 0 && tail && !finalNl && lines.length > 0) {
    const pl = lines[from - 1 - 1]; // the line before the deleted range
    if (from - 1 >= 1 && pl.terminator !== "") {
      prefix = body.subarray(0, byteStart(body, lines, from) - pl.terminator.length);
    }
  }
  const suffix = body.subarray(suffixStart);

  const next = Buffer.concat([before, prefix, mid, suffix]);
  return {
    raw: next,
    removedBytes: span,
    writtenLineNumbers: Array.from({ length: newLines.length }, (_, i) => from + i),
    lineDelta: newLines.length - (to - from + 1),
  };
}

// Insert after line `after` (0 means "before line 1", valid for any existing
// file including an empty one). Pure insertion: nothing is removed.
export function applyInsertAfter(
  raw: Buffer,
  after: number,
  newLines: readonly string[],
): SpliceResult {
  const { bom, lines } = parseFile(raw);
  const before = bom ? BOM : Buffer.alloc(0);
  const body = bom ? raw.subarray(3) : raw;
  if (after < 0 || after > lines.length) {
    throw new Refusal(
      `insert_after anchor line ${after} is out of range: the file has ${lines.length} lines.`,
    );
  }
  const sep = sepFor(lines);

  if (lines.length === 0) {
    // Only L0 makes sense on an empty file: the whole file becomes the text.
    if (after !== 0) throw new Refusal("insert_after on an empty file requires anchor L0.");
    const next = Buffer.concat([before, renderLines(newLines, sep, true)]);
    return { raw: next, removedBytes: 0, writtenLineNumbers: [1], lineDelta: newLines.length };
  }

  const atEof = after === lines.length;
  const finalNl = hasFinalNewline(lines);
  // The prefix runs through the anchor line's WHOLE bytes (terminator included)
  // when the anchor is a real line; L0's prefix is empty.
  let prefixEnd: number;
  let anchorTerminated = true;
  if (after === 0) {
    prefixEnd = 0;
  } else {
    anchorTerminated = lines[after - 1].terminator !== "";
    prefixEnd = byteStart(body, lines, after) + lines[after - 1].content.length;
    if (anchorTerminated) prefixEnd += lines[after - 1].terminator.length;
  }

  let lead = "";
  let lastTerm = sep;
  if (atEof && !anchorTerminated) {
    // Inserting after an unterminated final line: the adjacent separator belongs
    // to the affected span, and the old final-newline state (none) is kept.
    lead = sep;
    lastTerm = finalNl ? sep : "";
  } else if (atEof) {
    lastTerm = finalNl ? sep : "";
  }
  const mid = Buffer.from(
    lead + newLines.map((t, i) => t + (i === newLines.length - 1 ? lastTerm : sep)).join(""),
    "utf8",
  );
  const next = Buffer.concat([before, body.subarray(0, prefixEnd), mid, body.subarray(prefixEnd)]);
  return {
    raw: next,
    removedBytes: 0,
    writtenLineNumbers: Array.from({ length: newLines.length }, (_, i) => after + 1 + i),
    lineDelta: newLines.length,
  };
}

// Byte offset of the start of line `n` (1-based) within `body` (BOM stripped).
function byteStart(body: Buffer, lines: readonly RawLine[], n: number): number {
  let off = 0;
  for (let i = 0; i < n - 1; i++) off += lines[i].content.length + lines[i].terminator.length;
  return Math.min(off, body.length);
}

// Byte offset just past the end of line `n` (including its terminator).
function byteEnd(body: Buffer, lines: readonly RawLine[], n: number): number {
  if (n >= lines.length) return body.length;
  return byteStart(body, lines, n + 1);
}

// --- the session: path rules, critical section, tripwire ---------------------

export interface ToolOutput {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

interface Budget {
  size: number;
  limit: number;
  removed: number;
  tripped: boolean;
}

// Per-session state. One instance per pi session (the extension factory makes
// it), so "per run" in the spec means "per session".
export class AnchoredEditSession {
  // Fingerprint last seen for each canonical path (from read_lines/edit/write).
  private readonly readFingerprints = new Map<string, string>();
  private readonly budgets = new Map<string, Budget>();
  private readonly locks = new Map<string, Promise<void>>();

  // Run `fn` under the per-path critical section. The canonical path is the key.
  private runLocked<T>(key: string, fn: () => T): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    this.locks.set(
      key,
      prior.then(() => gate),
    );
    return prior.then(() => {
      try {
        return fn();
      } finally {
        release();
      }
    });
  }

  // --- path handling ---------------------------------------------------------

  // Resolve a caller path within `root`. Refuses absolute paths and any ".."
  // segment. Returns the canonical (realpath) target; `exists` says whether it
  // already exists. Containment is checked on the canonical target.
  resolveWithin(root: string, p: string): { abs: string; canonical: string; exists: boolean } {
    if (typeof p !== "string" || p.trim() === "") {
      throw new Refusal("a path is required.");
    }
    if (isAbsolute(p)) {
      throw new Refusal(`refusing absolute path "${p}": paths are relative to the workspace root.`);
    }
    const segs = p.split(/[\\/]/);
    if (segs.some((s) => s === "..")) {
      throw new Refusal(`refusing path "${p}": a ".." segment can escape the workspace root.`);
    }
    const realRoot = realpathSync(root);
    const abs = resolve(realRoot, p);
    const rel = relative(realRoot, abs);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Refusal(`refusing path "${p}": it resolves outside the workspace root.`);
    }
    let exists = false;
    let canonical: string;
    try {
      lstatSync(abs);
      exists = true;
    } catch {
      exists = false;
    }
    if (exists) {
      try {
        canonical = realpathSync(abs);
      } catch {
        // A dangling symlink: lstat sees an entry, realpath cannot resolve it.
        // It is OCCUPIED for creation, and its parent must be inside the root.
        const parentReal = realpathSync(dirname(abs));
        assertInside(realRoot, parentReal, p);
        canonical = join(parentReal, basename(abs));
      }
    } else {
      const parentReal = realpathSync(dirname(abs));
      assertInside(realRoot, parentReal, p);
      canonical = join(parentReal, basename(abs));
    }
    // Containment on the path used for I/O (the canonical target): a symlink
    // leading outside the root is refused.
    const crel = relative(realRoot, canonical);
    if (crel === ".." || crel.startsWith(`..${sep}`) || isAbsolute(crel)) {
      throw new Refusal(
        `refusing path "${p}": it resolves through a symlink to outside the workspace root.`,
      );
    }
    return { abs, canonical, exists };
  }

  private budgetFor(canonical: string, size: number): Budget {
    let b = this.budgets.get(canonical);
    if (!b) {
      // Half the file's size when first touched, no floor.
      b = { size, limit: Math.floor(size / 2), removed: 0, tripped: false };
      this.budgets.set(canonical, b);
    }
    return b;
  }

  private charge(bytes: number, canonical: string, displayPath: string, size: number): void {
    const b = this.budgetFor(canonical, size);
    if (b.tripped) {
      throw new Refusal(
        `refusing further edits to "${displayPath}": this run already removed or replaced ${b.removed} of the ${b.limit}-byte rewrite limit (half of ${b.size}). Report BLOCKED; the file cannot be rewritten safely in this run.`,
        ["budget_stop"],
      );
    }
    if (b.removed + bytes > b.limit) {
      b.tripped = true;
      throw new Refusal(
        `refusing to edit "${displayPath}": this call would remove or replace ${b.removed + bytes} bytes, over the ${b.limit}-byte rewrite limit (half of ${b.size}). Report BLOCKED; the file cannot be rewritten safely in this run.`,
        ["budget_stop"],
      );
    }
    b.removed += bytes;
  }

  // --- read_lines ------------------------------------------------------------

  readLines(root: string, path: string, start?: number, end?: number): ToolOutput {
    const { canonical } = this.resolveWithin(root, path);
    const raw = readFileSync(canonical);
    const res = renderReadLines(raw, start, end);
    this.readFingerprints.set(canonical, res.fingerprint);
    return {
      content: [{ type: "text", text: res.text }],
      details: { fingerprint: `F#${res.fingerprint}`, lineCount: res.lineCount, signals: [] },
    };
  }

  // --- edit_lines ------------------------------------------------------------

  editLines(
    root: string,
    path: string,
    from: number,
    to: number,
    newText: string,
    fingerprint: string,
  ): Promise<ToolOutput> {
    const { canonical } = this.resolveWithin(root, path);
    return this.runLocked(canonical, () => {
      const raw = readFileSync(canonical);
      const signals = this.checkFingerprint(canonical, path, fingerprint, raw);
      // Empty new_text deletes the range; only nonempty text is parsed into
      // logical lines (parseNewText("") is one blank line).
      const newLines = newText === "" ? [] : parseNewText(newText);
      const spliced = applyEditLines(raw, from, to, newLines);
      this.charge(spliced.removedBytes, canonical, path, raw.length);
      writeAtomic(canonical, spliced.raw);
      const fp = fingerprintOf(spliced.raw);
      this.readFingerprints.set(canonical, fp);
      return this.success(path, spliced.raw, fp, spliced, "edit_lines", signals);
    });
  }

  // --- insert_after ----------------------------------------------------------

  insertAfter(
    root: string,
    path: string,
    anchor: string,
    text: string,
    fingerprint: string,
  ): Promise<ToolOutput> {
    const { canonical } = this.resolveWithin(root, path);
    return this.runLocked(canonical, () => {
      const raw = readFileSync(canonical);
      const signals = this.checkFingerprint(canonical, path, fingerprint, raw);
      const after = this.matchAnchor(raw, anchor, path);
      if (text === "") throw new Refusal("insert_after refuses empty text.");
      const newLines = parseNewText(text);
      const spliced = applyInsertAfter(raw, after, newLines);
      this.charge(spliced.removedBytes, canonical, path, raw.length);
      writeAtomic(canonical, spliced.raw);
      const fp = fingerprintOf(spliced.raw);
      this.readFingerprints.set(canonical, fp);
      return this.success(path, spliced.raw, fp, spliced, "insert_after", signals);
    });
  }

  // --- write_file ------------------------------------------------------------

  writeFile(root: string, path: string, content: string): ToolOutput {
    const { canonical, exists } = this.resolveWithin(root, path);
    if (exists) {
      throw new Refusal(
        `refusing to create "${path}": a directory entry already exists there. write_file only creates new files.`,
      );
    }
    let fd: number;
    try {
      // O_CREAT|O_EXCL: a dangling symlink at the path counts as occupied, and
      // creation never follows a symlink.
      fd = openSync(canonical, "wx", 0o644);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new Refusal(
          `refusing to create "${path}": a directory entry already exists there (including a dangling symlink). write_file only creates new files.`,
        );
      }
      throw err;
    }
    let buf: Buffer;
    try {
      if (content.includes("\u0000"))
        throw new Refusal("write_file refuses a NUL byte in content.");
      buf = Buffer.from(content, "utf8");
      writeSync(fd, buf);
    } finally {
      closeSync(fd);
    }
    const fp = fingerprintOf(buf);
    this.readFingerprints.set(canonical, fp);
    return {
      content: [{ type: "text", text: `created ${path} (F#${fp}, ${buf.length} bytes)` }],
      details: { fingerprint: `F#${fp}`, bytes: buf.length, signals: [] },
    };
  }

  // --- helpers ---------------------------------------------------------------

  private checkFingerprint(
    canonical: string,
    path: string,
    claimed: string,
    raw: Buffer,
  ): string[] {
    const expected = normalizeFingerprint(claimed);
    const actual = fingerprintOf(raw);
    const signals: string[] = [];
    if (!this.readFingerprints.has(canonical)) signals.push("edit_without_read");
    if (expected !== actual) {
      signals.push("stale_anchor");
      throw new Refusal(
        `refusing to edit "${path}": stale fingerprint. Expected F#${expected}, file is F#${actual}. Re-read the file with read_lines and retry.`,
        signals,
      );
    }
    return signals;
  }

  // Return the line number an anchor addresses, or "L0" => 0. A missing or
  // mismatched anchor is refused with a bounded re-read window.
  private matchAnchor(raw: Buffer, anchor: string, _path: string): number {
    const trimmed = anchor.trim();
    if (trimmed === "L0") return 0;
    const m = /^L(\d+)#([0-9a-f]{8})$/.exec(trimmed);
    if (!m) throw new Refusal(`unrecognised anchor "${anchor}": expected L<n>#<8 hex> or L0.`);
    const n = Number(m[1]);
    const want = m[2];
    const { lines } = parseFile(raw);
    if (n < 1 || n > lines.length) {
      throw new Refusal(
        `anchor "${anchor}" points at line ${n}, but the file has ${lines.length} lines.\n${windowAround(raw, n)}`,
        ["stale_anchor"],
      );
    }
    const got = anchorToken(n, lines[n - 1]);
    if (anchorHashOf(lines[n - 1]) !== want) {
      const candidate = uniqueCandidate(lines, want, n);
      throw new Refusal(
        `stale anchor "${anchor}": line ${n} is now ${got}.${candidate}\n${windowAround(raw, n)}`,
        ["stale_anchor"],
      );
    }
    return n;
  }

  private success(
    path: string,
    raw: Buffer,
    fp: string,
    spliced: SpliceResult,
    tool: string,
    signals: string[],
  ): ToolOutput {
    const { lines } = parseFile(raw);
    const anchors = spliced.writtenLineNumbers
      .filter((n) => n >= 1 && n <= lines.length)
      .map((n) => anchorToken(n, lines[n - 1]));
    const delta = spliced.lineDelta >= 0 ? `+${spliced.lineDelta}` : `${spliced.lineDelta}`;
    const text = [
      `${tool} ok on ${path}`,
      `F#${fp} lines=${lines.length} (${delta})`,
      anchors.length > 0 ? `written: ${anchors.join(" ")}` : "",
      signals.length > 0 ? `signals: ${signals.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    return {
      content: [{ type: "text", text }],
      details: {
        fingerprint: `F#${fp}`,
        lineCount: lines.length,
        lineDelta: spliced.lineDelta,
        anchors,
        signals,
      },
    };
  }
}

function normalizeFingerprint(f: string): string {
  return f.trim().replace(/^F#/, "");
}

// Throw unless `target` is inside `root`.
function assertInside(root: string, target: string, p: string): void {
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Refusal(`refusing path "${p}": it resolves outside the workspace root.`);
  }
}

// A bounded re-read window around line n, for a stale-anchor refusal.
function windowAround(raw: Buffer, n: number): string {
  const { lines } = parseFile(raw);
  const radius = 10;
  const start = Math.max(1, n - radius);
  const end = Math.min(lines.length, n + radius);
  const out: string[] = [`window around line ${n}:`];
  for (let i = start; i <= end; i++) {
    out.push(`${anchorToken(i, lines[i - 1])} ${lines[i - 1].content.toString("utf8")}`);
  }
  return out.join("\n");
}

// A nearby line with the same hash as the expected one, labelled a candidate
// only when it is unique.
function uniqueCandidate(lines: readonly RawLine[], want: string, _at: number): string {
  const hits: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (anchorHashOf(lines[i]) === want) hits.push(i + 1);
  }
  if (hits.length === 1) return ` Candidate: line ${hits[0]} has that hash.`;
  return "";
}

// Write via a temp file + rename, so a reader never sees a half-written file.
function writeAtomic(target: string, data: Buffer): void {
  const tmp = `${target}.anchored-edit.tmp`;
  const fd = openSync(tmp, "w", 0o644);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, target);
}
