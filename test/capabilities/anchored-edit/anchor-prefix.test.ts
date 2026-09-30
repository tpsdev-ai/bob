// bob#223: a model copied read_lines output into new text with its
// `L<n>#<8 hex> ` prefixes intact. edit_lines / insert_after / write_file refuse
// text in which any line matches that shape (copied or not); when the call's
// earlier checks pass, the refusal names the first matching line. No tool argument and no config turns the guard off, and there is no
// escape hatch: #223 asked for one, but no channel the agent cannot write exists
// for it yet, so such content is written outside these tools.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
  fnv1a32,
  Refusal,
  renderReadLines,
} from "../../../src/capabilities/anchored-edit/core.js";
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
// one rendered line per file line — the lines a model would copy back. Taken by
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
      'refusing edit_lines on "a.txt": line 1 of the new text matches the read_lines anchor prefix shape',
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
      'refusing insert_after on "b.txt": line 1 of the new text matches the read_lines anchor prefix shape',
    );
    expect(readFileSync(join(h.root, "b.txt"))).toEqual(before);
  });

  it("write_file refuses content copied from read_lines and creates NOTHING", async () => {
    writeFileSync(join(h.root, "c.txt"), "x\ny\n");
    const { body } = await readBody("c.txt");
    const out = await h.call("write_file", { path: "new.txt", content: body.join("\n") });
    expect(out.details.refused).toBe(true);
    expect(out.text).toContain(
      'refusing write_file on "new.txt": line 1 of the new text matches the read_lines anchor prefix shape',
    );
    expect(existsSync(join(h.root, "new.txt"))).toBe(false);
  });

  it("names the FIRST of several matching lines (each tool)", async () => {
    writeFileSync(join(h.root, "f.txt"), "a\nb\nc\nd\ne\n");
    const { body, fp } = await readBody("f.txt");
    // Matching lines at 3 AND 5 of the new text; the refusal must name 3.
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
      expect(out.text).toContain(
        "line 3 of the new text matches the read_lines anchor prefix shape",
      );
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

  it("a call an earlier check refuses gets that refusal, not the prefix refusal, and writes NOTHING", async () => {
    writeFileSync(join(h.root, "s.txt"), "one\ntwo\nthree\n");
    const { body, fp } = await readBody("s.txt");
    const prefixed = body.join("\n");
    const before = readFileSync(join(h.root, "s.txt"));
    const staleFp = "0".repeat(16);
    const outs = [
      // A stale fingerprint (edit_lines, then insert_after).
      await h.call("edit_lines", {
        path: "s.txt",
        from: h.anchor("s.txt", 1),
        to: h.anchor("s.txt", 1),
        new_text: prefixed,
        fingerprint: staleFp,
      }),
      await h.call("insert_after", {
        path: "s.txt",
        anchor: h.anchor("s.txt", 3),
        text: prefixed,
        fingerprint: staleFp,
      }),
      // A stale anchor with the current fingerprint.
      await h.call("edit_lines", {
        path: "s.txt",
        from: "L1#00000000",
        to: "L1#00000000",
        new_text: prefixed,
        fingerprint: fp,
      }),
    ];
    for (const out of outs) {
      expect(out.details.refused).toBe(true);
      expect(out.details.signals).toContain("stale_anchor");
      expect(out.text).not.toContain("anchor prefix shape");
    }
    expect(readFileSync(join(h.root, "s.txt"))).toEqual(before);
  });
});

describe("anchored-edit — no argument and no config turns the prefix guard off (bob#223)", () => {
  it("the mutating tools' schemas hold exactly their data parameters, and each description states the guard", () => {
    const expected: Record<string, string[]> = {
      edit_lines: ["path", "from", "to", "new_text", "fingerprint"],
      insert_after: ["path", "anchor", "text", "fingerprint"],
      write_file: ["path", "content"],
    };
    for (const [name, keys] of Object.entries(expected)) {
      const tool = h.tools.get(name) as RegisteredTool;
      const schema = tool.parameters as { properties: Record<string, unknown> };
      expect(Object.keys(schema.properties)).toEqual(keys);
      expect(tool.description).toContain("the call is refused and nothing is written");
      expect(tool.description).toContain("report BLOCKED and name the file");
      expect(tool.description).not.toMatch(/allow_anchor_prefixes|operator|exempt|escape/i);
    }
  });

  // Arguments no tool declares: the dropped per-call flag, the dropped config
  // key, and a few override-sounding names. None may change what a call does.
  const EXTRAS: Record<string, unknown>[] = [
    { allow_anchor_prefixes: true },
    { allow_anchor_prefixes: "true" },
    { anchorPrefixPaths: ["*"] },
    { force: true, override: true, skip_guard: true },
  ];

  it("an extra argument never changes the outcome: the same refused flag, raw result text, details and file bytes (each tool)", async () => {
    const base = "one\ntwo\nthree\nfour\n";
    writeFileSync(join(h.root, "src.txt"), base);
    // Lines 1-2 of a real read: with their prefixes, and stripped.
    const { body, fp } = await readBody("src.txt");
    const texts = {
      prefixed: body.slice(0, 2).join("\n"),
      clean: body.slice(0, 2).map(strip).join("\n"),
    };
    // What each tool leaves behind without any extra argument.
    const expectedBytes: Record<string, Record<"prefixed" | "clean", string | null>> = {
      edit_lines: { prefixed: base, clean: "one\ntwo\ntwo\nthree\nfour\n" },
      insert_after: { prefixed: base, clean: `${base}one\ntwo\n` },
      write_file: { prefixed: null, clean: "one\ntwo" },
    };
    const file = "t.txt";
    for (const tool of ["edit_lines", "insert_after", "write_file"]) {
      for (const kind of ["prefixed", "clean"] as const) {
        const observed: Array<{
          refused: boolean;
          text: string;
          details: Record<string, unknown>;
          bytes: string | null;
        }> = [];
        for (const extra of [{}, ...EXTRAS]) {
          // Each call runs in its own fresh session and workspace, on the same
          // relative path with the same bytes as src.txt (so the same
          // fingerprint and anchors), so the raw result text compares as is.
          const one = makeHarness();
          try {
            let params: Record<string, unknown>;
            if (tool === "write_file") {
              params = { path: file, content: texts[kind] };
            } else {
              writeFileSync(join(one.root, file), base);
              params =
                tool === "edit_lines"
                  ? {
                      path: file,
                      from: one.anchor(file, 1),
                      to: one.anchor(file, 1),
                      new_text: texts[kind],
                      fingerprint: fp,
                    }
                  : { path: file, anchor: one.anchor(file, 4), text: texts[kind], fingerprint: fp };
            }
            const out = await one.call(tool, { ...params, ...extra });
            const target = join(one.root, file);
            observed.push({
              refused: out.details.refused === true,
              text: out.text,
              details: out.details,
              bytes: existsSync(target) ? readFileSync(target, "utf8") : null,
            });
          } finally {
            one.cleanup();
          }
        }
        // Without extras the call does what the guard says ...
        expect(observed[0].refused).toBe(kind === "prefixed");
        expect(observed[0].bytes).toBe(expectedBytes[tool][kind]);
        // ... and every extra argument leaves that outcome exactly as it was.
        for (const o of observed.slice(1)) expect(o).toEqual(observed[0]);
      }
    }
  });

  it("the anchored-edit config takes no knob: anchorPrefixPaths in bob.yaml is refused at load", () => {
    const yaml = [
      "capabilities:",
      "  - anchored-edit",
      "",
      "anchored-edit:",
      "  anchorPrefixPaths:",
      "    - fixtures/a.txt",
      "",
    ].join("\n");
    expect(() =>
      resolveCapabilities({ yamlText: yaml, resolveSource: (name) => `/resolved/${name}` }),
    ).toThrow(/capability "anchored-edit" config is invalid/);
    for (const block of [{ anchorPrefixPaths: ["a.txt"] }, { allow_anchor_prefixes: true }]) {
      const env = { [CONFIG_ENV_VAR]: JSON.stringify(block) };
      expect(() => loadConfigFromEnv(env)).toThrow(/config is invalid/);
    }
  });
});

// Rendering has one definition (ANCHOR_FORMAT). The matchers are literal regexes
// (CI refuses a RegExp built at runtime), pinned to that definition here: their
// source must spell ANCHOR_FORMAT's parts, the guard must match exactly the
// prefixes read_lines renders, and the anchor parser must read each rendered
// token back.
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
        // The anchor parser's literal reads the rendered token back: the whole
        // token, its line number, and its hash (FNV-1a 32 of the line's bytes,
        // 8 lowercase hex). It does not match the whole rendered line.
        const token = line.slice(0, line.indexOf(" "));
        const m = ANCHOR_TOKEN_RE.exec(token);
        expect(m?.[0]).toBe(token);
        expect(m?.[1]).toBe(String(n));
        expect(m?.[2]).toBe(fnv1a32(Buffer.from(content, "utf8")).toString(16).padStart(8, "0"));
        expect(ANCHOR_TOKEN_RE.test(line)).toBe(false);
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
        "line 2 of the new text matches the read_lines anchor prefix shape",
      );
    }
    for (const n of [1, 9, 10, TOTAL]) expect(seen).toContain(n);
  });
});
