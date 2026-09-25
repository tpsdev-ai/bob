// Unit tests for the turn-origin MODEL + human-facing label (round 3).
//
// Round 3 removed the in-prompt nonce-bearing tag (tagPrompt / parseTurnOrigin).
// The turn's origin now travels OUT OF BAND via a runtime registry
// (turn-origin-registry.ts), covered by turn-origin-registry.test.ts. This file
// keeps only the originLabel, which renders a TurnOrigin as a short human-facing
// string (used as the presence currentTask and the turn-summary origin label).

import { describe, expect, it } from "bun:test";
import type { TurnOrigin } from "../../src/shell/turn-origin.js";
import { originLabel } from "../../src/shell/turn-origin.js";

describe("originLabel", () => {
  it("renders each origin kind as its human label", () => {
    expect(originLabel({ kind: "run" })).toBe("run");
    expect(originLabel({ kind: "mail", from: "flint" })).toBe("mail from flint");
    expect(originLabel({ kind: "cron", job: "daily-brief" })).toBe("cron daily-brief");
    expect(originLabel({ kind: "discord", channelId: "123456789" })).toBe("discord 123456789");
  });

  it("caps a long label at 120 chars with a trailing ellipsis", () => {
    const label = originLabel({ kind: "cron", job: "x".repeat(200) });
    expect(label.length).toBe(120);
    expect(label.endsWith("\u2026")).toBe(true);
    expect(label.startsWith("cron ")).toBe(true);
  });

  it("honors a custom maxChars", () => {
    const label = originLabel({ kind: "mail", from: "a".repeat(50) }, 20);
    expect(label.length).toBeLessThanOrEqual(20);
    // A single-char ellipsis is still added on cap.
    expect(label.endsWith("\u2026")).toBe(true);
  });

  it("returns the full label untouched when it fits", () => {
    expect(originLabel({ kind: "mail", from: "flint" }, 120)).toBe("mail from flint");
  });

  it("is a pure function of the origin — no global registry is consulted", () => {
    // A label never reads the registry; it renders only the given origin.
    expect(() => originLabel({ kind: "run" as const })).not.toThrow();
    // The TurnOrigin union is exhaustive; a cast to a non-kind string would fail
    // the type, so the label always renders one of the four kinds above.
    const o: TurnOrigin = { kind: "cron", job: "abc-def" };
    expect(originLabel(o)).toBe("cron abc-def");
  });
});
