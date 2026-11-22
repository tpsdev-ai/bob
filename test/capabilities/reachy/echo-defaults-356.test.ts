// bob#356 V2a — the echo guard under its PRODUCTION defaults.
//
// These cases replace neither constructor argument: they exercise
// estimatedPlaybackMs and the say-match window as shipped. The boundary
// cases pin the fixed length-based edit allowance in float64, and the long
// multi-sentence line pins the say-match window to the ESTIMATED playback end.
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
  it("a multi-sentence recorded line is guarded through its estimated playback and the window after it", () => {
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
    // The estimated playback is over; the identical text still matches the
    // recorded text, because the say-match window is measured from the
    // estimated end.
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

  it("editSimilarity is 0 when the length gap alone exceeds the allowance, else 1 - distance/max", () => {
    // 5 vs 4 characters: the allowance for 5 is 0 edits, the gap is 1, so 0 —
    // not 1 - 1/5. No such pair can match, so the walk is skipped.
    expect(editAllowance(5)).toBe(0);
    expect(editSimilarity("hello", "hell")).toBe(0);
    expect(editSimilarity("hello there", "hi")).toBe(0);
    // Inside the allowance the ratio is the plain one: 10 vs 9, one edit.
    expect(editSimilarity("abcdefghij", "abcdefghi")).toBeCloseTo(0.9, 12);
  });

  it("two empty strings have similarity 1, but an empty transcript matches nothing", () => {
    expect(editSimilarity("", "")).toBe(1);
    const guard = new EchoGuard();
    guard.record("", 1_000);
    expect(guard.matchesRecentSay("", 1_000)).toBe(false);
    // An empty line still gets the 1 s floor of its ESTIMATED playback window.
    expect(guard.playbackActive(1_000)).toBe(true);
  });

  it("clearing the guard forgets every recorded line", () => {
    const guard = new EchoGuard();
    guard.record("The meeting is at noon today.", 1_000);
    expect(guard.check("The meeting is at noon today.", 1_000)).toBe("playback");
    guard.clear();
    expect(guard.playbackActive(1_000)).toBe(false);
    expect(guard.matchesRecentSay("The meeting is at noon today.", 1_001)).toBe(false);
  });
});
