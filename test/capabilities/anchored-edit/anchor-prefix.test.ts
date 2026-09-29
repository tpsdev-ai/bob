// bob#223: a model that copies read_lines output into new text keeps the
// `L<n>#<8 hex> ` prefixes. edit_lines / insert_after / write_file refuse text
// in which any line starts with that rendered shape, naming the first offending
// line. No tool parameter turns the guard off; only the operator's anchored-edit
// config (`anchorPrefixPaths` in bob.yaml) exempts a named file.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONFIG_ENV_VAR,
  loadConfigFromEnv,
} from "../../../src/capabilities/anchored-edit/config.js";
import {
  ANCHOR_FORMAT,
  ANCHOR_PREFIX_RE,
  ANCHOR_TOKEN_RE,
  assertNoAnchorPrefix,
  Refusal,
  renderReadLines,
} from "../../../src/capabilities/anchored-edit/core.js";
import anchoredEditExtension from "../../../src/capabilities/anchored-edit/index.js";
import { resolveCapabilities } from "../../../src/shell/capability-loader.js";
import { type Harness, makeHarness, type RegisteredTool } from "./helpers.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
});

// The body of a read_lines result that was not cut: the header is line 0, then
// one rendered line per file line — exactly what a model copies back. Taken by
// position, not by the guard's regex, so these helpers do not depend on the
// code under test.
function bodyLines(readText: string, lineCount: number): string[] {
  return readText.split("\n").slice(1, 1 + lineCount);
}

// A rendered line with its prefix removed: the token holds no space, so the
// prefix ends at the first space.
function strip(rendered: string): string {
  return rendered.slice(rendered.indexOf(" ") + 1);
}

async function readBody(file: string): Promise<{ body: string[]; fp: string }> {
  const read = await h.call("read_lines", { path: file });
  return {
    body: bodyLines(read.text, Number(read.details.lineCount)),
    fp: String(read.details.fingerprint).replace(/^F#/, ""),
  };
}

function expectSucceeded(out: { text: string; details: Record<string, unknown> }): void {
  expect(out.details.refused).toBeUndefined();
  expect(out.text.startsWith("REFUSED")).toBe(false);
}

describe("anchored-edit — read_lines prefixes in new text are refused (bob#223)", () => {
  it("edit_lines refuses new_text copied from read_lines and writes NOTHING", async () => {
    writeFileSync(join(h.root, "a.txt"), "one\ntwo\nthree\n");
    const { body, fp } = await readBody("a.txt");
    const before = readFileSync(join(h.root, "a.txt"));
    const out = await h.call("edit_lines", {
      path: "a.txt",
      from: h.anchor("a.txt", 1),
      to: h.anchor("a.txt", 1),
      new_text: body.join("\n"),
      fingerprint: fp,
    });
    expect(out.details.refused).toBe(true);
    expect(out.text).toContain(
      'refusing edit_lines on "a.txt": line 1 of the new text starts with a read_lines anchor prefix',
    );
    expect(readFileSync(join(h.root, "a.txt"))).toEqual(before);
  });

  it("insert_after refuses text copied from read_lines and writes NOTHING", async () => {
    writeFileSync(join(h.root, "b.txt"), "alpha\nbeta\n");
    const { body, fp } = await readBody("b.txt");
    const before = readFileSync(join(h.root, "b.txt"));
    const out = await h.call("insert_after", {
      path: "b.txt",
      anchor: h.anchor("b.txt", 2),
      text: body.join("\n"),
      fingerprint: fp,
    });
    expect(out.details.refused).toBe(true);
    expect(out.text).toContain(
      'refusing insert_after on "b.txt": line 1 of the new text starts with a read_lines anchor prefix',
    );
    expect(readFileSync(join(h.root, "b.txt"))).toEqual(before);
  });

  it("write_file refuses content copied from read_lines and creates NOTHING", async () => {
    writeFileSync(join(h.root, "c.txt"), "x\ny\n");
    const { body } = await readBody("c.txt");
    const out = await h.call("write_file", { path: "new.txt", content: body.join("\n") });
    expect(out.details.refused).toBe(true);
    expect(out.text).toContain(
      'refusing write_file on "new.txt": line 1 of the new text starts with a read_lines anchor prefix',
    );
    expect(existsSync(join(h.root, "new.txt"))).toBe(false);
  });

  it("names the FIRST of several offending lines (each tool)", async () => {
    writeFileSync(join(h.root, "f.txt"), "a\nb\nc\nd\ne\n");
    const { body, fp } = await readBody("f.txt");
    // Offending lines at 3 AND 5 of the new text; the refusal must name 3.
    const mixed = [strip(body[0]), "clean", body[2], "clean too", body[4]].join("\n");
    const before = readFileSync(join(h.root, "f.txt"));
    const outs = [
      await h.call("edit_lines", {
        path: "f.txt",
        from: h.anchor("f.txt", 1),
        to: h.anchor("f.txt", 1),
        new_text: mixed,
        fingerprint: fp,
      }),
      await h.call("insert_after", {
        path: "f.txt",
        anchor: h.anchor("f.txt", 5),
        text: mixed,
        fingerprint: fp,
      }),
      await h.call("write_file", { path: "g.txt", content: mixed }),
    ];
    for (const out of outs) {
      expect(out.details.refused).toBe(true);
      expect(out.text).toContain("line 3 of the new text starts with a read_lines anchor prefix");
      expect(out.text).not.toContain("line 5 of the new text");
    }
    expect(readFileSync(join(h.root, "f.txt"))).toEqual(before);
    expect(existsSync(join(h.root, "g.txt"))).toBe(false);
  });

  it("stripped read_lines output that CHANGES the file is written (each tool)", async () => {
    writeFileSync(join(h.root, "d.txt"), "one\ntwo\nthree\nfour\nfive\n");
    // edit_lines: replace line 1 with read lines 4-5, prefixes stripped. The
    // 4 bytes replaced are under the 12-byte tripwire limit.
    const r1 = await readBody("d.txt");
    const edited = await h.call("edit_lines", {
      path: "d.txt",
      from: h.anchor("d.txt", 1),
      to: h.anchor("d.txt", 1),
      new_text: r1.body.slice(3, 5).map(strip).join("\n"),
      fingerprint: r1.fp,
    });
    expectSucceeded(edited);
    expect(readFileSync(join(h.root, "d.txt"), "utf8")).toBe(
      "four\nfive\ntwo\nthree\nfour\nfive\n",
    );

    // insert_after: append the new file's lines 2-3, read back and stripped.
    const r2 = await readBody("d.txt");
    const inserted = await h.call("insert_after", {
      path: "d.txt",
      anchor: h.anchor("d.txt", 6),
      text: r2.body.slice(1, 3).map(strip).join("\n"),
      fingerprint: r2.fp,
    });
    expectSucceeded(inserted);
    expect(readFileSync(join(h.root, "d.txt"), "utf8")).toBe(
      "four\nfive\ntwo\nthree\nfour\nfive\nfive\ntwo\n",
    );

    // write_file: a new file from the whole read, stripped.
    const r3 = await readBody("d.txt");
    const created = await h.call("write_file", {
      path: "copy.txt",
      content: `${r3.body.map(strip).join("\n")}\n`,
    });
    expectSucceeded(created);
    expect(readFileSync(join(h.root, "copy.txt"))).toEqual(readFileSync(join(h.root, "d.txt")));
  });
});

describe("anchored-edit — no tool call can turn the prefix guard off (bob#223)", () => {
  it("the mutating tools' schemas hold exactly their data parameters, and no description offers an override", () => {
    const expected: Record<string, string[]> = {
      edit_lines: ["path", "from", "to", "new_text", "fingerprint"],
      insert_after: ["path", "anchor", "text", "fingerprint"],
      write_file: ["path", "content"],
    };
    for (const [name, keys] of Object.entries(expected)) {
      const tool = h.tools.get(name) as RegisteredTool;
      const schema = tool.parameters as { properties: Record<string, unknown> };
      expect(Object.keys(schema.properties)).toEqual(keys);
      expect(tool.description).not.toContain("allow_anchor_prefixes");
      expect(tool.description).toContain("No parameter turns this off");
    }
  });

  it("a call that passes allow_anchor_prefixes: true is still refused and writes NOTHING", async () => {
    writeFileSync(join(h.root, "e.txt"), "one\ntwo\nthree\n");
    const { body, fp } = await readBody("e.txt");
    const before = readFileSync(join(h.root, "e.txt"));
    const prefixed = body.join("\n");
    const outs = [
      await h.call("edit_lines", {
        path: "e.txt",
        from: h.anchor("e.txt", 1),
        to: h.anchor("e.txt", 1),
        new_text: prefixed,
        fingerprint: fp,
        allow_anchor_prefixes: true,
      }),
      await h.call("insert_after", {
        path: "e.txt",
        anchor: h.anchor("e.txt", 3),
        text: prefixed,
        fingerprint: fp,
        allow_anchor_prefixes: true,
      }),
      await h.call("write_file", {
        path: "e2.txt",
        content: prefixed,
        allow_anchor_prefixes: true,
      }),
    ];
    for (const out of outs) {
      expect(out.details.refused).toBe(true);
      expect(out.text).toContain("line 1 of the new text starts with a read_lines anchor prefix");
      expect(out.text).not.toContain("allow_anchor_prefixes");
    }
    expect(readFileSync(join(h.root, "e.txt"))).toEqual(before);
    expect(existsSync(join(h.root, "e2.txt"))).toBe(false);
  });
});

describe("anchored-edit — the operator's anchorPrefixPaths exempts only the files it names (bob#223)", () => {
  let op: Harness;
  beforeEach(() => {
    op = makeHarness({
      config: {
        anchorPrefixPaths: ["fixtures/anchor-shaped.txt", "fixtures/created.txt", "link.txt"],
      },
    });
    mkdirSync(join(op.root, "fixtures"));
  });
  afterEach(() => {
    op.cleanup();
  });

  async function opRead(file: string): Promise<{ body: string[]; fp: string }> {
    const read = await op.call("read_lines", { path: file });
    return {
      body: bodyLines(read.text, Number(read.details.lineCount)),
      fp: String(read.details.fingerprint).replace(/^F#/, ""),
    };
  }

  it("a listed file takes prefixed text from every tool; the bytes land as sent", async () => {
    const file = "fixtures/anchor-shaped.txt";
    writeFileSync(join(op.root, file), "one\ntwo\nthree\nfour\n");
    const r1 = await opRead(file);
    const line1 = r1.body[0];
    expectSucceeded(
      await op.call("edit_lines", {
        path: file,
        from: op.anchor(file, 1),
        to: op.anchor(file, 1),
        new_text: line1,
        fingerprint: r1.fp,
      }),
    );
    expect(readFileSync(join(op.root, file), "utf8")).toBe(`${line1}\ntwo\nthree\nfour\n`);

    const r2 = await opRead(file);
    expectSucceeded(
      await op.call("insert_after", {
        path: file,
        anchor: op.anchor(file, 4),
        text: r2.body[1],
        fingerprint: r2.fp,
      }),
    );
    expect(readFileSync(join(op.root, file), "utf8")).toBe(
      `${line1}\ntwo\nthree\nfour\n${r2.body[1]}\n`,
    );

    expectSucceeded(await op.call("write_file", { path: "fixtures/created.txt", content: line1 }));
    expect(readFileSync(join(op.root, "fixtures/created.txt"), "utf8")).toBe(line1);
  });

  it("every other file in the same session is still refused, including an entry that is a symlink", async () => {
    writeFileSync(join(op.root, "plain.txt"), "one\ntwo\n");
    // `link.txt` is listed, but it is a symlink: the edit resolves to plain.txt,
    // which is not listed, so the guard stays on.
    symlinkSync("plain.txt", join(op.root, "link.txt"));
    const { body, fp } = await opRead("plain.txt");
    const before = readFileSync(join(op.root, "plain.txt"));
    for (const path of ["plain.txt", "link.txt"]) {
      const out = await op.call("edit_lines", {
        path,
        from: op.anchor("plain.txt", 1),
        to: op.anchor("plain.txt", 1),
        new_text: body[0],
        fingerprint: fp,
      });
      expect(out.details.refused).toBe(true);
      expect(out.text).toContain("line 1 of the new text starts with a read_lines anchor prefix");
    }
    expect(readFileSync(join(op.root, "plain.txt"))).toEqual(before);
    const out = await op.call("write_file", { path: "fixtures/other.txt", content: body[0] });
    expect(out.details.refused).toBe(true);
    expect(existsSync(join(op.root, "fixtures/other.txt"))).toBe(false);
  });
});

describe("anchored-edit — anchorPrefixPaths is validated where bob.yaml is read (bob#223)", () => {
  const yaml = (block: string[]): string =>
    ["capabilities:", "  - anchored-edit", "", "anchored-edit:", ...block, ""].join("\n");
  const resolve = (text: string) =>
    resolveCapabilities({ yamlText: text, resolveSource: (name) => `/resolved/${name}` });

  it("a bob.yaml list of workspace-relative paths resolves, and the extension loads it", () => {
    const res = resolve(yaml(["  anchorPrefixPaths:", "    - fixtures/a.txt", "    - b.txt"]));
    expect(res.capabilities[0].config).toEqual({ anchorPrefixPaths: ["fixtures/a.txt", "b.txt"] });
    const env = { [CONFIG_ENV_VAR]: JSON.stringify(res.capabilities[0].config) };
    expect(loadConfigFromEnv(env)).toEqual({ anchorPrefixPaths: ["fixtures/a.txt", "b.txt"] });
  });

  it("no block, or no var, means no exemption", () => {
    expect(
      resolve(["capabilities:", "  - anchored-edit", ""].join("\n")).capabilities[0].config,
    ).toEqual({});
    expect(loadConfigFromEnv({})).toEqual({});
  });

  it("refuses a path that is not workspace-relative normal form, and any other key", () => {
    for (const bad of [
      "/etc/hosts",
      "../up.txt",
      "a/../b.txt",
      "./a.txt",
      "a/./b.txt",
      "a/",
      "a//b",
      "a\\b",
      "..",
    ]) {
      expect(() => resolve(yaml(["  anchorPrefixPaths:", `    - "${bad}"`]))).toThrow(
        /capability "anchored-edit" config is invalid \(at \/anchorPrefixPaths\/0\)/,
      );
      const env = { [CONFIG_ENV_VAR]: JSON.stringify({ anchorPrefixPaths: [bad] }) };
      expect(() => loadConfigFromEnv(env)).toThrow(
        /config is invalid \(at \/anchorPrefixPaths\/0\)/,
      );
    }
    const env = { [CONFIG_ENV_VAR]: JSON.stringify({ allow_anchor_prefixes: true }) };
    expect(() => loadConfigFromEnv(env)).toThrow(/config is invalid/);
    const notList = { [CONFIG_ENV_VAR]: JSON.stringify({ anchorPrefixPaths: true }) };
    expect(() => loadConfigFromEnv(notList)).toThrow(/config is invalid/);
  });

  it("the extension factory hands the loaded list to the tools", async () => {
    const tools = new Map<string, RegisteredTool>();
    const fakePi = {
      registerTool(tool: RegisteredTool) {
        tools.set(tool.name, tool);
      },
    };
    const prior = process.env[CONFIG_ENV_VAR];
    const origError = console.error;
    process.env[CONFIG_ENV_VAR] = JSON.stringify({ anchorPrefixPaths: ["listed.txt"] });
    console.error = () => {};
    try {
      anchoredEditExtension(fakePi as never);
    } finally {
      console.error = origError;
      if (prior === undefined) delete process.env[CONFIG_ENV_VAR];
      else process.env[CONFIG_ENV_VAR] = prior;
    }
    const write = tools.get("write_file") as RegisteredTool;
    const ctx = { cwd: h.root };
    const prefixed = "L1#0123abcd hello";
    const listed = await write.execute(
      "t",
      { path: "listed.txt", content: prefixed },
      undefined,
      undefined,
      ctx,
    );
    expect(listed.content[0].text.startsWith("REFUSED")).toBe(false);
    expect(readFileSync(join(h.root, "listed.txt"), "utf8")).toBe(prefixed);
    const other = await write.execute(
      "t",
      { path: "other.txt", content: prefixed },
      undefined,
      undefined,
      ctx,
    );
    expect(other.content[0].text).toContain(
      "line 1 of the new text starts with a read_lines anchor prefix",
    );
    expect(existsSync(join(h.root, "other.txt"))).toBe(false);
  });
});

// Rendering has one definition (ANCHOR_FORMAT). The matchers are literal regexes
// (CI refuses a RegExp built at runtime), pinned to that definition here: their
// source must spell ANCHOR_FORMAT's parts, and the guard must match exactly what
// read_lines renders.
describe("anchored-edit — the guard matches exactly what read_lines renders (contract, bob#223)", () => {
  // Lines 1-10 are near misses of the prefix shape; the guard must match none
  // of them as content. Every other line is plain.
  const NEAR_MISSES = [
    "",
    "L9",
    "L9#",
    "L9#0123abc x",
    "L9#0123456g x",
    "L9#01234567",
    "l9#01234567 x",
    "L9#0123ABCD x",
    " L9#01234567 x",
    "L#01234567 x",
  ];
  const TOTAL = 99999;
  const contents = Array.from({ length: TOTAL }, (_, i) => (i < 10 ? NEAR_MISSES[i] : `v${i + 1}`));
  const raw = Buffer.from(`${contents.join("\n")}\n`, "utf8");

  it("matches every rendered prefix exactly, for lines 1, 9, 10 and 99999, and nothing else", () => {
    // Each literal's source, spelled from ANCHOR_FORMAT's parts: a separator,
    // the lead, the radix or the hash width changed in ANCHOR_FORMAT without the
    // literals following fails here.
    const f = ANCHOR_FORMAT;
    const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const lastDigit = "0123456789abcdefghijklmnopqrstuvwxyz"[f.hashRadix - 1];
    const hashClass = f.hashRadix <= 10 ? `[0-${lastDigit}]` : `[0-9a-${lastDigit}]`;
    const hash = `${hashClass}{${f.hashDigits}}`;
    expect(ANCHOR_PREFIX_RE.source).toBe(
      `^${esc(f.lead)}\\d+${esc(f.hashSep)}${hash}${esc(f.prefixSep)}`,
    );
    expect(ANCHOR_TOKEN_RE.source).toBe(`^${esc(f.lead)}(\\d+)${esc(f.hashSep)}(${hash})$`);
    expect(ANCHOR_PREFIX_RE.flags).toBe("");
    expect(ANCHOR_TOKEN_RE.flags).toBe("");

    const seen: number[] = [];
    for (const [start, end] of [
      [1, 10],
      [TOTAL - 1, TOTAL],
    ]) {
      const out = renderReadLines(raw, start, end, "big.txt").text.split("\n");
      const [header, ...body] = out;
      expect(body).toHaveLength(end - start + 1);
      // The header is not a prefixed line.
      expect(ANCHOR_PREFIX_RE.test(header)).toBe(false);
      expect(() => assertNoAnchorPrefix(header, "t", "p")).not.toThrow();
      body.forEach((line, i) => {
        const n = start + i;
        seen.push(n);
        const content = contents[n - 1];
        // What read_lines put in front of this line's text, taken by position.
        expect(line.endsWith(content)).toBe(true);
        const prefix = line.slice(0, line.length - content.length);
        expect(prefix.startsWith(`L${n}#`)).toBe(true);
        // The guard's regex matches exactly that prefix: no shorter, no longer.
        expect(ANCHOR_PREFIX_RE.exec(line)?.[0]).toBe(prefix);
        expect(() => assertNoAnchorPrefix(line, "t", "p")).toThrow(Refusal);
        // And nothing in the line's own content.
        expect(ANCHOR_PREFIX_RE.test(content)).toBe(false);
        expect(() => assertNoAnchorPrefix(content, "t", "p")).not.toThrow();
      });
      // The whole result as new text: the first body line (line 2) is named.
      expect(() => assertNoAnchorPrefix(out.join("\n"), "t", "p")).toThrow(
        "line 2 of the new text starts with a read_lines anchor prefix",
      );
    }
    for (const n of [1, 9, 10, TOTAL]) expect(seen).toContain(n);
  });
});
