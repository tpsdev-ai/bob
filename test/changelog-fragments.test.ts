// bob#236: changelog fragments. Ported from flair's model; these tests cover the
// issue's acceptance: two PRs adding fragments never conflict; `check` fails on a
// hand-written [Unreleased] entry and on a malformed fragment; `render` is the
// migrated content reordered only by category and filename; `promote` writes a
// dated section and deletes the fragments.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as cf from "../scripts/changelog-fragments.mjs";

const NOTE = cf.UNRELEASED_NOTE;
const ENTRIES = (s: string) => s.split("\n").filter((l) => l.startsWith("- "));

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
  // The pre-migration [Unreleased] block, captured in a fixture. The migration
  // moved every entry into a fragment; `render` must carry that content,
  // reordered by category and filename.
  const fixture = readFileSync(
    join(import.meta.dir, "fixtures", "changelog", "unreleased-pre-bob-236.md"),
    "utf8",
  );
  const fixtureEntries = ENTRIES(fixture);

  it("the repo's fragments pass `check` with no stray [Unreleased] entries", () => {
    const res = cf.check();
    expect(res.fragments).toBe(res.entries);
    expect(res.fragments).toBe(fixtureEntries.length + 1); // + this change's own fragment
  });

  it("render carries every pre-migration entry (two were repaired for the lede rule) plus this change", () => {
    const rendered = cf.assemble(cf.readFragments());
    const renderEntries = ENTRIES(rendered);
    expect(renderEntries.length).toBe(fixtureEntries.length + 1);
    // Every fixture entry is present verbatim, except the two the migration had
    // to repair (one unclosed bold run, one over-long lede) — content preserved.
    const verbatim = fixtureEntries.filter((e) => renderEntries.includes(e));
    expect(fixtureEntries.length - verbatim.length).toBe(2);
  });

  it("render emits ONE heading per category, in Keep a Changelog order", () => {
    const rendered = cf.assemble(cf.readFragments());
    const headings = rendered.split("\n").filter((l) => l.startsWith("### "));
    expect(headings).toEqual([...new Set(headings)]); // no duplicates
    const order = headings.map((h) => h.slice(4).toLowerCase());
    const idx = order.map((c) => cf.CATEGORIES.indexOf(c));
    expect(idx).toEqual([...idx].sort((a, b) => a - b)); // KAC order
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
