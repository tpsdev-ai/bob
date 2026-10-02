// bob#273 — `edit` and `replace_lines` bind their read and their write to the
// workspace entry they checked. A checked canonical path's final component
// swapped between the check and the bound open is refused. The swap is
// deterministic: a test hook runs in the window the binding closes.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createReplaceLinesToolDefinition,
  createTolerantEditToolDefinition,
  type EditWriteHooks,
} from "../../src/shell/bob-edit-tools.js";
import {
  checkWriteTargetVerified,
  openVerifiedWriteTarget,
} from "../../src/shell/confined-read.js";

type Tool = { execute: (callId: string, input: unknown, ...rest: unknown[]) => Promise<unknown> };

function run(tool: unknown, input: unknown): Promise<unknown> {
  return (tool as Tool).execute("call", input, undefined, undefined, undefined);
}

// The deterministic seam: swap the leaf after a target is checked and before it
// is opened, in the phase a case names.
function swapAt(phase: "read" | "write", swap: (canonicalPath: string) => void): EditWriteHooks {
  return {
    betweenCheckAndOpen: (canonicalPath, p) => {
      if (p === phase) swap(canonicalPath);
    },
  };
}

describe("edit / replace_lines bind the write to the checked entry (bob#273)", () => {
  let base: string;
  let ws: string;
  let outside: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "bob-bind-"));
    ws = join(base, "ws");
    outside = join(base, "outside");
    mkdirSync(ws);
    mkdirSync(outside);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("replace_lines: a leaf swapped for a SYMLINK to an outside file is refused, and the outside file is unchanged", async () => {
    writeFileSync(join(ws, "f.ts"), "l1\nl2\n");
    writeFileSync(join(outside, "secret.ts"), "SECRET\n");
    const tool = createReplaceLinesToolDefinition(
      ws,
      swapAt("write", (p) => {
        rmSync(p);
        symlinkSync(join(outside, "secret.ts"), p);
      }),
    );
    await expect(
      run(tool, { path: "f.ts", startLine: 1, endLine: 1, newText: "X" }),
    ).rejects.toThrow(/refusing to write/);
    expect(readFileSync(join(outside, "secret.ts"), "utf8")).toBe("SECRET\n");
  });

  it("replace_lines: a leaf swapped for ANOTHER REGULAR FILE is refused, and that file is unchanged", async () => {
    writeFileSync(join(ws, "f.ts"), "l1\nl2\n");
    writeFileSync(join(outside, "other.ts"), "OTHER\n");
    const tool = createReplaceLinesToolDefinition(
      ws,
      swapAt("write", (p) => {
        rmSync(p);
        renameSync(join(outside, "other.ts"), p);
      }),
    );
    await expect(
      run(tool, { path: "f.ts", startLine: 1, endLine: 1, newText: "X" }),
    ).rejects.toThrow(/changed between the check and the open/);
    expect(readFileSync(join(ws, "f.ts"), "utf8")).toBe("OTHER\n");
  });

  it("edit: a leaf swapped for a SYMLINK to an outside file is refused, and the outside file is unchanged", async () => {
    writeFileSync(join(ws, "f.ts"), "l1\nl2\n");
    writeFileSync(join(outside, "secret.ts"), "SECRET\n");
    const tool = createTolerantEditToolDefinition(
      ws,
      swapAt("write", (p) => {
        rmSync(p);
        symlinkSync(join(outside, "secret.ts"), p);
      }),
    );
    await expect(
      run(tool, { path: "f.ts", edits: [{ oldText: "l1", newText: "X" }] }),
    ).rejects.toThrow(/refusing to write/);
    expect(readFileSync(join(outside, "secret.ts"), "utf8")).toBe("SECRET\n");
  });

  it("edit: a leaf swapped for ANOTHER REGULAR FILE between the read and the write is refused", async () => {
    writeFileSync(join(ws, "f.ts"), "l1\nl2\n");
    writeFileSync(join(outside, "other.ts"), "OTHER\n");
    const tool = createTolerantEditToolDefinition(
      ws,
      swapAt("write", (p) => {
        rmSync(p);
        renameSync(join(outside, "other.ts"), p);
      }),
    );
    await expect(
      run(tool, { path: "f.ts", edits: [{ oldText: "l1", newText: "X" }] }),
    ).rejects.toThrow(/refusing to write/);
    expect(readFileSync(join(ws, "f.ts"), "utf8")).toBe("OTHER\n");
  });

  it("simple in-workspace edit and replace_lines paths work (a no-op hook present)", async () => {
    writeFileSync(join(ws, "f.ts"), "l1\nl2\n");
    const edit = createTolerantEditToolDefinition(
      ws,
      swapAt("write", () => {}),
    );
    await run(edit, { path: "f.ts", edits: [{ oldText: "l1", newText: "ONE" }] });
    expect(readFileSync(join(ws, "f.ts"), "utf8")).toBe("ONE\nl2\n");

    const replace = createReplaceLinesToolDefinition(
      ws,
      swapAt("write", () => {}),
    );
    await run(replace, { path: "f.ts", startLine: 2, endLine: 2, newText: "TWO" });
    expect(readFileSync(join(ws, "f.ts"), "utf8")).toBe("ONE\nTWO\n");
  });
});

describe("edit is confined to the workspace root (bob#273)", () => {
  let base: string;
  let ws: string;
  let outside: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "bob-edit-confine-"));
    ws = join(base, "ws");
    outside = join(base, "outside");
    mkdirSync(ws);
    mkdirSync(outside);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("refuses an absolute path outside the workspace root", async () => {
    writeFileSync(join(outside, "out.ts"), "OUT\n");
    const tool = createTolerantEditToolDefinition(ws);
    await expect(
      run(tool, { path: join(outside, "out.ts"), edits: [{ oldText: "OUT", newText: "X" }] }),
    ).rejects.toThrow(/refusing to write/);
    expect(readFileSync(join(outside, "out.ts"), "utf8")).toBe("OUT\n");
  });

  it("an outside-path edit preview request has no file-reading renderer", () => {
    const path = join(outside, "out.ts");
    writeFileSync(path, "OUT\n");
    const tool = createTolerantEditToolDefinition(ws) as {
      renderCall?: (input: unknown) => unknown;
    };
    const request = { path, edits: [{ oldText: "OUT", newText: "X" }] };
    expect(tool.renderCall).toBeUndefined();
    expect(tool.renderCall?.(request)).toBeUndefined();
  });

  it("refuses a `..` escape out of the workspace root", async () => {
    writeFileSync(join(outside, "out.ts"), "OUT\n");
    const tool = createTolerantEditToolDefinition(ws);
    await expect(
      run(tool, { path: "../outside/out.ts", edits: [{ oldText: "OUT", newText: "X" }] }),
    ).rejects.toThrow(/refusing to write/);
    expect(readFileSync(join(outside, "out.ts"), "utf8")).toBe("OUT\n");
  });

  it("refuses a symlink inside the workspace that leaves it", async () => {
    writeFileSync(join(outside, "out.ts"), "OUT\n");
    symlinkSync(join(outside, "out.ts"), join(ws, "link.ts"));
    const tool = createTolerantEditToolDefinition(ws);
    await expect(
      run(tool, { path: "link.ts", edits: [{ oldText: "OUT", newText: "X" }] }),
    ).rejects.toThrow(/refusing to write/);
    expect(readFileSync(join(outside, "out.ts"), "utf8")).toBe("OUT\n");
  });

  it("still edits a file inside the workspace root", async () => {
    writeFileSync(join(ws, "f.ts"), "l1\nl2\n");
    const tool = createTolerantEditToolDefinition(ws);
    await run(tool, { path: "f.ts", edits: [{ oldText: "l1", newText: "ONE" }] });
    expect(readFileSync(join(ws, "f.ts"), "utf8")).toBe("ONE\nl2\n");
  });
});

describe("openVerifiedWriteTarget — the check-to-open race", () => {
  let base: string;
  let ws: string;
  let outside: string;
  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "bob-write-bind-"));
    ws = join(base, "ws");
    outside = join(base, "outside");
    mkdirSync(ws);
    mkdirSync(outside);
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it("a file REPLACED between the check and the open is refused", async () => {
    const target = join(ws, "f.ts");
    writeFileSync(target, "one\n");
    const checked = checkWriteTargetVerified(target, ws);
    writeFileSync(join(outside, "other.ts"), "other\n");
    rmSync(target);
    renameSync(join(outside, "other.ts"), target);
    await expect(openVerifiedWriteTarget(checked, target)).rejects.toThrow(
      /changed between the check and the open/,
    );
  });

  it("a file swapped for a SYMLINK between the check and the open is refused", async () => {
    const target = join(ws, "f.ts");
    writeFileSync(target, "one\n");
    writeFileSync(join(outside, "secret.ts"), "SECRET\n");
    const checked = checkWriteTargetVerified(target, ws);
    rmSync(target);
    symlinkSync(join(outside, "secret.ts"), target);
    await expect(openVerifiedWriteTarget(checked, target)).rejects.toThrow(/refusing to write/);
    expect(readFileSync(join(outside, "secret.ts"), "utf8")).toBe("SECRET\n");
  });

  it("a file changed since the caller's earlier check (expected) is refused", async () => {
    const target = join(ws, "f.ts");
    writeFileSync(target, "one\n");
    const first = checkWriteTargetVerified(target, ws);
    writeFileSync(join(outside, "other.ts"), "two\n");
    rmSync(target);
    renameSync(join(outside, "other.ts"), target);
    const checked = checkWriteTargetVerified(target, ws);
    await expect(
      openVerifiedWriteTarget(checked, target, {
        expected: { dev: first.dev, ino: first.ino },
      }),
    ).rejects.toThrow(/changed between the read and the write/);
  });

  it("an unchanged checked entry opens and is written through the descriptor", async () => {
    const target = join(ws, "f.ts");
    writeFileSync(target, "one\n");
    const checked = checkWriteTargetVerified(target, ws);
    const fh = await openVerifiedWriteTarget(checked, target);
    try {
      const bytes = Buffer.from("NEW\n", "utf-8");
      await fh.truncate(0);
      await fh.write(bytes, 0, bytes.length, 0);
    } finally {
      await fh.close();
    }
    expect(readFileSync(target, "utf8")).toBe("NEW\n");
  });
});
