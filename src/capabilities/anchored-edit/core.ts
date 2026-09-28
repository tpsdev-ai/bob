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
// Documented GAPS live in README.md (the containment check is at RESOLUTION
// time — a directory swapped between that check and the I/O is an unguarded
// race, as is any cross-process change; bash is outside the guards; slice-2
// items) — read it before trusting this as a sandbox.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  fchmodSync,
  constants as fsc,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// A writer seam: node's writeSync may accept FEWER bytes than requested, so the
// session loops until the whole buffer is accepted. The seam exists so a test
// can force a short write without a real short-writing device.
export type WriteChunk = (fd: number, data: Buffer) => number;

const defaultWriteChunk: WriteChunk = (fd, data) => writeSync(fd, data);

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
export function parseNewText(text: string, path?: string): string[] {
  if (/\r(?!\n)/.test(text)) {
    const where = path === undefined ? "the input text" : `"${path}"`;
    throw new Refusal(
      `refusing the text for ${where}: rule: lone CR — it contains a lone CR; use LF or CRLF line endings.`,
    );
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
export function renderReadLines(
  raw: Buffer,
  start?: number,
  end?: number,
  path?: string,
): ReadResult {
  const label = path === undefined ? "the file" : `"${path}"`;
  if (raw.includes(0)) {
    throw new Refusal(
      `refusing to read ${label}: rule: binary file — it contains a NUL byte. read_lines refuses binary files.`,
    );
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new Refusal(
      `refusing to read ${label}: rule: binary file — it is not valid UTF-8. read_lines refuses binary files.`,
    );
  }
  const { bom, lines } = parseFile(raw);
  const fp = fingerprintOf(raw);
  const eol = dominantEol(lines);
  const total = lines.length;
  const from = start === undefined ? 1 : start;
  const to = end === undefined ? total : end;
  if (from < 1 || (total > 0 && from > total)) {
    throw new Refusal(
      `refusing to read ${label}: rule: out-of-range read — start=${from} is out of range; the file has ${total} lines.`,
    );
  }
  const boundedEnd = Math.max(from - 1, Math.min(to, total));
  const pageEnd = Math.min(boundedEnd, from - 1 + MAX_LINES_PER_PAGE);
  const cutByLines = boundedEnd > pageEnd;

  const header =
    `F#${fp} lines=${total} eol=${eol} bom=${bom ? "yes" : "no"}` +
    (from !== 1 || pageEnd !== total ? ` showing=${from}-${pageEnd}` : "");

  const bodyLines: string[] = [];
  let bytes = Buffer.byteLength(header, "utf8") + 1;
  // Reserve room for the cut note so it can never push the result over the cap.
  const budget = MAX_OUTPUT_BYTES - CUT_NOTE_RESERVE - 1;
  let cutByBytes = false;
  for (let n = from; n <= pageEnd; n++) {
    const { text: t, truncated } = displayLine(lines[n - 1].content);
    const marker = truncated
      ? ` …[truncated, ${[...lines[n - 1].content.toString("utf8")].length} chars total]`
      : "";
    const rendered = `${anchorToken(n, lines[n - 1])} ${t}${marker}`;
    const cost = Buffer.byteLength(rendered, "utf8") + 1;
    if (bytes + cost > budget) {
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
  const out = clampUtf8([header, ...bodyLines, ...notes].join("\n"), MAX_OUTPUT_BYTES);
  return { text: out, fingerprint: fp, lineCount: total };
}

// Space reserved for a cut note, so a body that fills the cap still leaves room
// for the note that says it was cut.
const CUT_NOTE_RESERVE = 300;

// Truncate `text` to at most `maxBytes` UTF-8 bytes WITHOUT splitting a
// character, appending a cut marker that is itself inside the cap. The single
// place any result is bounded by bytes.
export function clampUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "\n…[result cut]";
  const budget = Math.max(0, maxBytes - Buffer.byteLength(marker, "utf8"));
  let out = "";
  let used = 0;
  for (const ch of text) {
    const b = Buffer.byteLength(ch, "utf8");
    if (used + b > budget) break;
    out += ch;
    used += b;
  }
  return out + marker;
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

// A blank line can only exist at end-of-file when it is TERMINATED: a file that
// ends in a separator has no phantom final line, and an empty UNTERMINATED final
// line renders to nothing. Rendering one would silently drop the very line the
// caller asked for (a splice that reports a written line and lineDelta 0 while
// the bytes lost a line). Refuse the unrepresentable case instead.
function assertRepresentableFinalNewLine(
  newLines: readonly string[],
  lastTerminated: boolean,
  label: string,
): void {
  if (!lastTerminated && newLines.length > 0 && newLines[newLines.length - 1] === "") {
    throw new Refusal(
      `refusing to edit ${label}: rule: unrepresentable blank final line — the result would end with an empty final line in a file that keeps no final newline, so the line cannot be represented. Add a non-empty last line or a trailing newline.`,
    );
  }
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
  path?: string,
): SpliceResult {
  const label = path === undefined ? "the file" : `"${path}"`;
  const { bom, lines } = parseFile(raw);
  const before = bom ? BOM : Buffer.alloc(0);
  const body = bom ? raw.subarray(3) : raw;
  if (lines.length === 0) {
    throw new Refusal(
      `refusing to edit ${label}: rule: empty file — edit_lines needs an existing non-empty file; the file has no lines.`,
    );
  }
  if (from < 1 || to < from || to > lines.length) {
    throw new Refusal(
      `refusing to edit ${label}: rule: out-of-range — the range ${from}..${to} is out of range; the file has ${lines.length} lines.`,
    );
  }
  for (let n = from; n <= to; n++) {
    if ([...lines[n - 1].content.toString("utf8")].length > MAX_LINE_CHARS) {
      throw new Refusal(
        `refusing to edit ${label}: rule: overlong line — line ${n} is longer than the ${MAX_LINE_CHARS}-character display cap, so the model never saw it in full. Re-read is not possible; split the line with another tool.`,
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
  assertRepresentableFinalNewLine(newLines, lastTerminated, label);
  const mid = newLines.length === 0 ? Buffer.alloc(0) : renderLines(newLines, sep, lastTerminated);

  // When the range is the tail and the result is now shorter than the prefix's
  // last line, the prefix's own separator is the adjacent one and stays. The old
  // final-newline state is kept: if the file had no final newline, the prefix's
  // last line must lose its terminator too.
  let prefix = body.subarray(0, prefixEnd);
  let removedAdjacent = 0;
  if (newLines.length === 0 && tail && !finalNl && lines.length > 0) {
    const pl = lines[from - 1 - 1]; // the line before the deleted range
    if (from - 1 >= 1 && pl.terminator !== "") {
      prefix = body.subarray(0, byteStart(body, lines, from) - pl.terminator.length);
      // The adjacent separator was removed with the final line; charge it too.
      removedAdjacent = pl.terminator.length;
    }
  }
  const suffix = body.subarray(suffixStart);

  const next = Buffer.concat([before, prefix, mid, suffix]);
  return {
    raw: next,
    removedBytes: span + removedAdjacent,
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
  path?: string,
): SpliceResult {
  const label = path === undefined ? "the file" : `"${path}"`;
  const { bom, lines } = parseFile(raw);
  const before = bom ? BOM : Buffer.alloc(0);
  const body = bom ? raw.subarray(3) : raw;
  if (after < 0 || after > lines.length) {
    throw new Refusal(
      `refusing to insert into ${label}: rule: out-of-range — anchor line ${after} is out of range; the file has ${lines.length} lines.`,
    );
  }
  const sep = sepFor(lines);

  if (lines.length === 0) {
    // Only L0 makes sense on an empty file: the whole file becomes the text.
    if (after !== 0) {
      throw new Refusal(
        `refusing to insert into ${label}: rule: empty file — an empty file requires anchor L0.`,
      );
    }
    // An empty file has NO final newline; inserting keeps that state.
    assertRepresentableFinalNewLine(newLines, false, label);
    const next = Buffer.concat([before, renderLines(newLines, sep, false)]);
    return {
      raw: next,
      removedBytes: 0,
      writtenLineNumbers: Array.from({ length: newLines.length }, (_, i) => 1 + i),
      lineDelta: newLines.length,
    };
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
  assertRepresentableFinalNewLine(newLines, lastTerm !== "", label);
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

// A caller path resolved within the PINNED root. `canonical` is the realpath
// resolved (and checked inside the root) at call time and used for I/O;
// `parentReal` is the realpath of its directory, re-checked before path-based
// opens and the rename.
interface ResolvedTarget {
  root: string;
  canonical: string;
  parentReal: string;
  base: string;
  exists: boolean;
}

// Bound on the anchors echoed in a mutation result, so a huge insertion cannot
// return an unbounded structured list.
const ANCHOR_ECHO_LIMIT = 64;

// Per-session state. One instance per pi session (the extension factory makes
// it), so "per run" in the spec means "per session".
export class AnchoredEditSession {
  // Fingerprint last seen for each canonical path (from read_lines/edit/write).
  private readonly readFingerprints = new Map<string, string>();
  private readonly budgets = new Map<string, Budget>();
  private readonly locks = new Map<string, Promise<void>>();
  // The trusted canonical root, pinned ONCE per session from pi's first tool
  // execution context. A later replacement of the root path (a swapped symlink,
  // a recreated directory) does NOT redefine it.
  private pinnedRoot: string | null = null;
  // A byte-accepting writer seam (a test forces short writes); the default is
  // node's writeSync, looped by writeAllBytes until every byte is accepted.
  private readonly writeChunk: WriteChunk;

  constructor(writeChunk: WriteChunk = defaultWriteChunk) {
    this.writeChunk = writeChunk;
  }

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

  // Resolve a caller path within the PINNED trusted root. Refuses absolute
  // paths and any ".." segment. Returns the verified canonical target (for I/O)
  // and its canonical parent directory.
  resolveWithin(rootArg: string, p: string): ResolvedTarget {
    if (typeof p !== "string" || p.trim() === "") {
      throw new Refusal("refusing a request with no path: a path is required.");
    }
    if (isAbsolute(p)) {
      throw new Refusal(
        `refusing absolute path "${p}": paths must be relative to the workspace root.`,
      );
    }
    const segs = p.split(/[\\/]/);
    if (segs.some((s) => s === "..")) {
      throw new Refusal(`refusing path "${p}": a ".." segment can escape the workspace root.`);
    }
    let realRoot: string;
    try {
      if (this.pinnedRoot === null) this.pinnedRoot = realpathSync(rootArg);
      // Re-resolve the PINNED root each call, so a root that disappeared is
      // refused rather than silently redefined to whatever now sits at its path.
      realRoot = realpathSync(this.pinnedRoot);
      if (realRoot !== this.pinnedRoot) {
        throw new Refusal(`refusing path "${p}": the workspace root was replaced.`);
      }
    } catch (e) {
      if (e instanceof Refusal) throw e;
      throw new Refusal(`refusing path "${p}": the workspace root is not readable.`);
    }
    const abs = resolve(realRoot, p);
    assertInside(realRoot, abs, p);
    let exists = false;
    try {
      lstatSync(abs);
      exists = true;
    } catch {
      exists = false;
    }
    let canonical: string;
    let parentReal: string;
    if (exists) {
      try {
        canonical = realpathSync(abs);
        parentReal = realpathSync(dirname(abs));
      } catch {
        // A dangling symlink: lstat sees an entry, realpath cannot resolve it.
        // It is OCCUPIED for creation, and its parent must be inside the root.
        parentReal = realpathSync(dirname(abs));
        assertInside(realRoot, parentReal, p);
        canonical = join(parentReal, basename(abs));
      }
    } else {
      parentReal = realpathSync(dirname(abs));
      assertInside(realRoot, parentReal, p);
      canonical = join(parentReal, basename(abs));
    }
    assertInside(realRoot, canonical, p);
    return { root: realRoot, canonical, parentReal, base: basename(canonical), exists };
  }

  // Re-check, before path-based opens and the rename, that the parent directory
  // still resolves to the same canonical pathname inside the pinned root. A
  // replacement that resolves elsewhere is caught here; one replaced by another
  // directory at the SAME pathname is not (documented gap). The check and the I/O are separate
  // syscalls: a directory swapped by another process BETWEEN them is not
  // guarded — the same class as the cross-process race in the README's
  // documented gaps.
  private verifyParent(t: ResolvedTarget, p: string): void {
    let now: string;
    try {
      now = realpathSync(t.parentReal);
    } catch {
      throw new Refusal(`refusing path "${p}": the parent directory disappeared.`);
    }
    if (now !== t.parentReal) {
      throw new Refusal(
        `refusing path "${p}": the parent directory was replaced since it was resolved.`,
      );
    }
    assertInside(t.root, now, p);
  }

  // Read the verified target through a file descriptor opened without following
  // a symlink and confirmed to be a regular file.
  private readVerified(t: ResolvedTarget, p: string): Buffer {
    this.verifyParent(t, p);
    let fd: number;
    try {
      fd = openSync(t.canonical, fsc.O_RDONLY | fsc.O_NOFOLLOW);
    } catch {
      throw new Refusal(
        `refusing to read "${p}": it is not a regular file inside the workspace root.`,
      );
    }
    try {
      if (!fstatSync(fd).isFile()) {
        throw new Refusal(`refusing to read "${p}": it is not a regular file.`);
      }
      const chunks: Buffer[] = [];
      const buf = Buffer.alloc(65536);
      let read = 0;
      for (;;) {
        const n = readSync(fd, buf, 0, buf.length, read);
        if (n <= 0) break;
        chunks.push(Buffer.from(buf.subarray(0, n)));
        read += n;
      }
      return Buffer.concat(chunks);
    } finally {
      closeSync(fd);
    }
  }

  // Write every byte to fd, looping because writeSync may accept a SHORT count.
  // A writer that accepts nothing (or fails) is an incomplete write, which the
  // caller cleans up.
  private writeAllBytes(fd: number, data: Buffer): void {
    let off = 0;
    while (off < data.length) {
      const n = this.writeChunk(fd, data.subarray(off));
      if (n <= 0) throw new Error("incomplete write: the writer accepted no bytes");
      off += n;
    }
  }

  // Write the verified target: a temp created EXCLUSIVELY (no symlink follow)
  // in the same directory, written until every byte is accepted, then renamed
  // over the target. Every step re-checks the parent; a swap between a check
  // and its I/O is the documented, unguarded race.
  private writeVerified(t: ResolvedTarget, p: string, data: Buffer): void {
    this.verifyParent(t, p);
    const tmp = join(
      t.parentReal,
      `.${t.base}.anchored-edit.${randomBytes(6).toString("hex")}.tmp`,
    );
    let fd: number;
    try {
      fd = openSync(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o600);
    } catch {
      throw new Refusal(
        `refusing to edit "${p}": could not create a working file in its directory.`,
      );
    }
    try {
      this.writeAllBytes(fd, data);
    } catch {
      closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      throw new Refusal(`refusing to edit "${p}": the write failed and was cleaned up.`);
    }
    // Keep the target's permission bits: the temp was created 0600, and the rename would
    // otherwise replace the file's mode (an executable would lose its exec bit).
    try {
      fchmodSync(fd, lstatSync(t.canonical).mode & 0o7777);
    } catch {
      closeSync(fd);
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      throw new Refusal(`refusing to edit "${p}": could not keep the file's permissions.`);
    }
    closeSync(fd);
    this.verifyParent(t, p);
    renameSync(tmp, t.canonical);
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

  readLines(rootArg: string, path: string, start?: number, end?: number): ToolOutput {
    const t = this.resolveWithin(rootArg, path);
    const raw = this.readVerified(t, path);
    const res = renderReadLines(raw, start, end, path);
    this.readFingerprints.set(t.canonical, res.fingerprint);
    return {
      content: [{ type: "text", text: res.text }],
      details: { fingerprint: `F#${res.fingerprint}`, lineCount: res.lineCount, signals: [] },
    };
  }

  // --- edit_lines ------------------------------------------------------------

  editLines(
    rootArg: string,
    path: string,
    fromAnchor: string,
    toAnchor: string,
    newText: string,
    fingerprint: string,
  ): Promise<ToolOutput> {
    const t = this.resolveWithin(rootArg, path);
    return this.runLocked(t.canonical, () => {
      // A tripped budget answers FIRST for every later mutation of this file —
      // inside the lock, before the file is read or the inputs validated.
      this.assertNotTripped(t.canonical, path);
      const raw = this.readVerified(t, path);
      const signals: string[] = [];
      if (!this.readFingerprints.has(t.canonical)) signals.push("edit_without_read");
      // Validate BOTH range anchors, then the fingerprint — all inside the lock.
      const from = this.resolveAnchor(raw, fromAnchor, path, "from");
      const to = this.resolveAnchor(raw, toAnchor, path, "to");
      if (from > to) {
        throw new Refusal(
          `refusing to edit "${path}": the from anchor is line ${from} and the to anchor is line ${to}; from must not be after to.`,
        );
      }
      this.requireFingerprint(t.canonical, path, fingerprint, fromAnchor, raw, from, signals);
      const newLines = newText === "" ? [] : parseNewText(newText, path);
      const spliced = applyEditLines(raw, from, to, newLines, path);
      this.charge(spliced.removedBytes, t.canonical, path, raw.length);
      this.writeVerified(t, path, spliced.raw);
      const fp = fingerprintOf(spliced.raw);
      this.readFingerprints.set(t.canonical, fp);
      return this.success(path, spliced.raw, fp, spliced, "edit_lines", signals);
    });
  }

  // --- insert_after ----------------------------------------------------------

  insertAfter(
    rootArg: string,
    path: string,
    anchor: string,
    text: string,
    fingerprint: string,
  ): Promise<ToolOutput> {
    const t = this.resolveWithin(rootArg, path);
    return this.runLocked(t.canonical, () => {
      // A tripped budget answers FIRST for every later mutation of this file —
      // inside the lock, before the file is read or the inputs validated.
      this.assertNotTripped(t.canonical, path);
      const raw = this.readVerified(t, path);
      const signals: string[] = [];
      if (!this.readFingerprints.has(t.canonical)) signals.push("edit_without_read");
      const after = this.resolveAnchor(raw, anchor, path, "insert", true);
      if (text === "") {
        throw new Refusal(
          `refusing insert_after on "${path}": the text is empty and insert_after refuses empty text.`,
        );
      }
      this.requireFingerprint(
        t.canonical,
        path,
        fingerprint,
        anchor,
        raw,
        Math.max(1, after),
        signals,
      );
      const newLines = parseNewText(text, path);
      const spliced = applyInsertAfter(raw, after, newLines, path);
      this.charge(spliced.removedBytes, t.canonical, path, raw.length);
      this.writeVerified(t, path, spliced.raw);
      const fp = fingerprintOf(spliced.raw);
      this.readFingerprints.set(t.canonical, fp);
      return this.success(path, spliced.raw, fp, spliced, "insert_after", signals);
    });
  }

  // --- write_file ------------------------------------------------------------

  writeFile(rootArg: string, path: string, content: string): ToolOutput {
    const t = this.resolveWithin(rootArg, path);
    // Validate the creation content BEFORE opening, so a refused creation never
    // leaves an occupied empty file behind.
    if (content.includes("\u0000")) {
      throw new Refusal(
        `refusing to create "${path}": the content contains a NUL byte, and write_file refuses binary content.`,
      );
    }
    if (t.exists) {
      throw new Refusal(
        `refusing to create "${path}": a directory entry already exists there. write_file only creates new files.`,
      );
    }
    const buf = Buffer.from(content, "utf8");
    this.verifyParent(t, path);
    let fd: number;
    try {
      // O_CREAT|O_EXCL|O_NOFOLLOW: exclusive, and a dangling symlink counts as
      // occupied (creation never follows a symlink).
      fd = openSync(t.canonical, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | fsc.O_NOFOLLOW, 0o644);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        throw new Refusal(
          `refusing to create "${path}": a directory entry already exists there (including a dangling symlink). write_file only creates new files.`,
        );
      }
      throw new Refusal(
        `refusing to create "${path}": the file could not be created in its directory.`,
      );
    }
    let ok = false;
    try {
      this.writeAllBytes(fd, buf);
      ok = true;
    } catch {
      // An incomplete write: fall through, the finally block cleans it up.
    } finally {
      closeSync(fd);
      if (!ok) {
        // Clean up a failed write: never leave a half-made file as occupied.
        try {
          unlinkSync(t.canonical);
        } catch {
          /* best effort */
        }
      }
    }
    if (!ok) {
      throw new Refusal(
        `refusing to create "${path}": the write was incomplete and was cleaned up.`,
      );
    }
    const fp = fingerprintOf(buf);
    this.readFingerprints.set(t.canonical, fp);
    return {
      content: [{ type: "text", text: `created ${path} (F#${fp}, ${buf.length} bytes)` }],
      details: { fingerprint: `F#${fp}`, bytes: buf.length, signals: [] },
    };
  }

  // --- helpers ---------------------------------------------------------------

  // A tripped budget answers FIRST for every later mutation of the file.
  private assertNotTripped(canonical: string, displayPath: string): void {
    const b = this.budgets.get(canonical);
    if (b?.tripped) {
      throw new Refusal(
        `refusing further edits to "${displayPath}": this run already reached the rewrite limit (removed or replaced ${b.removed} of ${b.limit} bytes, half of ${b.size}). Report BLOCKED; the file cannot be rewritten safely in this run.`,
        ["budget_stop"],
      );
    }
  }

  // Require the current fingerprint. A mismatch is a stale refusal carrying the
  // caller's expected token, the observed token, a bounded window and a unique
  // candidate.
  private requireFingerprint(
    _canonical: string,
    path: string,
    claimed: string,
    expectedToken: string,
    raw: Buffer,
    atLine: number,
    signals: string[],
  ): void {
    const expected = normalizeFingerprint(claimed);
    const actual = fingerprintOf(raw);
    if (expected === actual) return;
    const { lines } = parseFile(raw);
    const n = Math.min(Math.max(1, atLine), Math.max(1, lines.length));
    const observed =
      lines.length > 0 && n >= 1 && n <= lines.length
        ? anchorToken(n, lines[n - 1])
        : "line absent";
    throw new Refusal(
      `refusing to edit "${path}": stale fingerprint (expected F#${expected}, file is F#${actual}). Expected anchor ${expectedToken.trim()}, observed ${observed}.\n${windowAround(raw, n)}`,
      ["stale_anchor", ...signals],
    );
  }

  // Resolve an anchor token to its line number (0 for `L0` when the caller
  // allows it). A missing or mismatched anchor is refused with the expected
  // token, the observed token (or "line absent"), a bounded window and a unique
  // candidate.
  private resolveAnchor(
    raw: Buffer,
    anchor: string,
    path: string,
    which: string,
    allowL0 = false,
  ): number {
    const trimmed = String(anchor).trim();
    if (trimmed === "L0") {
      if (allowL0) return 0;
      throw new Refusal(
        `refusing the ${which} anchor "${anchor}" in "${path}": L0 addresses the position before line 1 and is only valid for insert_after.`,
        ["stale_anchor"],
      );
    }
    const m = /^L(\d+)#([0-9a-f]{8})$/.exec(trimmed);
    if (!m) {
      throw new Refusal(
        `refusing the ${which} anchor "${anchor}" in "${path}": expected L<n>#<8 hex> (a token from read_lines).`,
        ["stale_anchor"],
      );
    }
    const n = Number(m[1]);
    const want = m[2];
    const { lines } = parseFile(raw);
    if (n < 1 || n > lines.length) {
      throw new Refusal(
        `refusing the ${which} anchor "${anchor}" in "${path}": line ${n} is absent (the file has ${lines.length} lines).\n${windowAround(raw, n)}`,
        ["stale_anchor"],
      );
    }
    const got = anchorToken(n, lines[n - 1]);
    if (anchorHashOf(lines[n - 1]) !== want) {
      const candidate = uniqueCandidate(lines, want, n);
      throw new Refusal(
        `refusing the ${which} anchor "${anchor}" in "${path}": stale. Expected ${trimmed}, observed ${got}.${candidate}\n${windowAround(raw, n)}`,
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
    const all = spliced.writtenLineNumbers
      .filter((n) => n >= 1 && n <= lines.length)
      .map((n) => anchorToken(n, lines[n - 1]));
    const anchors = all.slice(0, ANCHOR_ECHO_LIMIT);
    const omitted = all.length - anchors.length;
    const delta = spliced.lineDelta >= 0 ? `+${spliced.lineDelta}` : `${spliced.lineDelta}`;
    const written =
      anchors.length === 0
        ? ""
        : omitted > 0
          ? `written: ${anchors.join(" ")} …(+${omitted} more; read_lines to re-anchor them)`
          : `written: ${anchors.join(" ")}`;
    const text = [
      `${tool} ok on ${path}`,
      `F#${fp} lines=${lines.length} (${delta})`,
      written,
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
        anchorsOmitted: omitted,
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
