// reachy/echo.ts — the ECHO GUARD (bob#356 V2a, gate 5 / design §9).
//
// The sidecar's microphone can hear bob's own speaker. Hardware echo
// cancellation is required on the device, but bob cannot verify a device
// property, so it keeps its own backstop:
//
//   * PLAYBACK INTERLOCK: a transcript that arrives while bob's own speech is
//     still playing is dropped. The playback window is estimated from the
//     spoken text (a bound, never a sidecar assertion).
//   * SAY-MATCH: a transcript whose text closely matches something bob said
//     within the last `windowMs` is dropped. Normalization is NFKC, lowercase,
//     punctuation and whitespace folded to single spaces; similarity is
//     `1 - levenshtein / max(length)` and the threshold is 0.9.
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

/** 1 for identical strings, 0 when either is empty; otherwise 1 - distance/max. */
export function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const max = Math.max(a.length, b.length);
  if (max === 0) return 1;
  // A length gap alone bounds the similarity: skip the quadratic walk.
  if (Math.abs(a.length - b.length) / max > 1 - ECHO_SIMILARITY) return 0;
  return 1 - levenshtein(a, b) / max;
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

/** The guard's state. One instance per sidecar link. */
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

  /** Say-match: the transcript is one of bob's own recent lines. */
  matchesRecentSay(text: string, nowMs: number): boolean {
    const normalized = normalizeSpeech(text);
    if (normalized.length === 0) return false;
    return this.spoken.some(
      (s) =>
        nowMs - s.atMs <= this.windowMs &&
        s.normalized.length > 0 &&
        editSimilarity(normalized, s.normalized) >= ECHO_SIMILARITY,
    );
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
    const horizon = nowMs - this.windowMs;
    while (this.spoken.length > 0 && (this.spoken[0]?.atMs ?? 0) < horizon) {
      this.spoken.shift();
    }
  }
}
