// reachy/echo.ts — the ECHO GUARD (bob#356 V2a, gate 5 / design §9).
//
// A sidecar that transcribes the room could transcribe what its speaker plays.
// The shipped sidecar sends no transcripts (V2b adds that producer); V2a's
// transcripts come from tests. bob keeps a text heuristic as a backstop:
//
//   * PLAYBACK INTERLOCK: a transcript that arrives during bob's ESTIMATED
//     playback window is dropped. The window is estimated from the line's text
//     (`estimatedPlaybackMs`, capped at 15 s), never asserted by the sidecar;
//     bob observes no actual playback completion.
//   * SAY-MATCH: a transcript whose text closely matches a line recorded for
//     an attempted `say` (recorded BEFORE the send, which can fail) is dropped
//     for `windowMs` after that line's ESTIMATED playback end.
//     If a device takes longer to play a line than its estimate, a transcript
//     of it can arrive after the window has ended; the estimate, not the
//     device, sets the bound.
//     Normalization is NFKC, lowercase, punctuation and whitespace folded to
//     single spaces. A line matches when its edit distance is within a fixed
//     length-based allowance, `floor((1 - 0.9) * length + 1e-9)` edits, where
//     length is the longer of the two normalized lines. An empty transcript
//     never matches: there is no text to compare.
//
// This heuristic does not certify AEC. Under the `voice` profile it is a
// deterministic drop, applied before a transcript is retained or submitted for
// admission, and it is deliberately conservative: genuine barge-in during the
// estimated playback is dropped too.

/** How long recorded text stays in the say-match guard. */
export const ECHO_WINDOW_MS = 10_000;
/** Similarity at or above which a transcript counts as a recorded line. */
export const ECHO_SIMILARITY = 0.9;

/** NFKC + lowercase, punctuation folded to spaces, whitespace collapsed. */
export function normalizeSpeech(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = new Array<number>(b.length + 1);
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}

export function editDistance(a: string, b: string): number {
  return levenshtein(a, b);
}

/** 1 for identical strings (two empty strings included); 0 when the length gap
 *  alone exceeds `editAllowance` of the longer length, because no such pair can
 *  match (the walk is skipped); otherwise `1 - distance / max`. */
export function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  // A length gap larger than the edit allowance cannot match: skip the walk.
  if (Math.abs(a.length - b.length) > editAllowance(max)) return 0;
  return 1 - levenshtein(a, b) / max;
}

/**
 * The fixed number of edits a normalized line may contain and still count as
 * a recorded line: `floor((1 - ECHO_SIMILARITY) * length)`.
 *
 * The epsilon keeps the exact boundary in float64: `1 - 0.9` is
 * 0.09999999999999998, so for a 10-character line the product is
 * 0.9999999999999998 and a plain floor would allow ZERO edits, rejecting a
 * transcript one edit away — exactly similarity 0.9, which must match.
 */
export function editAllowance(length: number, threshold: number = ECHO_SIMILARITY): number {
  return Math.floor((1 - threshold) * length + 1e-9);
}

/** The bounded window a recorded line is estimated to play for. */
export function estimatedPlaybackMs(text: string): number {
  return Math.min(15_000, Math.max(1_000, 600 + 60 * text.length));
}

interface Spoken {
  normalized: string;
  atMs: number;
  playbackUntilMs: number;
}

export type EchoReason = "playback" | "say-match";

/** The guard's state. One instance per capability; the capability clears it on
 *  every link change (a refused link, a disconnect, a new connection, a device
 *  mute flip), so records never cross a connection. */
export class EchoGuard {
  private readonly spoken: Spoken[] = [];

  constructor(
    private readonly windowMs: number = ECHO_WINDOW_MS,
    private readonly playbackMs: (text: string) => number = estimatedPlaybackMs,
  ) {}

  /** Record the text of an attempted say or ask, before it is sent (the send
   *  can still fail; the record stands either way). */
  record(text: string, nowMs: number): void {
    this.spoken.push({
      normalized: normalizeSpeech(text),
      atMs: nowMs,
      playbackUntilMs: nowMs + this.playbackMs(text),
    });
    // Drop expired lines from the front (oldest first) on each record. This is
    // a time bound, not a count cap: lines recorded within one window all stay,
    // and an expired line behind an unexpired older one stays until that one
    // expires and a later record prunes both.
    this.prune(nowMs);
  }

  /** Playback interlock: some recorded text is still inside its estimated
   *  playback window. */
  playbackActive(nowMs: number): boolean {
    return this.spoken.some((s) => nowMs < s.playbackUntilMs);
  }

  /** Say-match: the transcript matches text recorded for an attempted say. The window
   *  starts at that line's ESTIMATED playback end (`playbackMs`), so a long line
   *  keeps its window for as long as its estimated playback lasts. */
  matchesRecentSay(text: string, nowMs: number): boolean {
    const normalized = normalizeSpeech(text);
    if (normalized.length === 0) return false;
    return this.spoken.some((s) => {
      if (s.normalized.length === 0) return false;
      if (nowMs > s.playbackUntilMs + this.windowMs) return false;
      return (
        editDistance(normalized, s.normalized) <=
        editAllowance(Math.max(normalized.length, s.normalized.length))
      );
    });
  }

  /** The drop reason for a transcript that matches the guard, or null. */
  check(text: string, nowMs: number): EchoReason | null {
    if (this.playbackActive(nowMs)) return "playback";
    if (this.matchesRecentSay(text, nowMs)) return "say-match";
    return null;
  }

  /** Forget every recorded line (mute flip, disconnect, new connection). */
  clear(): void {
    this.spoken.length = 0;
  }

  private prune(nowMs: number): void {
    while (this.spoken.length > 0) {
      const oldest = this.spoken[0];
      if (oldest === undefined || nowMs <= oldest.playbackUntilMs + this.windowMs) return;
      this.spoken.shift();
    }
  }
}
