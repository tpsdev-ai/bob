// Smoke session (bob#185 slice 1): an agent with the anchored tools enabled,
// in a scratch workspace, reads a file, edits two lines, inserts after the last
// line, and creates a new file — through the REAL registered tools (the objects
// `wireAnchoredEdit` hands to pi), not by calling the core functions directly.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Harness, makeHarness } from "./helpers.js";

let h: Harness;
beforeEach(() => {
  h = makeHarness();
});
afterEach(() => {
  h.cleanup();
});

describe("anchored-edit — smoke session through the tool registry", () => {
  it("reads, edits two lines, inserts after the last line, and creates a file", async () => {
    const source =
      Array.from({ length: 10 }, (_, i) => `const v${i + 1} = ${i + 1};`).join("\n") + "\n";
    writeFileSync(join(h.root, "app.js"), source);
    const results: string[] = [];

    // 1. read
    const read = await h.call("read_lines", { path: "app.js" });
    results.push(read.text);
    const fp = String(read.details.fingerprint).replace(/^F#/, "");
    const anchors = Object.fromEntries(
      read.text
        .split("\n")
        .filter((l) => l.startsWith("L"))
        .map((l) => [l.split("#")[0], l.split(" ")[0]]),
    );

    // 2. edit two lines (1..2) at once — small against a 10-line file, so the
    // rewrite tripwire (half the file) is not in play.
    const edited = await h.call("edit_lines", {
      path: "app.js",
      from: h.anchor("app.js", 1),
      to: h.anchor("app.js", 2),
      new_text: "const v1 = 10;\nconst v2 = 20;",
      fingerprint: fp,
    });
    results.push(edited.text);
    const fp2 = String(edited.details.fingerprint).replace(/^F#/, "");

    // 3. insert after the last line (line 10)
    const insertAfterLast = await h.call("insert_after", {
      path: "app.js",
      anchor: anchors.L10,
      text: "export { v1, v2 };",
      fingerprint: fp2,
    });
    results.push(insertAfterLast.text);

    // 4. create a new file
    const created = await h.call("write_file", { path: "notes.md", content: "# Notes\n" });
    results.push(created.text);

    const expected = [
      "const v1 = 10;",
      "const v2 = 20;",
      ...Array.from({ length: 8 }, (_, i) => `const v${i + 3} = ${i + 3};`),
      "export { v1, v2 };",
    ].join("\n");
    expect(readFileSync(join(h.root, "app.js"), "utf8")).toBe(`${expected}\n`);
    expect(readFileSync(join(h.root, "notes.md"), "utf8")).toBe("# Notes\n");

    // Every tool result is present and non-empty (paste these in the report).
    expect(results.length).toBe(4);
    for (const r of results) expect(r.length).toBeGreaterThan(0);
    // eslint-disable-next-line no-console
    console.log(results.join("\n---\n"));
  });
});

describe("anchored-edit — root comes from the tool execution context", () => {
  it("resolves a path against ctx.cwd (the pi tool execution context)", async () => {
    writeFileSync(join(h.root, "x.txt"), "hello\n");
    const out = await h.call("read_lines", { path: "x.txt" }, h.root);
    expect(out.text).toContain("hello");
  });

  it("refuses when no context cwd is supplied", async () => {
    const tool = h.tools.get("read_lines");
    if (!tool) throw new Error("read_lines not registered");
    const res = await tool.execute("id", { path: "x.txt" }, undefined, undefined, undefined);
    expect(res.content[0].text).toMatch(/workspace root/);
  });
});
