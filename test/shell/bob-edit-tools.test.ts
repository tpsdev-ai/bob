// bob-edit-tools.test.ts — bob#143 items 1 and 2. The two pi-facing tools,
// exercised against real files in a temp cwd:
//   * the tolerant `edit` lands a whitespace-run mismatch, refuses an ambiguous
//     normalised match, and keeps pi's exact-match behaviour otherwise;
//   * `replace_lines` replaces/deletes an inclusive line range, refuses an
//     inverted or out-of-range one, keeps the line numbers decisive when a line
//     repeats, validates before any write, and is confined to the session cwd
//     (relative paths resolve against it; an absolute path, `..` escape or
//     escaping symlink that leaves it is refused).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bobEditCustomTools,
  createReplaceLinesToolDefinition,
  createTolerantEditToolDefinition,
} from "../../src/shell/bob-edit-tools.js";

type Tool = { execute: (callId: string, input: unknown, ...rest: unknown[]) => Promise<unknown> };

function run(tool: unknown, input: unknown): Promise<unknown> {
  return (tool as Tool).execute("call", input, undefined, undefined, undefined);
}

function resultText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content.map((block) => block.text ?? "").join("\n");
}

describe("createTolerantEditToolDefinition", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "bob-edit-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("applies an exact edit unchanged and notes no normalisation", async () => {
    writeFileSync(join(cwd, "f.ts"), "const a = 1;\nconst b = 2;\n");
    const tool = createTolerantEditToolDefinition(cwd);
    const result = await run(tool, {
      path: "f.ts",
      edits: [{ oldText: "const a = 1;", newText: "const a = 9;" }],
    });
    expect(readFileSync(join(cwd, "f.ts"), "utf8")).toBe("const a = 9;\nconst b = 2;\n");
    expect(resultText(result)).toContain("Successfully replaced");
    expect(resultText(result)).not.toContain("normalising runs of spaces/tabs");
  });

  it("lands an edit whose oldText has different runs of spaces than the file, and says so", async () => {
    // The file aligns the second column; the model wrote single spaces.
    writeFileSync(join(cwd, "f.md"), "- a     b\n- c     d\n");
    const tool = createTolerantEditToolDefinition(cwd);
    const result = await run(tool, {
      path: "f.md",
      edits: [{ oldText: "- a b", newText: "- a B" }],
    });
    expect(readFileSync(join(cwd, "f.md"), "utf8")).toBe("- a B\n- c     d\n");
    expect(resultText(result)).toContain("normalising runs of spaces/tabs");
  });

  it("refuses a normalised match that is not unique, naming the count", async () => {
    writeFileSync(join(cwd, "f.md"), "- x   y\n- x  y\n");
    const tool = createTolerantEditToolDefinition(cwd);
    await expect(
      run(tool, { path: "f.md", edits: [{ oldText: "- x y", newText: "- X Y" }] }),
    ).rejects.toThrow(/Found 2 occurrences/);
    // Nothing written.
    expect(readFileSync(join(cwd, "f.md"), "utf8")).toBe("- x   y\n- x  y\n");
  });
});

describe("createReplaceLinesToolDefinition", () => {
  let cwd: string;
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "bob-edit-"));
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("replaces an inclusive line range without reproducing the old lines", async () => {
    writeFileSync(join(cwd, "f.ts"), "l1\nl2\nl3\n");
    const tool = createReplaceLinesToolDefinition(cwd);
    const result = await run(tool, { path: "f.ts", startLine: 2, endLine: 2, newText: "L2" });
    expect(readFileSync(join(cwd, "f.ts"), "utf8")).toBe("l1\nL2\nl3\n");
    expect(resultText(result)).toContain("Replaced lines 2-2");
  });

  it("deletes a range when newText is empty", async () => {
    writeFileSync(join(cwd, "f.ts"), "l1\nl2\nl3\n");
    const tool = createReplaceLinesToolDefinition(cwd);
    await run(tool, { path: "f.ts", startLine: 2, endLine: 2, newText: "" });
    expect(readFileSync(join(cwd, "f.ts"), "utf8")).toBe("l1\nl3\n");
  });

  it("replaces a multi-line range with several lines", async () => {
    writeFileSync(join(cwd, "f.ts"), "a\nb\nc\nd\n");
    const tool = createReplaceLinesToolDefinition(cwd);
    await run(tool, { path: "f.ts", startLine: 2, endLine: 3, newText: "X\nY" });
    expect(readFileSync(join(cwd, "f.ts"), "utf8")).toBe("a\nX\nY\nd\n");
  });

  it("refuses an inverted range", async () => {
    writeFileSync(join(cwd, "f.ts"), "a\nb\nc\n");
    const tool = createReplaceLinesToolDefinition(cwd);
    await expect(
      run(tool, { path: "f.ts", startLine: 3, endLine: 1, newText: "X" }),
    ).rejects.toThrow(/inverted range/);
    expect(readFileSync(join(cwd, "f.ts"), "utf8")).toBe("a\nb\nc\n");
  });

  it("refuses an out-of-range end", async () => {
    writeFileSync(join(cwd, "f.ts"), "a\nb\n");
    const tool = createReplaceLinesToolDefinition(cwd);
    await expect(
      run(tool, { path: "f.ts", startLine: 1, endLine: 99, newText: "X" }),
    ).rejects.toThrow(/out-of-range/);
  });

  it("refuses a start below line 1", async () => {
    writeFileSync(join(cwd, "f.ts"), "a\nb\n");
    const tool = createReplaceLinesToolDefinition(cwd);
    await expect(
      run(tool, { path: "f.ts", startLine: 0, endLine: 1, newText: "X" }),
    ).rejects.toThrow(/out-of-range/);
  });

  it("resolves a relative path against the session cwd and an absolute path inside it", async () => {
    mkdirSync(join(cwd, "sub"));
    writeFileSync(join(cwd, "sub", "f.ts"), "one\ntwo\n");
    const tool = createReplaceLinesToolDefinition(cwd);
    await run(tool, { path: "sub/f.ts", startLine: 1, endLine: 1, newText: "ONE" });
    expect(readFileSync(join(cwd, "sub", "f.ts"), "utf8")).toBe("ONE\ntwo\n");

    const abs = join(cwd, "sub", "f.ts");
    await run(tool, { path: abs, startLine: 2, endLine: 2, newText: "TWO" });
    expect(readFileSync(abs, "utf8")).toBe("ONE\nTWO\n");
  });

  it("makes the line number decisive when the line repeats elsewhere", async () => {
    // The selected text occurs on three lines; pi's unique-text edit would
    // refuse it. The range must still land, at line 2 only.
    writeFileSync(join(cwd, "f.ts"), "dup\ndup\ndup\n");
    const tool = createReplaceLinesToolDefinition(cwd);
    await run(tool, { path: "f.ts", startLine: 2, endLine: 2, newText: "X" });
    expect(readFileSync(join(cwd, "f.ts"), "utf8")).toBe("dup\nX\ndup\n");
  });

  it("refuses an inverted range before any write, leaving a NUL/marker file byte-identical", async () => {
    // A file may contain NUL bytes and the old probe marker; a refused call must
    // not touch it.
    const bytes = Buffer.from("a\u0000bob-replace-lines-probe\u0000\nb\nc\n", "utf8");
    writeFileSync(join(cwd, "f.bin"), bytes);
    const tool = createReplaceLinesToolDefinition(cwd);
    await expect(
      run(tool, { path: "f.bin", startLine: 3, endLine: 1, newText: "X" }),
    ).rejects.toThrow(/inverted range/);
    expect(readFileSync(join(cwd, "f.bin"))).toEqual(bytes);
  });

  it("refuses an absolute path outside the workspace root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "bob-confine-"));
    const ws = join(parent, "ws");
    mkdirSync(ws);
    writeFileSync(join(parent, "outside.ts"), "a\nb\n");
    const tool = createReplaceLinesToolDefinition(ws);
    await expect(
      run(tool, { path: join(parent, "outside.ts"), startLine: 1, endLine: 1, newText: "X" }),
    ).rejects.toThrow(/refusing to write/);
    expect(readFileSync(join(parent, "outside.ts"), "utf8")).toBe("a\nb\n");
    rmSync(parent, { recursive: true, force: true });
  });

  it("refuses a `..` escape out of the workspace root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "bob-confine-"));
    const ws = join(parent, "ws");
    mkdirSync(ws);
    writeFileSync(join(parent, "outside.ts"), "a\nb\n");
    const tool = createReplaceLinesToolDefinition(ws);
    await expect(
      run(tool, { path: "../outside.ts", startLine: 1, endLine: 1, newText: "X" }),
    ).rejects.toThrow(/refusing to write/);
    expect(readFileSync(join(parent, "outside.ts"), "utf8")).toBe("a\nb\n");
    rmSync(parent, { recursive: true, force: true });
  });

  it("refuses a symlink that leaves the workspace root", async () => {
    const parent = mkdtempSync(join(tmpdir(), "bob-confine-"));
    const ws = join(parent, "ws");
    mkdirSync(ws);
    writeFileSync(join(parent, "outside.ts"), "a\nb\n");
    symlinkSync(join(parent, "outside.ts"), join(ws, "link.ts"));
    const tool = createReplaceLinesToolDefinition(ws);
    await expect(
      run(tool, { path: "link.ts", startLine: 1, endLine: 1, newText: "X" }),
    ).rejects.toThrow(/refusing to write/);
    expect(readFileSync(join(parent, "outside.ts"), "utf8")).toBe("a\nb\n");
    rmSync(parent, { recursive: true, force: true });
  });

  it("refuses a missing file (it does not resolve inside the workspace) rather than reading it as no match", async () => {
    const tool = createReplaceLinesToolDefinition(cwd);
    await expect(
      run(tool, { path: "absent.ts", startLine: 1, endLine: 1, newText: "X" }),
    ).rejects.toThrow(/refusing to write/);
    expect(existsSync(join(cwd, "absent.ts"))).toBe(false);
  });
});

describe("bobEditCustomTools", () => {
  it("registers each tool from its own effective allowance", () => {
    const names = (policy: { tools: readonly string[]; excludeTools: readonly string[] }) =>
      bobEditCustomTools(policy, "/tmp").map((t) => t.name);
    expect(names({ tools: ["read"], excludeTools: [] })).toEqual([]);
    expect(names({ tools: ["edit"], excludeTools: ["edit"] })).toEqual([]);
    // Either name can be allowed without the other.
    expect(names({ tools: ["edit"], excludeTools: [] })).toEqual(["edit"]);
    expect(names({ tools: ["replace_lines"], excludeTools: [] })).toEqual(["replace_lines"]);
    expect(names({ tools: ["edit", "replace_lines"], excludeTools: [] })).toEqual([
      "edit",
      "replace_lines",
    ]);
    // An excluded name is not registered even when its partner is allowed.
    expect(names({ tools: ["edit", "replace_lines"], excludeTools: ["replace_lines"] })).toEqual([
      "edit",
    ]);
  });
});
