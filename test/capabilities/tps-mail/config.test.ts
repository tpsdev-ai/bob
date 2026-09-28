// bob#200 §7 / F2 / F10: tps-mail owns its CONFIG_SCHEMA, and an empty or
// missing allow-list means the capability REFUSES TO LOAD.
//
// ACCEPTANCE: "an empty allow-list makes the capability refuse to load, and
// doctor fails" — the load half is (c1)-(c3) here; the doctor half is in
// test/shell/doctor.test.ts (d2).
import { describe, expect, it } from "bun:test";
import {
  CONFIG_ENV_VAR,
  loadConfigFromEnv,
  validateTpsMailConfig,
} from "../../../src/capabilities/tps-mail/config.js";
import tpsMailExtension from "../../../src/capabilities/tps-mail/index.js";
import { lookupCapability } from "../../../src/shell/capability-catalog.js";
import { resolveCapabilities } from "../../../src/shell/capability-loader.js";

const yaml = (block: string[]): string =>
  ["capabilities:", "  - tps-mail", "", "tps-mail:", ...block, ""].join("\n");

const resolve = (text: string) =>
  resolveCapabilities({ yamlText: text, resolveSource: (name) => `/resolved/${name}` });

describe("tps-mail config — the allow-list is required", () => {
  it("is blessed in the catalog with its own schema", () => {
    const entry = lookupCapability("tps-mail");
    expect(entry?.notYetImplemented).toBeUndefined();
    expect(entry?.manifest.provides?.tools).toEqual([]);
  });

  it("(c1) an EMPTY senders list refuses to load", () => {
    expect(() => resolve(yaml(["  inbox: ~/.tps/mail/testbot", "  senders:"]))).toThrow(
      /capability "tps-mail" config is invalid \(at \/senders\)/,
    );
    expect(() => resolve(yaml(["  inbox: ~/.tps/mail/testbot", "  senders: []"]))).toThrow(
      /\/senders/,
    );
  });

  it("(c2) a MISSING senders list — or a missing block — refuses to load", () => {
    expect(() => resolve(yaml(["  inbox: ~/.tps/mail/testbot"]))).toThrow(/tps-mail/);
    expect(() => resolve(["capabilities:", "  - tps-mail", ""].join("\n"))).toThrow(/tps-mail/);
  });

  it("(c3) the extension itself refuses an empty allow-list at load", () => {
    const env = { [CONFIG_ENV_VAR]: JSON.stringify({ inbox: "/x", senders: [] }) };
    expect(() => loadConfigFromEnv(env)).toThrow(/\/senders/);
    const saved = process.env[CONFIG_ENV_VAR];
    process.env[CONFIG_ENV_VAR] = JSON.stringify({ inbox: "/x", senders: [] });
    try {
      expect(() => tpsMailExtension({} as never)).toThrow(/\/senders/);
    } finally {
      if (saved === undefined) delete process.env[CONFIG_ENV_VAR];
      else process.env[CONFIG_ENV_VAR] = saved;
    }
  });

  it("loads a block with an exact allow-list", () => {
    const r = resolve(
      yaml(["  inbox: ~/.tps/mail/testbot", "  senders:", "    - flint", "  maxReplyChars: 1900"]),
    );
    expect(r.capabilities[0]?.config).toEqual({
      inbox: "~/.tps/mail/testbot",
      senders: ["flint"],
      maxReplyChars: 1900,
    });
  });

  it("refuses globs, prefixes, flag-shaped ids, duplicates and unknown keys", () => {
    for (const sender of ["*", "fl*", "flint?", "-flint", "a b", "flint.local"]) {
      expect(() => validateTpsMailConfig({ inbox: "/x", senders: [sender] })).toThrow(/senders/);
    }
    expect(() => validateTpsMailConfig({ inbox: "/x", senders: ["flint", "flint"] })).toThrow();
    expect(() =>
      validateTpsMailConfig({ inbox: "/x", senders: ["flint"], dispatchAll: true }),
    ).toThrow();
  });

  it("bounds the timeout and the reply cap", () => {
    expect(() =>
      validateTpsMailConfig({ inbox: "/x", senders: ["flint"], turnTimeoutMs: 0 }),
    ).toThrow();
    expect(() =>
      validateTpsMailConfig({ inbox: "/x", senders: ["flint"], maxReplyChars: 1_000_000 }),
    ).toThrow();
  });
});
