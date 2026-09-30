// bob#244 (web spec v3, slice R1a): the web capability's manifest, catalog
// entry, extension and shared config schema. The schema is ONE object checked
// at two gates — YAML load (the catalog, through resolveCapabilities) and
// BOB_CAP_WEB ingestion (the extension's loadConfigFromEnv) — and both are
// pinned here with the same valid, invalid and bound cases.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";
import {
  CONFIG_ENV_VAR,
  CONFIG_SCHEMA,
  loadConfigFromEnv,
  resolveWebSettings,
  webManifest,
} from "../../../src/capabilities/web/index.js";
import { BobYamlError } from "../../../src/shell/bob-yaml.js";
import { lookupCapability } from "../../../src/shell/capability-catalog.js";
import {
  capabilityConfigEnv,
  capabilityEnvVar,
  resolveCapabilities,
} from "../../../src/shell/capability-loader.js";

// The flat block from the spec, verbatim.
const SPEC_YAML = [
  "capabilities: [web]",
  "web:",
  "  allow_http: false",
  "  fetch_max_chars: 20000",
  "  fetch_per_turn: 10",
  "  text_per_turn: 100000",
  "",
].join("\n");

const yamlWith = (lines: string[]) =>
  ["capabilities:", "  - web", "", "web:", ...lines, ""].join("\n");
const loadYaml = (lines: string[]) => resolveCapabilities({ yamlText: yamlWith(lines) });
const loadEnv = (raw: string | undefined) =>
  loadConfigFromEnv(raw === undefined ? {} : { [CONFIG_ENV_VAR]: raw });

describe("the web manifest, catalog entry and export", () => {
  it("is blessed, built, and serves nothing", () => {
    const entry = lookupCapability("web");
    expect(entry?.notYetImplemented).toBeFalsy();
    expect(entry?.manifest).toBe(webManifest);
    expect(webManifest.name).toBe("web");
    expect(webManifest.piPackage).toBe("@tpsdev-ai/bob/capabilities/web");
    expect(webManifest.provides?.serves).toBe(false);
    expect(webManifest.provides?.dataClass).toBe("public");
    // Declared for review; registered by later slices (web_fetch R1c, web_search R2).
    expect(webManifest.provides?.tools).toEqual(["web_fetch", "web_search"]);
  });

  it("the catalog validates bob.yaml against the SAME schema object the extension checks", () => {
    expect(webManifest.configSchema).toBe(CONFIG_SCHEMA);
    expect(capabilityEnvVar("web")).toBe(CONFIG_ENV_VAR);
  });

  it("resolves through the package's exports map to the built extension", () => {
    const { extensionSources } = resolveCapabilities({ yamlText: "capabilities:\n  - web\n" });
    expect(extensionSources).toHaveLength(1);
    expect(extensionSources[0]?.endsWith("/dist/capabilities/web/index.js")).toBe(true);
  });
});

describe("YAML load: the spec's flat block", () => {
  it("parses the spec's block exactly, and hands the extension the same values", () => {
    const resolution = resolveCapabilities({ yamlText: SPEC_YAML });
    const web = resolution.capabilities[0];
    expect(web?.name).toBe("web");
    expect(web?.config).toEqual({
      allow_http: false,
      fetch_max_chars: 20000,
      fetch_per_turn: 10,
      text_per_turn: 100000,
    });
    const env = capabilityConfigEnv(resolution);
    expect(loadEnv(env[CONFIG_ENV_VAR])).toEqual(web?.config as never);
  });

  it("an absent block is the defaults", () => {
    const resolution = resolveCapabilities({ yamlText: "capabilities:\n  - web\n" });
    expect(resolution.capabilities[0]?.config).toEqual({});
    expect(capabilityConfigEnv(resolution)[CONFIG_ENV_VAR]).toBe("{}");
    expect(resolveWebSettings(loadEnv("{}"))).toEqual({
      allowHttp: false,
      fetchMaxChars: 20000,
      fetchPerTurn: 10,
      textPerTurn: 100000,
    });
  });

  it("keeps a lowered value, never widens it", () => {
    expect(
      resolveWebSettings(
        loadYaml(["  allow_http: true", "  fetch_max_chars: 500"]).capabilities[0]?.config as never,
      ),
    ).toEqual({ allowHttp: true, fetchMaxChars: 500, fetchPerTurn: 10, textPerTurn: 100000 });
  });
});

// The invalid and bound cases, each run through BOTH gates.
const INVALID: Array<{ name: string; yaml: string[]; json: string; match: RegExp }> = [
  {
    name: "an unknown key (search settings are a later slice)",
    yaml: ["  search_key_file: ~/k"],
    json: '{"search_key_file":"~/k"}',
    match: /config is invalid/,
  },
  {
    name: "allow_http that is not a boolean",
    yaml: ['  allow_http: "false"'],
    json: '{"allow_http":"false"}',
    match: /\/allow_http/,
  },
  {
    name: "a quoted number",
    yaml: ['  fetch_max_chars: "20000"'],
    json: '{"fetch_max_chars":"20000"}',
    match: /\/fetch_max_chars/,
  },
  {
    name: "a fractional number",
    yaml: ["  fetch_per_turn: 2.5"],
    json: '{"fetch_per_turn":2.5}',
    match: /\/fetch_per_turn/,
  },
];

const BOUNDS: Array<{ field: string; min: number; max: number }> = [
  { field: "fetch_max_chars", min: 1, max: 100000 },
  { field: "fetch_per_turn", min: 1, max: 10 },
  { field: "text_per_turn", min: 1, max: 100000 },
];

describe("invalid blocks are refused at BOTH gates", () => {
  it.each(INVALID)("$name", ({ yaml, json, match }) => {
    expect(() => loadYaml(yaml)).toThrow(match);
    expect(() => loadEnv(json)).toThrow(match);
  });

  it("a nested mapping is refused by bob.yaml's reader, naming the block", () => {
    expect(() => loadYaml(["  limits:", "    fetch_per_turn: 3"])).toThrow(BobYamlError);
    expect(() => loadYaml(["  limits:", "    fetch_per_turn: 3"])).toThrow(
      /"web:" block, line \d+: nested mappings are not supported/,
    );
  });
});

describe("bounds, at BOTH gates", () => {
  it.each(BOUNDS)("$field: min and max accepted, one past each refused", ({ field, min, max }) => {
    for (const value of [min, max]) {
      expect(loadYaml([`  ${field}: ${value}`]).capabilities[0]?.config).toEqual({
        [field]: value,
      });
      expect(loadEnv(JSON.stringify({ [field]: value }))).toEqual({ [field]: value } as never);
    }
    for (const value of [min - 1, max + 1, -1]) {
      // Both gates name the field by its schema path: "... config is invalid (at /<field>)".
      expect(() => loadYaml([`  ${field}: ${value}`]), `${field}=${value}`).toThrow(
        `(at /${field})`,
      );
      expect(() => loadEnv(JSON.stringify({ [field]: value })), `${field}=${value}`).toThrow(
        `(at /${field})`,
      );
    }
  });
});

describe("BOB_CAP_WEB ingestion", () => {
  it("refuses an unset or empty variable rather than reading it as the defaults", () => {
    expect(() => loadEnv(undefined)).toThrow(/BOB_CAP_WEB is not set/);
    expect(() => loadEnv("")).toThrow(/BOB_CAP_WEB is not set/);
    expect(() => loadEnv("   ")).toThrow(/BOB_CAP_WEB is not set/);
  });

  it("refuses JSON that does not parse, without echoing it", () => {
    let message = "";
    try {
      loadEnv("{not json: s3cr3t-looking");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("web capability: BOB_CAP_WEB is not valid JSON.");
  });

  it("refuses a value that is not an object", () => {
    for (const raw of ["null", "[]", '"web"', "7", "true"]) {
      expect(() => loadEnv(raw), raw).toThrow(/config is invalid/);
    }
  });
});

describe("the extension registers no tool and validates its block at load", () => {
  let cwd: string;
  let agentDir: string;
  let saved: string | undefined;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "bob-web-ext-cwd-"));
    agentDir = mkdtempSync(join(tmpdir(), "bob-web-ext-pi-"));
    saved = process.env[CONFIG_ENV_VAR];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[CONFIG_ENV_VAR];
    else process.env[CONFIG_ENV_VAR] = saved;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  async function load(env: string | undefined) {
    if (env === undefined) delete process.env[CONFIG_ENV_VAR];
    else process.env[CONFIG_ENV_VAR] = env;
    const { extensionSources } = resolveCapabilities({ yamlText: "capabilities:\n  - web\n" });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      additionalExtensionPaths: extensionSources,
      noExtensions: true,
    });
    await loader.reload();
    return loader.getExtensions();
  }

  it("a valid block loads, with no tool registered", async () => {
    const exts = await load('{"fetch_per_turn":3}');
    expect(exts.errors ?? []).toEqual([]);
    const web = exts.extensions.find((e) => e.path.endsWith("/dist/capabilities/web/index.js"));
    expect(web).toBeDefined();
    expect([...(web?.tools.keys() ?? [])]).toEqual([]);
  });

  it("an invalid block fails the load, naming the field", async () => {
    const exts = await load('{"fetch_per_turn":11}');
    expect(exts.errors.map((e) => e.error).join("\n")).toContain("/fetch_per_turn");
  });

  it("an unset variable fails the load", async () => {
    const exts = await load(undefined);
    expect(exts.errors.map((e) => e.error).join("\n")).toContain("BOB_CAP_WEB is not set");
  });
});
