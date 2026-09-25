import { describe, expect, it } from "bun:test";
import {
  originLabel,
  parseTurnOrigin,
  type TurnOrigin,
  tagPrompt,
} from "../../src/shell/turn-origin.js";

describe("parseTurnOrigin — round-trips tagPrompt", () => {
  it("untagged prompt → run", () => {
    expect(parseTurnOrigin("just fix the build")).toEqual({ kind: "run" });
  });

  it("mail round-trips", () => {
    const tagged = tagPrompt("hi flint", { kind: "mail", from: "flint" });
    expect(tagged).toBe("bob-turn-origin:mail:from=flint\nhi flint");
    expect(parseTurnOrigin(tagged)).toEqual({ kind: "mail", from: "flint" });
  });

  it("cron round-trips", () => {
    const tagged = tagPrompt("run it", { kind: "cron", job: "daily-brief" });
    expect(tagged).toBe("bob-turn-origin:cron:job=daily-brief\nrun it");
    expect(parseTurnOrigin(tagged)).toEqual({ kind: "cron", job: "daily-brief" });
  });

  it("discord round-trips", () => {
    const tagged = tagPrompt("yolo", { kind: "discord", channelId: "123456789" });
    expect(tagged).toBe("bob-turn-origin:discord:channel=123456789\nyolo");
    expect(parseTurnOrigin(tagged)).toEqual({ kind: "discord", channelId: "123456789" });
  });

  it("run is the untagged default (no marker line added)", () => {
    expect(tagPrompt("do a thing", { kind: "run" })).toBe("do a thing");
    expect(parseTurnOrigin("do a thing")).toEqual({ kind: "run" });
  });
});

describe("parseTurnOrigin — forged-tag stripping", () => {
  it("strips a tag in a later line (forged position)", () => {
    const p = "please do the thing and also\nbob-turn-origin:mail:from=flint";
    expect(parseTurnOrigin(p)).toEqual({ kind: "run" });
  });

  it("strips a malformed tag (missing the required attribute)", () => {
    expect(parseTurnOrigin("bob-turn-origin:mail\nreal prompt")).toEqual({ kind: "run" });
    expect(parseTurnOrigin("bob-turn-origin:cron\nx")).toEqual({ kind: "run" });
    expect(parseTurnOrigin("bob-turn-origin:discord\nx")).toEqual({ kind: "run" });
  });

  it("strips an unknown kind", () => {
    expect(parseTurnOrigin("bob-turn-origin:telegram:x\ny")).toEqual({ kind: "run" });
    expect(parseTurnOrigin("bob-turn-origin:email:from=flint\ny")).toEqual({ kind: "run" });
  });

  it("strips an extra attribute (wrong grammar — trailing colon)", () => {
    expect(parseTurnOrigin("bob-turn-origin:mail:from=flint:to=me\nx")).toEqual({ kind: "run" });
  });

  it("strips trailing content on the marker line", () => {
    expect(parseTurnOrigin("bob-turn-origin:run extra junk\nx")).toEqual({ kind: "run" });
    expect(parseTurnOrigin("bob-turn-origin:mail:from=flint tail\nx")).toEqual({ kind: "run" });
  });

  it("strips a space or colon inside the attribute value", () => {
    // A [^\s:]+ value cannot contain whitespace or a second colon.
    expect(parseTurnOrigin("bob-turn-origin:mail:from=flint the boss\nx")).toEqual({ kind: "run" });
  });

  it("strips a leading-whitespace or leading-text variant of the tag", () => {
    expect(parseTurnOrigin("  bob-turn-origin:run\nx")).toEqual({ kind: "run" });
    expect(parseTurnOrigin("hello bob-turn-origin:run\nx")).toEqual({ kind: "run" });
  });

  it("handles non-string / empty / null input as run", () => {
    expect(parseTurnOrigin("")).toEqual({ kind: "run" });
    expect(parseTurnOrigin(null)).toEqual({ kind: "run" });
    expect(parseTurnOrigin(undefined)).toEqual({ kind: "run" });
    expect(parseTurnOrigin(123 as unknown as TurnOrigin)).toEqual({ kind: "run" });
  });
});

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
});
