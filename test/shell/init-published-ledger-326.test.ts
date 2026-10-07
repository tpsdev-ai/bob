// Real-file scaffold publication injections (bob#326).

import { afterAll, afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { initAgent } from "../../src/shell/index.js";
import type { PublishedEntry } from "../../src/shell/init.js";

let agentsRoot: string;
const _dirs: string[] = [];
const spies: Array<{ mockRestore(): void }> = [];
beforeEach(() => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "bob-led-")));
  _dirs.push(base);
  agentsRoot = join(base, "agents");
  mkdirSync(agentsRoot, { recursive: true });
});
afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
});
afterAll(() => {
  for (const d of _dirs) rmSync(d, { recursive: true, force: true });
});

const scaffold = (
  name: string,
  onPublished: (e: PublishedEntry) => void,
  extra: { beforePublish?: (path: string) => void; noClobber?: boolean } = {},
) =>
  initAgent({
    name,
    role: "coder",
    provider: "exe-dev-gateway",
    model: "claude-sonnet-4-6",
    agentsRoot,
    skipFlair: true,
    onPublished,
    ...extra,
  });

// The identity of a file, and its text, from ONE open descriptor (never a stat
// of the path followed by a read of it).
function readEntry(path: string): { ino: bigint; text: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return { ino: fstatSync(fd, { bigint: true }).ino, text: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
}

// Return the recorded inode without coercion.
const ino = (e: PublishedEntry | undefined) => (e?.ino === undefined ? undefined : e.ino);

describe("bob#326 — initAgent records each entry it publishes", () => {
  it("records the agent directory, the sub-directories and every file it created", () => {
    const name = "led-complete";
    const agentDir = join(agentsRoot, name);
    const ledger: PublishedEntry[] = [];
    scaffold(name, (e) => ledger.push(e));

    const expected = [
      agentDir,
      join(agentDir, "bin"),
      join(agentDir, "work"),
      join(agentDir, "memory"),
      join(agentDir, ".pi-agent"),
      join(agentDir, "soul.md"),
      join(agentDir, "bob.yaml"),
      join(agentDir, ".pi-agent", "models.json"),
      join(agentDir, ".pi-agent", "auth.json"),
      join(agentDir, "bin", name),
    ];
    expect(
      ledger
        .filter((e) => e.created !== false && !basename(e.path).endsWith(".tmp"))
        .map((e) => e.path)
        .sort(),
    ).toEqual(expected.slice().sort());
    for (const e of ledger.filter(
      (e) => e.created !== false && !basename(e.path).endsWith(".tmp"),
    )) {
      const st = lstatSync(e.path, { bigint: true });
      expect(st.isDirectory() ? "dir" : "file").toBe(e.kind);
      expect(st.ino).toBe(e.ino);
    }
  });

  it("does not record a path where a competing writer's entry made the publish refuse", () => {
    const name = "led-competitor";
    const agentDir = join(agentsRoot, name);
    const soul = join(agentDir, "soul.md");
    const ledger: PublishedEntry[] = [];

    expect(() =>
      scaffold(name, (e) => ledger.push(e), {
        beforePublish: (path) => {
          if (path === soul) writeFileSync(soul, "another writer\n");
        },
      }),
    ).toThrow(/refusing to write/);

    const paths = ledger.filter((e) => e.created !== false).map((e) => e.path);
    expect(paths).toContain(agentDir);
    expect(paths).toContain(join(agentDir, ".pi-agent"));
    expect(paths).not.toContain(soul);
    expect(readEntry(soul).text).toBe("another writer\n");
  });

  it("records a file's identity from its own temporary file: a replacement at the destination right after the link is not recorded as ours", () => {
    const name = "led-replaced";
    const agentDir = join(agentsRoot, name);
    const soul = join(agentDir, "soul.md");
    const ledger: PublishedEntry[] = [];
    let foreignIno: bigint | undefined;
    const link = fs.linkSync;
    spies.push(
      spyOn(fs, "linkSync").mockImplementation((from, to) => {
        link(from, to);
        if (to === soul && foreignIno === undefined) {
          // Another writer replaces soul.md between its publication and any
          // later look at the destination.
          const tmp = join(agentDir, "writer.tmp");
          writeFileSync(tmp, "another writer's soul\n");
          renameSync(tmp, soul);
          foreignIno = readEntry(soul).ino;
        }
      }),
    );
    scaffold(name, (e) => ledger.push(e));

    const recorded = ledger.find((e) => e.path === soul);
    expect(foreignIno).toBeDefined();
    expect(recorded).toBeDefined();
    expect(ino(recorded)).not.toBe(foreignIno as bigint);
    expect(readEntry(soul).text).toBe("another writer's soul\n");
  });

  it("registers a published file BEFORE its temporary name is cleaned up: a failed cleanup still leaves both names recorded", () => {
    const name = "led-cleanup";
    const agentDir = join(agentsRoot, name);
    const soul = join(agentDir, "soul.md");
    const ledger: PublishedEntry[] = [];
    let failedTemp: string | undefined;
    const rm = fs.rmSync;
    spies.push(
      spyOn(fs, "rmSync").mockImplementation((path, options) => {
        const p = String(path);
        if (failedTemp === undefined && basename(p).startsWith(".soul.md-")) {
          failedTemp = p;
          throw Object.assign(new Error(`EIO: injected cleanup failure, unlink '${p}'`), {
            code: "EIO",
          });
        }
        return rm(path, options);
      }),
    );
    expect(() => scaffold(name, (e) => ledger.push(e))).toThrow(/injected cleanup failure/);

    // soul.md was published (the link succeeded) and is in the ledger with the
    // identity it has on disk; the temporary name, still the same file, is too.
    const published = readEntry(soul);
    expect(ino(ledger.find((e) => e.path === soul))).toBe(published.ino);
    expect(failedTemp).toBeDefined();
    expect(ino(ledger.find((e) => e.path === failedTemp))).toBe(published.ino);
  });

  it("records a competing sub-directory as a parent", () => {
    const name = "led-subdir";
    const agentDir = join(agentsRoot, name);
    const bin = join(agentDir, "bin");
    const ledger: PublishedEntry[] = [];
    let competitorIno: bigint | undefined;
    const mkdir = fs.mkdirSync;
    spies.push(
      spyOn(fs, "mkdirSync").mockImplementation(((path: fs.PathLike, options?: unknown) => {
        if (String(path) === bin && competitorIno === undefined) {
          mkdir(bin);
          competitorIno = lstatSync(bin, { bigint: true }).ino;
        }
        return mkdir(path, options as fs.MakeDirectoryOptions);
      }) as typeof fs.mkdirSync),
    );
    scaffold(name, (e) => ledger.push(e));

    const paths = ledger.filter((e) => e.created !== false).map((e) => e.path);
    expect(competitorIno).toBeDefined();
    expect(paths).not.toContain(bin);
    expect(ledger.find((e) => e.path === bin)?.created).toBe(false);
    // The other levels this call did create are recorded.
    expect(paths).toContain(agentDir);
    expect(paths).toContain(join(agentDir, "work"));
    expect(lstatSync(bin, { bigint: true }).ino).toBe(competitorIno as bigint);
  });

  it("--force: records existing directories as parents and new entries as creations", () => {
    const name = "led-force";
    const agentDir = join(agentsRoot, name);
    mkdirSync(join(agentDir, "bin"), { recursive: true });
    writeFileSync(join(agentDir, "soul.md"), "operator's soul\n");
    const ledger: PublishedEntry[] = [];
    scaffold(name, (e) => ledger.push(e), { noClobber: false });

    const paths = ledger.filter((e) => e.created !== false).map((e) => e.path);
    expect(paths).not.toContain(agentDir);
    expect(paths).not.toContain(join(agentDir, "bin"));
    expect(ledger.find((e) => e.path === agentDir)?.created).toBe(false);
    expect(ledger.find((e) => e.path === join(agentDir, "bin"))?.created).toBe(false);
    for (const sub of ["work", "memory", ".pi-agent"]) expect(paths).toContain(join(agentDir, sub));
    // soul.md was replaced (--force renames a new file over it): the ledger
    // holds the new file's identity.
    expect(ino(ledger.find((e) => e.path === join(agentDir, "soul.md")))).toBe(
      readEntry(join(agentDir, "soul.md")).ino,
    );
  });
});
