import { describe, expect, it } from "bun:test";
import { readBlock, readCapabilities } from "../src/bob-yaml.js";

describe("readCapabilities", () => {
  it("reads a block-sequence list", () => {
    const yaml = [
      "agent:",
      "  id: pulse",
      "",
      "capabilities:",
      "  - discord",
      "  - flair",
      "  - mail",
      "",
      "tools:",
      "  allow:",
      "    - read",
      "",
    ].join("\n");
    expect(readCapabilities(yaml)).toEqual(["discord", "flair", "mail"]);
  });

  it("reads an inline-flow list", () => {
    expect(readCapabilities("capabilities: [discord, flair]")).toEqual(["discord", "flair"]);
  });

  it("strips quotes from list items", () => {
    const yaml = ["capabilities:", '  - "discord"', "  - 'flair'", ""].join("\n");
    expect(readCapabilities(yaml)).toEqual(["discord", "flair"]);
  });

  it("returns [] when the field is absent", () => {
    expect(readCapabilities("provider:\n  name: anthropic\n")).toEqual([]);
  });

  it("returns [] for an empty inline list", () => {
    expect(readCapabilities("capabilities: []")).toEqual([]);
  });

  it("stops at the next top-level key", () => {
    const yaml = [
      "capabilities:",
      "  - discord",
      "provider:",
      "  name: anthropic",
      "  model: x",
      "",
    ].join("\n");
    // `name`/`model` under provider must NOT bleed into the list.
    expect(readCapabilities(yaml)).toEqual(["discord"]);
  });

  it("skips comments inside the block", () => {
    const yaml = ["capabilities:", "  # a comment", "  - discord", ""].join("\n");
    expect(readCapabilities(yaml)).toEqual(["discord"]);
  });
});

describe("readBlock", () => {
  it("reads a flat scalar block, coercing types", () => {
    const yaml = [
      "discord:",
      "  bot_token_file: ~/.tps/secrets/pulse-discord",
      "  dispatch_all: true",
      "  max_retries: 3",
      "",
      "provider:",
      "  name: anthropic",
      "",
    ].join("\n");
    expect(readBlock(yaml, "discord")).toEqual({
      bot_token_file: "~/.tps/secrets/pulse-discord",
      dispatch_all: true,
      max_retries: 3,
    });
  });

  it("returns undefined when the block is absent", () => {
    expect(readBlock("provider:\n  name: anthropic\n", "discord")).toBeUndefined();
  });

  it("returns {} for a present-but-empty block", () => {
    const yaml = ["discord:", "", "provider:", "  name: anthropic", ""].join("\n");
    expect(readBlock(yaml, "discord")).toEqual({});
  });

  it("does not read keys from a sibling block", () => {
    const yaml = ["discord:", "  token: a", "flair:", "  url: b", ""].join("\n");
    expect(readBlock(yaml, "discord")).toEqual({ token: "a" });
    expect(readBlock(yaml, "flair")).toEqual({ url: "b" });
  });

  it("strips quotes from scalar values", () => {
    const yaml = ["discord:", '  token: "secret"', ""].join("\n");
    expect(readBlock(yaml, "discord")).toEqual({ token: "secret" });
  });
});
