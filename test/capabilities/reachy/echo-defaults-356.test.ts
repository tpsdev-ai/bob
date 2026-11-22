// bob#356 V2a — the echo guard under its PRODUCTION defaults.
//
// These cases replace neither constructor argument: they exercise
// estimatedPlaybackMs and the recent-speech window as shipped. The boundary
// cases pin the fixed length-based edit allowance in float64, and the long
// multi-sentence line pins the say-match window to the END of playback.
import { describe, expect, it } from "bun:test";
import {
  ECHO_SIMILARITY,
  ECHO_WINDOW_MS,
  EchoGuard,
  editAllowance,
  editSimilarity,
  estimatedPlaybackMs,
} from "../../../src/capabilities/reachy/echo.js";

describe("bob#356 V2a — EchoGuard with its production defaults", () => {
  it("a multi-sentence say is guarded through its estimated playback and the window after it", () => {
    const guard = new EchoGuard();
    const text =
      "The meeting is at noon today. Bring the printed agenda and the two signed pages. " +
      "The room is on the second floor, and the door code is on your badge.";
    const playback = estimatedPlaybackMs(text);
    // The default estimate is a bounded function of the line's length.
    expect(playback).toBe(Math.min(15_000, Math.max(1_000, 600 + 60 * text.length)));
    const at = 1_000;
    guard.record(text, at);
    expect(guard.playbackActive(at + playback - 1)).toBe(true);
    expect(guard.check(text, at + playback - 1)).toBe("playback");
    // Playback is over; the identical line is still bob's own words because the
    // say-match window is measured from the END of playback.
    expect(guard.playbackActive(at + playback)).toBe(false);
    expect(guard.matchesRecentSay(text, at + playback)).toBe(true);
    expect(guard.matchesRecentSay(text, at + playback + ECHO_WINDOW_MS)).toBe(true);
    expect(guard.matchesRecentSay(text, at + playback + ECHO_WINDOW_MS + 1)).toBe(false);
  });

  it("an exact 0.9 similarity matches in float64, and a lower one does not", () => {
    const guard = new EchoGuard();
    // 10 characters, ONE edit: 1 - 1/10 = 0.9 exactly, and must match.
    const ten = "abcdefghij";
    expect(editSimilarity(ten, "abcdefghiX")).toBeCloseTo(0.9, 12);
    expect(editAllowance(10)).toBe(1);
    guard.record(ten, 1_000);
    expect(guard.matchesRecentSay("abcdefghiX", 1_000)).toBe(true);
    // 9 characters, ONE edit: 0.888…, below the threshold.
    expect(editAllowance(9)).toBe(0);
    guard.record("abcdefghi", 1_000);
    expect(guard.matchesRecentSay("abcdefghX", 1_000)).toBe(false);
    // 20 characters, TWO edits: 0.9 exactly; three edits are below it.
    const twenty = "abcdefghijklmnopqrst";
    expect(editAllowance(20)).toBe(2);
    guard.record(twenty, 1_000);
    expect(guard.matchesRecentSay("abcdefghijklmnopqrXY", 1_000)).toBe(true);
    expect(guard.matchesRecentSay("abcdefghijklmnopqXYZ", 1_000)).toBe(false);
    expect(ECHO_SIMILARITY).toBe(0.9);
  });

  it("two empty strings have similarity 1, but an empty transcript matches nothing", () => {
    expect(editSimilarity("", "")).toBe(1);
    const guard = new EchoGuard();
    guard.record("", 1_000);
    expect(guard.matchesRecentSay("", 1_000)).toBe(false);
    expect(guard.playbackActive(1_000)).toBe(true); // an empty line still plays its 1 s floor
  });

  it("one guard is reused across links: clearing it forgets the previous link", () => {
    const guard = new EchoGuard();
    guard.record("The meeting is at noon today.", 1_000);
    expect(guard.check("The meeting is at noon today.", 1_000)).toBe("playback");
    guard.clear();
    expect(guard.playbackActive(1_000)).toBe(false);
    expect(guard.matchesRecentSay("The meeting is at noon today.", 1_001)).toBe(false);
  });
});
