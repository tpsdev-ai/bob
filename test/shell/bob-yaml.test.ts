import { describe, expect, it } from "bun:test";
import { BobYamlError, readBlock, readCapabilities } from "../../src/shell/bob-yaml.js";

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

  it("reads a nested block-sequence list (channelIds)", () => {
    const yaml = [
      "discord:",
      "  tokenFile: ~/.tps/secrets/pulse-discord",
      "  channelIds:",
      "    - '111'",
      "    - '222'",
      "  dispatchAll: true",
      "",
      "provider:",
      "  name: anthropic",
      "",
    ].join("\n");
    expect(readBlock(yaml, "discord")).toEqual({
      tokenFile: "~/.tps/secrets/pulse-discord",
      channelIds: ["111", "222"],
      dispatchAll: true,
    });
  });

  it("reads a nested inline-flow list", () => {
    const yaml = ["discord:", "  channelIds: [111, 222, 333]", ""].join("\n");
    expect(readBlock(yaml, "discord")).toEqual({ channelIds: [111, 222, 333] });
  });

  it("treats an empty list key as []", () => {
    const yaml = ["discord:", "  channelIds:", "  tokenFile: /p", ""].join("\n");
    expect(readBlock(yaml, "discord")).toEqual({ channelIds: [], tokenFile: "/p" });
  });

  it("does not let a sibling block's list bleed in", () => {
    const yaml = ["discord:", "  channelIds:", "    - '111'", "flair:", "  url: b", ""].join("\n");
    expect(readBlock(yaml, "discord")).toEqual({ channelIds: ["111"] });
    expect(readBlock(yaml, "flair")).toEqual({ url: "b" });
  });
});

// A block sequence whose items are one-level mappings. The observatory
// capability's `agents` needs this: before it was supported, `- agentId: x`
// coerced to the STRING "agentId: x", the item's second key was hoisted into
// the enclosing block, and every later item was dropped — a wrong value that
// looked plausible enough to ship. See issue #77.
describe("readBlock — block sequence of mappings", () => {
  it("reads a list of single-key mappings", () => {
    const yaml = ["observatory:", "  agents:", "    - agentId: testbot", ""].join("\n");
    expect(readBlock(yaml, "observatory")).toEqual({ agents: [{ agentId: "testbot" }] });
  });

  it("reads multi-key items, keeping each item's keys in that item", () => {
    const yaml = [
      "observatory:",
      "  observatoryUrl: http://127.0.0.1:9926",
      "  officeId: rockit",
      "  agents:",
      "    - agentId: flint",
      "      name: Flint",
      "      role: Strategy",
      "    - agentId: anvil",
      "      type: agent",
      "  staleThresholdSeconds: 600",
      "",
      "provider:",
      "  name: anthropic",
      "",
    ].join("\n");
    // Every assertion here fails under the old reader: `agents` was
    // ["agentId: flint", "agentId: anvil"], `name`/`role`/`type` were hoisted
    // to the block, and `staleThresholdSeconds` still landed correctly only by
    // accident of ordering.
    expect(readBlock(yaml, "observatory")).toEqual({
      observatoryUrl: "http://127.0.0.1:9926",
      officeId: "rockit",
      agents: [
        { agentId: "flint", name: "Flint", role: "Strategy" },
        { agentId: "anvil", type: "agent" },
      ],
      staleThresholdSeconds: 600,
    });
  });

  it("coerces item values the same way scalar sub-keys are coerced", () => {
    const yaml = [
      "observatory:",
      "  agents:",
      "    - agentId: a",
      "      port: 9926",
      "      enabled: true",
      "      quoted: '9926'",
      "      path: /a/b.key",
      "",
    ].join("\n");
    expect(readBlock(yaml, "observatory")).toEqual({
      agents: [{ agentId: "a", port: 9926, enabled: true, quoted: "9926", path: "/a/b.key" }],
    });
  });

  it("supports an inline-flow list as an item value", () => {
    const yaml = ["observatory:", "  agents:", "    - agentId: a", "      tags: [x, y]", ""].join(
      "\n",
    );
    expect(readBlock(yaml, "observatory")).toEqual({
      agents: [{ agentId: "a", tags: ["x", "y"] }],
    });
  });

  it("ends the list at a sibling sub-key and at the next column-0 key", () => {
    const yaml = [
      "observatory:",
      "  agents:",
      "    - agentId: a",
      "  officeId: rockit",
      "flair:",
      "  url: b",
      "",
    ].join("\n");
    expect(readBlock(yaml, "observatory")).toEqual({
      agents: [{ agentId: "a" }],
      officeId: "rockit",
    });
    expect(readBlock(yaml, "flair")).toEqual({ url: "b" });
  });

  it("skips comments and blank lines between items", () => {
    const yaml = [
      "observatory:",
      "  agents:",
      "    # the first agent",
      "    - agentId: a",
      "",
      "    - agentId: b",
      "",
    ].join("\n");
    expect(readBlock(yaml, "observatory")).toEqual({
      agents: [{ agentId: "a" }, { agentId: "b" }],
    });
  });

  // The colon-must-be-followed-by-space rule. Without it a list of URLs turns
  // into a list of objects keyed `http`, which is the same class of silent
  // wrong parse this fix exists to remove.
  it("keeps a scalar item that merely CONTAINS a colon a scalar", () => {
    const yaml = [
      "discord:",
      "  hosts:",
      "    - http://a.example",
      "    - 09:00",
      "    - 'k: v'",
      "",
    ].join("\n");
    expect(readBlock(yaml, "discord")).toEqual({
      hosts: ["http://a.example", "09:00", "k: v"],
    });
  });
});

// Shapes the reader deliberately does NOT support. Each must throw rather than
// return something plausible — a silent wrong parse is how #77 reached a
// published package.
describe("readBlock — unsupported shapes throw", () => {
  const cases: Array<[string, string[]]> = [
    ["a nested mapping under a sub-key", ["x:", "  a:", "    b: 1"]],
    ["a nested mapping under a valued sub-key", ["x:", "  a: 1", "    b: 2"]],
    ["a sub-key with no value inside a list item", ["x:", "  l:", "    - a: 1", "      b:"]],
    ["a nested list inside a list item", ["x:", "  l:", "    - a: 1", "      - b"]],
    ["a list of lists", ["x:", "  l:", "    - - a"]],
    ["an empty dash", ["x:", "  l:", "    -", "      a: 1"]],
    ["a list mixing scalar then mapping items", ["x:", "  l:", "    - a", "    - b: 1"]],
    ["a list mixing mapping then scalar items", ["x:", "  l:", "    - b: 1", "    - a"]],
    ["a flow mapping as a sub-key value", ["x:", "  a: { b: 1 }"]],
    ["a flow mapping as an item value", ["x:", "  l:", "    - a: { b: 1 }"]],
    ["a flow mapping as a whole item", ["x:", "  l:", "    - { a: 1 }"]],
    ["ragged list-item indentation", ["x:", "  l:", "    - a: 1", "      - a: 2"]],
    ["a list item with no sub-key opening a list", ["x:", "  a: 1", "  - b"]],
    ["a block that is itself a list", ["x:", "  - a", "  - b"]],
    ["an unrecognized line", ["x:", "  not a key value pair"]],
    ["an unrecognized line inside a list item", ["x:", "  l:", "    - a: 1", "      nope"]],
    ["an outdented line", ["x:", "    a: 1", "  b: 2"]],
  ];

  for (const [label, lines] of cases) {
    it(`throws on ${label}`, () => {
      expect(() => readBlock(`${lines.join("\n")}\n`, "x")).toThrow(BobYamlError);
    });
  }

  it("names the block and the 1-based line, and never echoes a value", () => {
    const yaml = [
      "other:",
      "  k: v",
      "x:",
      "  token: super-secret-value",
      "    nested: 1",
      "",
    ].join("\n");
    let err: unknown;
    try {
      readBlock(yaml, "x");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(BobYamlError);
    const e = err as BobYamlError;
    expect(e.key).toBe("x");
    expect(e.line).toBe(5);
    expect(e.message).toContain('bob.yaml "x:" block, line 5');
    // The value on the preceding line must never reach the message/log.
    expect(e.message).not.toContain("super-secret-value");
  });

  it("only throws for the block asked for, not a malformed sibling", () => {
    const yaml = ["good:", "  a: 1", "bad:", "  n:", "    m: 2", ""].join("\n");
    expect(readBlock(yaml, "good")).toEqual({ a: 1 });
    expect(() => readBlock(yaml, "bad")).toThrow(BobYamlError);
  });
});
