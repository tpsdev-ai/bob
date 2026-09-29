// bob#236: changelog fragments. Ported from flair's model; these tests cover the
// issue's acceptance: two PRs adding fragments never conflict; `check` fails on a
// hand-written [Unreleased] entry and on a malformed fragment; `render` is the
// migrated content reordered only by category and filename; `promote` writes a
// dated section and deletes the fragments.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cf from "../scripts/changelog-fragments.mjs";

const NOTE = cf.UNRELEASED_NOTE;
// Whole entries: a `- ` line plus its indented continuation lines and the blank
// lines between them, so a change past an entry's first line is still seen.
function ENTRIES(s: string): string[] {
  const out: string[] = [];
  let cur: string[] | null = null;
  for (const line of s.split("\n")) {
    if (line.startsWith("- ")) {
      if (cur) out.push(cur.join("\n").trimEnd());
      cur = [line];
    } else if (cur && (line.startsWith("  ") || line.trim() === "")) {
      cur.push(line);
    } else if (cur) {
      out.push(cur.join("\n").trimEnd());
      cur = null;
    }
  }
  if (cur) out.push(cur.join("\n").trimEnd());
  return out;
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-fragments-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// A minimal project: a CHANGELOG whose [Unreleased] body is the note (no stray
// entries), and an (empty) fragment dir.
function project(): { dir: string; changelogPath: string } {
  const changelogPath = join(root, "CHANGELOG.md");
  writeFileSync(
    changelogPath,
    `# Changelog\n\n## [Unreleased]\n\n${NOTE}\n\n## [0.0.1] - 2020-01-01\n\nold\n`,
  );
  const dir = join(root, ".changelog", "unreleased");
  mkdirSync(dir, { recursive: true });
  return { dir, changelogPath };
}

function fragment(dir: string, name: string, body: string): void {
  writeFileSync(join(dir, name), body);
}

describe("changelog fragments — check (bob#236)", () => {
  it("passes on a well-formed fragment set", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a-thing.md", "- **A thing was fixed.** Detail.\n");
    const res = cf.check({ dir, changelogPath });
    expect(res).toEqual({ fragments: 1, entries: 1 });
  });

  it("REFUSES a hand-written entry left in [Unreleased]", () => {
    const { dir, changelogPath } = project();
    writeFileSync(
      changelogPath,
      `# Changelog\n\n## [Unreleased]\n\n- a hand-written entry\n\n## [0.0.1] - 2020-01-01\n`,
    );
    expect(() => cf.check({ dir, changelogPath })).toThrow(/hand-written entr/);
  });

  it("REFUSES a fragment whose name is not <category>-<slug>.md", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "nope-thing.md", "- **x.** y.\n");
    expect(() => cf.check({ dir, changelogPath })).toThrow(/not a changelog category/);
  });

  it("REFUSES a fragment with no bold lede", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-no-lede.md", "- a fix with no bold run.\n");
    expect(() => cf.check({ dir, changelogPath })).toThrow(/no bold lede/);
  });

  it("REFUSES a fragment whose bold lede is over the word limit", () => {
    const { dir, changelogPath } = project();
    fragment(
      dir,
      "fixed-long-lede.md",
      `- **${"word ".repeat(cf.LEDE_WORD_LIMIT + 5).trim()}.** x.\n`,
    );
    expect(() => cf.check({ dir, changelogPath })).toThrow(/bold lede is \d+ words/);
  });

  it("REFUSES a fragment body that is not a list item", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-not-list.md", "just some prose\n");
    expect(() => cf.check({ dir, changelogPath })).toThrow(/must start with '- '/);
  });

  it("REFUSES a fragment holding more than one entry", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-two-entries.md", "- **one.** a.\n- **two.** b.\n");
    expect(() => cf.check({ dir, changelogPath })).toThrow(/ONE changelog entry/);
  });

  it("REFUSES an odd continuation indent", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-odd-indent.md", "- **x.** y.\n   three spaces\n");
    expect(() => cf.check({ dir, changelogPath })).toThrow(/continuation indent 3/);
  });

  // Each entry is opened once and judged by its descriptor, not by a separate
  // stat of the path. A link to /dev/null resolves to a character device: the
  // stat-then-read form read it as an empty file and blamed the content.
  it("passes on an empty fragment directory (the state right after `promote`)", () => {
    const { dir, changelogPath } = project();
    expect(cf.check({ dir, changelogPath })).toEqual({ fragments: 0, entries: 0 });
  });

  it("REFUSES an entry that is not a regular file (a directory, a device)", () => {
    const { dir, changelogPath } = project();
    mkdirSync(join(dir, "fixed-a-directory.md"));
    expect(() => cf.check({ dir, changelogPath })).toThrow(/unexpected directory/);
    rmSync(join(dir, "fixed-a-directory.md"), { recursive: true });
    symlinkSync("/dev/null", join(dir, "fixed-a-device.md"));
    expect(() => cf.check({ dir, changelogPath })).toThrow(
      /fixed-a-device\.md: not a regular file/,
    );
  });

  it("REFUSES when CHANGELOG.md has no [Unreleased] header (cannot skip the stray check)", () => {
    const { dir, changelogPath } = project();
    writeFileSync(changelogPath, `# Changelog\n\n## [0.0.1] - 2020-01-01\n`);
    expect(() => cf.check({ dir, changelogPath })).toThrow(/no '## \[Unreleased\]' section/);
  });
});

describe("changelog fragments — render + promote (bob#236)", () => {
  it("render groups by Keep a Changelog category order and by filename within a category", () => {
    const { dir } = project();
    fragment(dir, "fixed-b.md", "- **b.** \n");
    fragment(dir, "fixed-a.md", "- **a.** \n");
    fragment(dir, "added-z.md", "- **z.** \n");
    const section = cf.assemble(cf.readFragments(dir));
    expect(section).toBe(
      ["### Added", "", "- **z.**", "", "### Fixed", "", "- **a.**", "", "- **b.**"].join("\n"),
    );
  });

  it("promote writes a dated section in category order and deletes the fragments", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    fragment(dir, "added-b.md", "- **an addition.** \n");
    const res = cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath });
    expect(res.version).toBe("1.2.3");
    expect(res.date).toBe("2022-01-02");
    expect(res.removed.sort()).toEqual(["added-b.md", "fixed-a.md"]);
    const text = readFileSync(changelogPath, "utf8");
    expect(text).toContain("## [1.2.3] - 2022-01-02");
    expect(text).toContain("### Added\n\n- **an addition.**");
    expect(text).toContain("### Fixed\n\n- **a fix.**");
    // The fragments are gone, and [Unreleased] carries the note again.
    expect(cf.readFragments(dir)).toEqual([]);
    expect(text).toContain("Entries for the next release live as **fragment files**");
  });
});

describe("changelog fragments — the migration (bob#236)", () => {
  // Pinned to fixtures, never the live directory: `promote` empties
  // .changelog/unreleased/ at every release, so a migration test that read it
  // would go red on the release PR. `unreleased-pre-bob-236.md` is the
  // [Unreleased] block before the migration; `migrated-bob-236/` is the fragment
  // set the migration made from it.
  const FIXTURES = join(import.meta.dir, "fixtures", "changelog");
  const before = ENTRIES(readFileSync(join(FIXTURES, "unreleased-pre-bob-236.md"), "utf8"));
  const migrated = cf.readFragments(join(FIXTURES, "migrated-bob-236"));

  // The entries the migration had to repair to pass `check`. Every other entry
  // is byte-for-byte the pre-migration text, so a new difference is a failure
  // rather than an unnoticed extra repair.
  const REPAIRED = [
    // An over-long lede: reshaped.
    {
      fragment: "fixed-17-bob-loads-the-raw-32-byte.md",
      was: "- **bob loads the raw 32-byte seed key",
      repair: "lede",
    },
    // A lede with no closing `**`: reshaped.
    {
      fragment: "fixed-19-a-boolean-flag-bob-onboard-s.md",
      was: "- **A boolean flag — ",
      repair: "lede",
    },
    // A continuation line indented 3 spaces: re-indented to 2, text unchanged.
    {
      fragment: "added-09-the-reachy-capability-jarvis-s3-memory.md",
      was: "- **The `reachy` capability",
      repair: "indent",
    },
  ];

  it("render carries every pre-migration entry verbatim, except the named repairs, each once", () => {
    const rendered = ENTRIES(cf.assemble(migrated));
    expect(rendered.length).toBe(before.length);
    expect(new Set(rendered).size).toBe(rendered.length);
    const notVerbatim = before.filter((e) => !rendered.includes(e));
    // An unnamed difference maps to a string naming the entry: `undefined` would
    // sort last and be ignored by toEqual, so the check could never fire.
    const named = notVerbatim.map(
      (e) =>
        REPAIRED.find((r) => e.startsWith(r.was))?.fragment ?? `not verbatim: ${e.slice(0, 80)}`,
    );
    expect(named.sort()).toEqual(REPAIRED.map((r) => r.fragment).sort());
  });

  it("each repair changed only what it names", () => {
    const spans = (s: string) => s.match(/`[^`]+`/g) ?? [];
    for (const r of REPAIRED) {
      const was = before.find((e) => e.startsWith(r.was));
      const now = migrated.find((f) => f.name === r.fragment)?.body;
      if (was === undefined || now === undefined) throw new Error(`missing: ${r.fragment}`);
      if (r.repair === "indent") {
        expect(now.replace(/^ +/gm, "")).toBe(was.replace(/^ +/gm, ""));
      } else {
        // The lede moved; every code span (command, flag, path, error) stayed.
        for (const span of spans(was)) expect(spans(now)).toContain(span);
      }
    }
  });

  it("render emits ONE heading per category, in Keep a Changelog order", () => {
    const rendered = cf.assemble(migrated);
    const headings = rendered.split("\n").filter((l) => l.startsWith("### "));
    expect(headings).toEqual([...new Set(headings)]); // no duplicates
    const order = headings.map((h) => h.slice(4).toLowerCase());
    const idx = order.map((c) => cf.CATEGORIES.indexOf(c));
    expect(idx).toEqual([...idx].sort((a, b) => a - b)); // KAC order
  });
});

describe("changelog fragments — the live directory (release-safe)", () => {
  // No count is asserted here: every change adds a fragment and every release
  // empties the directory, and an empty directory passes both assertions.
  it("the live fragment directory passes `check`, and no entry renders twice", () => {
    const res = cf.check();
    expect(res.fragments).toBe(res.entries);
    // Resolving a CHANGELOG.md conflict as a union re-adds entries that already
    // live in fragments; converting those again would print them twice.
    const rendered = ENTRIES(cf.assemble(cf.readFragments()));
    expect(new Set(rendered).size).toBe(rendered.length);
  });
});

// Acceptance: two PRs that each add a fragment merge in either order with no
// conflict. Two real branches in a temp git repo, merged both ways.
describe("changelog fragments — two concurrent PRs never conflict (bob#236)", () => {
  function git(cwd: string, ...args: string[]): { code: number; out: string } {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
  }

  function repo(): string {
    const d = join(root, "repo");
    mkdirSync(d, { recursive: true });
    git(d, "init", "-q", "-b", "main");
    git(d, "config", "user.email", "t@t.dev");
    git(d, "config", "user.name", "t");
    writeFileSync(join(d, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n${NOTE}\n`);
    mkdirSync(join(d, ".changelog", "unreleased"), { recursive: true });
    writeFileSync(join(d, ".changelog", "unreleased", "README.md"), "# fragments\n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "base");
    return d;
  }

  it("branch A adds a fragment, branch B adds a different one; merging either order conflicts neither", () => {
    const d = repo();
    git(d, "checkout", "-q", "-b", "a");
    writeFileSync(join(d, ".changelog", "unreleased", "fixed-from-a.md"), "- **a.** \n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "a");
    git(d, "checkout", "-q", "main");
    git(d, "checkout", "-q", "-b", "b");
    writeFileSync(join(d, ".changelog", "unreleased", "added-from-b.md"), "- **b.** \n");
    git(d, "add", "-A");
    git(d, "commit", "-q", "-m", "b");

    // Merge b into a (A first), then the reverse, both clean.
    git(d, "checkout", "-q", "a");
    const m1 = git(d, "merge", "--no-edit", "b");
    expect(m1.code, m1.out).toBe(0);
    git(d, "checkout", "-q", "main");
    git(d, "merge", "--no-edit", "a"); // now main has both
    git(d, "checkout", "-q", "-b", "c", "main~1"); // the pre-merge state on a
    const m2 = git(d, "merge", "--no-edit", "b");
    expect(m2.code, m2.out).toBe(0);

    // Both fragments survive the merge.
    git(d, "checkout", "-q", "a");
    const files = readFileSync(join(d, ".changelog", "unreleased", "added-from-b.md"), "utf8");
    expect(files).toContain("**b.**");
  });
});
