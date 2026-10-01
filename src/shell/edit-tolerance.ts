// edit-tolerance.ts — bob#143 item 1, the matching half, pure and testable.
//
// A local model often reproduces the WORDS of an `edit` region but not the
// whitespace: aligned bullet lists and aligned `=` runs collapse to one space in
// the model's oldText. pi's edit already retries with trailing whitespace
// stripped and Unicode punctuation folded, but it does not fold runs of
// spaces/tabs MID-line, so the exact-match failure stands.
//
// This module answers one question for the edit wrapper: given the file's
// content and the model's edits, what EXACT substring of the file does each
// oldText mean? Positions are counted with overlapping occurrences included.
// The exact pass runs first: an oldText at one exact position is selected by
// the matcher (pi may still refuse it), and one at more than one exact position
// fails, naming that count. Only when it occurs nowhere exactly does the
// whitespace-run-normalised pass run (runs of
// spaces/tabs → one space, trailing whitespace dropped): it accepts only one
// normalised position and otherwise fails, naming the count.
//
// The returned edits carry the file's exact substring as `oldText`, so the
// wrapper can hand them to pi's own edit tool and reuse its path resolution,
// write queue and diff — bob does not re-implement any of that.

export interface EditRequest {
  oldText: string;
  newText: string;
}

export interface LocatedEdit extends EditRequest {
  /** Index of this edit in the caller's edits array. */
  editIndex: number;
  /** Offset of the exact file substring in the original content. */
  index: number;
  /** Length of that substring. */
  length: number;
  /** Which pass matched it. */
  kind: "exact" | "whitespace";
}

/**
 * A match that failed. For duplicate and not-found errors, `count` is the
 * number of positions the oldText occurs at (overlaps included): exact for an
 * exact duplicate, normalised when there is no exact match. Empty oldText and
 * overlapping edits also carry 0, although their messages do not name a count.
 */
export class EditMatchError extends Error {
  readonly count: number;
  constructor(message: string, count: number) {
    super(message);
    this.name = "EditMatchError";
    this.count = count;
  }
}

interface Canonical {
  canon: string;
  /** canon[i]'s first source offset in the original text. */
  start: number[];
  /** canon[i]'s last source offset + 1 in the original text. */
  end: number[];
}

const isBlank = (ch: string): boolean => ch === " " || ch === "\t";

/**
 * Canonicalise a text for the tolerant pass: every run of spaces/tabs becomes a
 * single space, a run that reaches the end of its line is dropped, and all
 * other characters are kept. `start`/`end` map each canonical character back to
 * the original span it replaced, so a canonical match can be widened back to
 * the exact original substring.
 */
export function canonicalizeWhitespaceRuns(text: string): Canonical {
  const canon: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i];
    if (isBlank(ch)) {
      let j = i;
      while (j < n && isBlank(text[j])) j++;
      // A run followed by a newline (or EOF) is trailing whitespace: drop it.
      if (j >= n || text[j] === "\n") {
        i = j;
        continue;
      }
      canon.push(" ");
      start.push(i);
      end.push(j);
      i = j;
      continue;
    }
    canon.push(ch);
    start.push(i);
    end.push(i + 1);
    i++;
  }
  return { canon: canon.join(""), start, end };
}

/** The number of positions `needle` occurs at in `haystack`, overlapping occurrences included. */
export function countExactOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let i = 0;
  for (;;) {
    const at = haystack.indexOf(needle, i);
    if (at === -1) break;
    count++;
    i = at + 1;
  }
  return count;
}

/**
 * The number of positions the canonical oldText occurs at in the canonical
 * content, overlapping occurrences included, and the first of them.
 */
export function canonicalOccurrence(
  canonical: Canonical,
  oldText: string,
): { count: number; index: number } {
  const needle = canonicalizeWhitespaceRuns(oldText).canon;
  if (needle.length === 0) return { count: 0, index: -1 };
  let count = 0;
  let first = -1;
  let i = 0;
  for (;;) {
    const at = canonical.canon.indexOf(needle, i);
    if (at === -1) break;
    count++;
    if (first === -1) first = at;
    i = at + 1;
  }
  return { count, index: first };
}

function describe(path: string, index: number, total: number): string {
  return total === 1 ? `the text in ${path}` : `edits[${index}] in ${path}`;
}

function notFoundMessage(path: string, index: number, total: number): string {
  return `Could not find ${describe(path, index, total)}, even after normalising runs of spaces/tabs and ignoring trailing whitespace (0 matches). The old text must occur at one exact position or, with no exact occurrence, at one position under that normalisation.`;
}

function exactDuplicateMessage(path: string, index: number, total: number, count: number): string {
  const subject = total === 1 ? "oldText" : `edits[${index}].oldText`;
  return `${subject} matches ${count} places exactly in ${path} (overlapping occurrences included). It must match at one place only; add surrounding context.`;
}

function duplicateMessage(path: string, index: number, total: number, count: number): string {
  return `Found ${count} occurrences of ${describe(path, index, total)} after normalising runs of spaces/tabs and ignoring trailing whitespace (overlapping occurrences included). It must match at one place only; add surrounding context.`;
}

function emptyMessage(path: string, index: number, total: number): string {
  return total === 1
    ? `oldText must not be empty in ${path}.`
    : `edits[${index}].oldText must not be empty in ${path}.`;
}

/**
 * Resolve every edit's oldText to an exact file substring, exact pass first.
 * Throws {@link EditMatchError} on an empty oldText, duplicate exact or
 * normalised positions, no match, or overlapping edits. Duplicate and
 * not-found errors name their position count (overlaps included).
 */
export function locateTolerantEdits(
  content: string,
  edits: ReadonlyArray<EditRequest>,
  path: string,
): { edits: LocatedEdit[]; normalizedCount: number } {
  const canonical = canonicalizeWhitespaceRuns(content);
  const located: LocatedEdit[] = [];
  let normalizedCount = 0;

  for (let index = 0; index < edits.length; index++) {
    const { oldText, newText } = edits[index];
    if (oldText.length === 0) {
      throw new EditMatchError(emptyMessage(path, index, edits.length), 0);
    }
    const exactCount = countExactOccurrences(content, oldText);
    if (exactCount === 1) {
      const at = content.indexOf(oldText);
      located.push({
        editIndex: index,
        oldText,
        newText,
        index: at,
        length: oldText.length,
        kind: "exact",
      });
      continue;
    }
    if (exactCount > 1) {
      throw new EditMatchError(
        exactDuplicateMessage(path, index, edits.length, exactCount),
        exactCount,
      );
    }
    const { count, index: at } = canonicalOccurrence(canonical, oldText);
    if (count !== 1) {
      throw count === 0
        ? new EditMatchError(notFoundMessage(path, index, edits.length), 0)
        : new EditMatchError(duplicateMessage(path, index, edits.length, count), count);
    }
    const needleLen = canonicalizeWhitespaceRuns(oldText).canon.length;
    const start = canonical.start[at];
    const end = canonical.end[at + needleLen - 1];
    located.push({
      editIndex: index,
      oldText: content.slice(start, end),
      newText,
      index: start,
      length: end - start,
      kind: "whitespace",
    });
    normalizedCount++;
  }

  const sorted = [...located].sort((a, b) => a.index - b.index);
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1];
    const current = sorted[i];
    if (previous.index + previous.length > current.index) {
      throw new EditMatchError(
        `edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
        0,
      );
    }
  }

  return { edits: located, normalizedCount };
}

/**
 * pi's edit matches against the file with a leading BOM removed and CRLF/CR
 * turned into LF, and its own count skips overlapping occurrences. The wrapper
 * calls this on the content pi has just read, before pi matches. More than one
 * exact position is refused first. With no exact position, more than one
 * whitespace-run-normalised position is refused before pi's fuzzy pass can
 * choose one. Both counts include overlapping occurrences.
 */
export function refuseAmbiguousOldTextBeforePiMatch(
  content: string,
  edits: unknown,
  path: string,
): void {
  if (!Array.isArray(edits)) return;
  const text = toLF(content.startsWith("\uFEFF") ? content.slice(1) : content);
  let canonical: Canonical | undefined;
  for (let index = 0; index < edits.length; index++) {
    const oldText = (edits[index] as { oldText?: unknown } | undefined)?.oldText;
    if (typeof oldText !== "string") continue;
    const normalizedOldText = toLF(oldText);
    const count = countExactOccurrences(text, normalizedOldText);
    if (count > 1) {
      throw new EditMatchError(exactDuplicateMessage(path, index, edits.length, count), count);
    }
    if (count === 0) {
      canonical ??= canonicalizeWhitespaceRuns(text);
      const normalisedCount = canonicalOccurrence(canonical, normalizedOldText).count;
      if (normalisedCount > 1) {
        throw new EditMatchError(
          duplicateMessage(path, index, edits.length, normalisedCount),
          normalisedCount,
        );
      }
    }
  }
}

function toLF(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
