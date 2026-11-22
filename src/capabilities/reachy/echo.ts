// reachy/echo.ts — the ECHO GUARD (bob#356 V2a, gate 5 / design §9).
//
// The sidecar's microphone can hear bob's own speaker. Hardware echo
// cancellation is required on the device, but bob cannot verify a device
// property, so it keeps its own backstop:
//
//   * PLAYBACK INTERLOCK: a transcript that arrives during bob's playback
//     window is dropped. The window is estimated from the spoken text (a bound,
//     never a sidecar assertion).
//   * SAY-MATCH: a transcript whose text closely matches something bob said
//     within the last `windowMs` (measured from the end of its PLAYBACK, so a
//     long line's window cannot expire while it is still being spoken) is
//     dropped. Normalization is NFKC, lowercase, punctuation and whitespace
//     folded to single spaces. A line matches when its edit distance is within
//     a fixed length-based allowance: `floor((1 - 0.9) * max(length))` edits.
//     Two empty strings compare equal (similarity 1), but an empty transcript
//     never matches: there is nothing to hear.
//
// This heuristic does not certify AEC. It is a deterministic drop, applied
// before a transcript is retained or admitted, and it is deliberately
// conservative: genuine barge-in during playback is dropped too.

/** How long bob remembers its own speech for the say-match guard. */
export const ECHO_WINDOW_MS = 10_000;
/** Similarity at or above which a transcript counts as bob's own words. */
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

/** 1 for identical strings, 1 when both are empty, otherwise 1 - distance/max. */
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
 * bob's own words: `floor((1 - ECHO_SIMILARITY) * length)`.
 *
 * The epsilon keeps the exact boundary in float64: `1 - 0.9` is
 * 0.09999999999999998, so for a 10-character line the product is
 * 0.9999999999999998 and a plain floor would allow ZERO edits, rejecting a
 * transcript one edit away — exactly similarity 0.9, which must match.
 */
export function editAllowance(length: number, threshold: number = ECHO_SIMILARITY): number {
  return Math.floor((1 - threshold) * length + 1e-9);
}

/** The bounded window a spoken line is estimated to play for. */
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
 *  every link change, so records never cross a connection. */
export class EchoGuard {
  private readonly spoken: Spoken[] = [];

  constructor(
    private readonly windowMs: number = ECHO_WINDOW_MS,
    private readonly playbackMs: (text: string) => number = estimatedPlaybackMs,
  ) {}

  /** Record speech bob is about to emit (say or ask). */
  record(text: string, nowMs: number): void {
    this.spoken.push({
      normalized: normalizeSpeech(text),
      atMs: nowMs,
      playbackUntilMs: nowMs + this.playbackMs(text),
    });
    // Bound the list by the same window, not by a model-controlled count.
    this.prune(nowMs);
  }

  /** Playback interlock: bob's own speech is still playing. */
  playbackActive(nowMs: number): boolean {
    return this.spoken.some((s) => nowMs < s.playbackUntilMs);
  }

  /** Say-match: the transcript is one of bob's own recent lines. The window
   *  starts when that line's playback ENDS, so a multi-sentence line cannot
   *  outlast its own echo guard. */
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

  /** The drop reason for a transcript, or null when it is not bob's echo. */
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
