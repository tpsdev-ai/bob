import { describe, expect, it } from "bun:test";
import { parseBobYamlBlock, readProviderLimits } from "../../src/shell/bob-yaml.js";
import { declaredProviderModel } from "../../src/shell/run.js";

describe("bob#186 slice 2 (T7) — the provider readers parse real YAML", () => {
  it("reads provider fields through the real parser, with nested siblings present", () => {
    const yaml = [
      "provider:",
      '  name: "ollama"',
      "  model: m-1",
      "  context_window: 262144",
      "  models:",
      "    - id: other",
      "      context_window: 131072",
      "      max_output_tokens: 4096",
      "capabilities:",
      "  - flair",
      "",
    ].join("\n");
    expect(readProviderLimits(yaml)).toEqual({
      contextWindow: 262_144,
      models: { other: { contextWindow: 131_072, maxOutputTokens: 4096 } },
    });
    expect(declaredProviderModel(yaml)).toBe("m-1");
    expect(parseBobYamlBlock(yaml, "capabilities")).toEqual(["flair"]);
  });

  it("a scalar numeric or boolean provider field is returned as its text", () => {
    expect(declaredProviderModel("provider:\n  name: ollama\n  model: 123\n")).toBe("123");
    expect(declaredProviderModel("provider:\n  name: ollama\n  model: true\n")).toBe("true");
  });

  it("duplicate mapping keys refuse instead of keeping the last value", () => {
    const yaml = "provider:\n  name: ollama\n  name: other\n  model: m\n";
    expect(() => readProviderLimits(yaml)).toThrow(/could not parse/);
  });

  it("a malformed document refuses without fallback", () => {
    expect(() => readProviderLimits("provider:\n  name: [unclosed\n")).toThrow(
      /could not parse|flow/i,
    );
  });

  it("an alias or anchor refuses with its named refusal", () => {
    expect(() =>
      readProviderLimits("provider: &p\n  name: ollama\n  model: m\nbase: *p\n"),
    ).toThrow(/bob\.yaml uses a YAML alias\/anchor, which is not allowed/);
  });

  it("a merge key refuses with its named refusal", () => {
    // No anchor/alias anywhere: the merge key must be what refuses.
    expect(() =>
      readProviderLimits("base:\n  <<: {a: 1}\nprovider:\n  name: ollama\n  model: m\n"),
    ).toThrow(/bob\.yaml uses a YAML merge key, which is not allowed/);
  });

  it("a YAML tag refuses with its named refusal", () => {
    expect(() =>
      readProviderLimits("provider:\n  name: ollama\n  model: m\ntag: !!acme x\n"),
    ).toThrow(/unsupported YAML tag in bob\.yaml/);
  });

  it("an unknown provider key still refuses", () => {
    expect(() =>
      readProviderLimits("provider:\n  name: ollama\n  model: m\n  nest:\n    a: 1\n"),
    ).toThrow(/unknown key "nest"/);
  });

  it("a `provider:` block that is not a mapping refuses", () => {
    expect(() => readProviderLimits("provider: 5\n")).toThrow(
      /"provider:" block must be a mapping/,
    );
  });

  it("an absent provider block reads as no limits", () => {
    expect(readProviderLimits("agent:\n  role: ea\n")).toEqual({ models: {} });
    expect(declaredProviderModel("agent:\n  role: ea\n")).toBeUndefined();
  });
});
