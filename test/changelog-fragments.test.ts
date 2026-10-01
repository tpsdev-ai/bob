// bob#236: changelog fragments. Ported from flair's model; these tests cover the
// issue's acceptance: two PRs whose fragments have distinct filenames merge
// cleanly in either order; `check` fails on anything but the managed note under
// [Unreleased] and on a malformed fragment; `render` carries the migrated list
// entries reordered by category and filename, and apart from that order they
// differ only by the twenty-three repairs the migration tests name and the whitespace
// trimmed at the end of each fragment (the block body's two HTML comment
// markers, `<!-- START #221 -->` and `<!-- END #221 -->`, are not list entries
// and do not render); `promote`
// writes a dated section below [Unreleased] and deletes the fragments.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  setDefaultTimeout,
} from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
const CHILD_TIMEOUT_MS = 10_000;
setDefaultTimeout(30_000);

const gitEnv: Record<string, string> = {
  GIT_CONFIG_COUNT: "3",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
  GIT_CONFIG_KEY_2: "core.hooksPath",
  GIT_CONFIG_VALUE_2: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TEMPLATE_DIR: "/dev/null",
};
// Under Bun 1.3.10, a child spawned without an `env` option does not see these
// process.env changes, so the Git helper below and the Node launches of the
// script pass `env: process.env`.
const priorGitEnv = new Map(Object.keys(gitEnv).map((key) => [key, process.env[key]]));
beforeAll(() => {
  for (const [key, value] of Object.entries(gitEnv)) process.env[key] = value;
});
afterAll(() => {
  for (const [key, value] of priorGitEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function gitSync(cwd: string, args: string[]) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: CHILD_TIMEOUT_MS,
    env: process.env,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-fragments-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  expect(existsSync(root), `temporary project survived cleanup: ${root}`).toBe(false);
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

// promote runs only in a git work tree, with CHANGELOG.md and every fragment
// matching the index: make `root` one and stage everything in it.
function stageAll(): void {
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
  ]) {
    const r = gitSync(root, args);
    if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.error ?? r.stderr}`);
  }
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

  it("REFUSES a category prefix that is not lowercase", () => {
    for (const name of ["Fixed-a-thing.md", "FIXED-a-thing.md"]) {
      const { dir, changelogPath } = project();
      fragment(dir, name, "- **A thing was fixed.** Detail.\n");
      expect(() => cf.check({ dir, changelogPath }), name).toThrow(
        `.changelog/unreleased/${name.split("-")[0]}-a-thing.md: '${name.split("-")[0]}' is not a changelog category`,
      );
      rmSync(join(dir, name));
    }
  });

  // A sentence break is `.`, `!` or `?` followed by whitespace; nothing else is
  // counted (the README and the lede error say so).
  it("counts a lede's sentences by a '.', '!' or '?' followed by whitespace, and nothing else", () => {
    expect(cf.countLedeSentences("First.Second.")).toBe(1);
    expect(cf.countLedeSentences("Version 1.2.3 and scripts/x.mjs ship.")).toBe(1);
    expect(cf.countLedeSentences("First. Second.")).toBe(2);
    expect(cf.countLedeSentences("First!\nSecond?")).toBe(2);
    expect(cf.countLedeSentences("First.\tSecond.")).toBe(2);
    expect(cf.countLedeSentences("First.\u00a0Second.")).toBe(2);
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

  it("REFUSES a continuation line that is not indented (it would render outside the entry)", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-flush-left.md", "- **Valid.** Detail\n### Added\n");
    expect(() => cf.check({ dir, changelogPath })).toThrow(
      /fixed-flush-left\.md:2: continuation line is not indented/,
    );
  });

  it("REFUSES an empty bold lede", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-empty-lede.md", "- **** detail\n");
    expect(() => cf.check({ dir, changelogPath })).toThrow(/fixed-empty-lede\.md: empty bold lede/);
  });

  it("passes on an empty fragment directory (the state right after `promote`)", () => {
    const { dir, changelogPath } = project();
    expect(cf.check({ dir, changelogPath })).toEqual({ fragments: 0, entries: 0 });
  });

  it("REFUSES a missing fragment directory rather than reading it as empty", () => {
    const { dir, changelogPath } = project();
    rmSync(dir, { recursive: true });
    expect(() => cf.check({ dir, changelogPath })).toThrow(/unreleased\/: directory not found/);
  });

  it("REFUSES a non-.md extension, naming the file", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed.txt", "- **bad.** ext.\n");
    const beforeBytes = readFileSync(changelogPath);
    const beforeFNames = readdirSync(dir).sort();
    const beforeFRags = readdirSync(dir)
      .map((n) => readFileSync(join(dir, n)))
      .sort();
    expect(() => cf.check({ dir, changelogPath })).toThrow(
      new Error(
        `.changelog/unreleased/fixed.txt: not a .md file. Changelog fragments must be named <category>-<slug>.md (categories: added, changed, deprecated, removed, fixed, security).`,
      ),
    );
    expect(readFileSync(changelogPath)).toEqual(beforeBytes);
    expect(readdirSync(dir).sort()).toEqual(beforeFNames);
    expect(
      readdirSync(dir)
        .map((n) => readFileSync(join(dir, n)))
        .sort(),
    ).toEqual(beforeFRags);
  });
  it("REFUSES a .md filename with no slug, naming the file", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed.md", "- **bad.** no slug.\n");
    const beforeBytes = readFileSync(changelogPath);
    const beforeFNames = readdirSync(dir).sort();
    const beforeFRags = readdirSync(dir)
      .map((n) => readFileSync(join(dir, n)))
      .sort();
    expect(() => cf.check({ dir, changelogPath })).toThrow(
      new Error(
        `.changelog/unreleased/fixed.md: missing the '-<slug>' part. Name it fixed-<something-descriptive>.md.`,
      ),
    );
    expect(readFileSync(changelogPath)).toEqual(beforeBytes);
    expect(readdirSync(dir).sort()).toEqual(beforeFNames);
    expect(
      readdirSync(dir)
        .map((n) => readFileSync(join(dir, n)))
        .sort(),
    ).toEqual(beforeFRags);
  });
  it("REFUSES an empty fragment body (0-byte file), naming the file", () => {
    const { dir, changelogPath } = project();
    writeFileSync(join(dir, "fixed-empty.md"), "");
    const beforeBytes = readFileSync(changelogPath);
    const beforeFNames = readdirSync(dir).sort();
    const beforeFRags = readdirSync(dir)
      .map((n) => readFileSync(join(dir, n)))
      .sort();
    expect(() => cf.check({ dir, changelogPath })).toThrow(
      new Error(
        `.changelog/unreleased/fixed-empty.md: fragment is empty. Write the changelog entry into it, or delete the file.`,
      ),
    );
    expect(readFileSync(changelogPath)).toEqual(beforeBytes);
    expect(readdirSync(dir).sort()).toEqual(beforeFNames);
    expect(
      readdirSync(dir)
        .map((n) => readFileSync(join(dir, n)))
        .sort(),
    ).toEqual(beforeFRags);
  });
  it("REFUSES a tab-indented continuation line, naming the file", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-tab.md", "- **ok.** lede\n\ttab indent\n");
    const beforeBytes = readFileSync(changelogPath);
    const beforeFNames = readdirSync(dir).sort();
    const beforeFRags = readdirSync(dir)
      .map((n) => readFileSync(join(dir, n)))
      .sort();
    expect(() => cf.check({ dir, changelogPath })).toThrow(
      new Error(
        `.changelog/unreleased/fixed-tab.md:2: continuation indent 0; tabs are not allowed; indent continuation lines by an even number of spaces: 2 for the entry, 4 or more for nested content.`,
      ),
    );
    expect(readFileSync(changelogPath)).toEqual(beforeBytes);
    expect(readdirSync(dir).sort()).toEqual(beforeFNames);
    expect(
      readdirSync(dir)
        .map((n) => readFileSync(join(dir, n)))
        .sort(),
    ).toEqual(beforeFRags);
  });

  // Each entry is opened once and judged by its descriptor, not by a separate
  // stat of the path. The open does not block on a FIFO (O_NONBLOCK).
  it("REFUSES an entry that is not a regular file (a directory, a FIFO)", () => {
    const { dir, changelogPath } = project();
    mkdirSync(join(dir, "fixed-a-directory.md"));
    expect(() => cf.check({ dir, changelogPath })).toThrow(/unexpected directory/);
    rmSync(join(dir, "fixed-a-directory.md"), { recursive: true });
    const made = spawnSync("mkfifo", [join(dir, "fixed-a-fifo.md")], {
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
    });
    expect(made.status, made.stderr).toBe(0);
    expect(() => cf.check({ dir, changelogPath })).toThrow(/fixed-a-fifo\.md: not a regular file/);
  });

  it("REFUSES a symbolic link, even to a well-formed fragment outside the directory", () => {
    const { dir, changelogPath } = project();
    const outside = join(root, "elsewhere.md");
    writeFileSync(outside, "- **A well-formed entry.** Detail.\n");
    symlinkSync(outside, join(dir, "fixed-a-link.md"));
    expect(() => cf.check({ dir, changelogPath })).toThrow(/fixed-a-link\.md: a symbolic link/);
  });

  it("REFUSES text other than the managed note under [Unreleased], naming its line", () => {
    const { dir, changelogPath } = project();
    writeFileSync(
      changelogPath,
      `# Changelog\n\n## [Unreleased]\n\n${NOTE}\n\nA hand-written paragraph.\n\n## [0.0.1] - 2020-01-01\n`,
    );
    // Lines 1-4 are the title, a blank, the header and a blank; the note follows,
    // then a blank, then the paragraph.
    const line = 4 + NOTE.split("\n").length + 2;
    expect(() => cf.check({ dir, changelogPath })).toThrow(
      `holds text other than the managed note (line ${line}: A hand-written paragraph.)`,
    );
  });

  it("REFUSES an [Unreleased] heading that is not exactly '## [Unreleased]', in check and in promote", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    for (const heading of [
      "## [Unreleased] - next",
      "## [unreleased]",
      "## [Unreleased] ",
      "## [Unreleased]\t",
      "##  [Unreleased]",
      " ## [Unreleased]",
      "   ## [Unreleased]",
      "## [Unreleased",
      "##[Unreleased]",
    ]) {
      const text = `# Changelog\n\n${heading}\n\n${NOTE}\n\n## [0.0.1] - 2020-01-01\n`;
      writeFileSync(changelogPath, text);
      const shown = JSON.stringify(heading);
      expect(() => cf.check({ dir, changelogPath }), shown).toThrow(
        `line 3 is ${shown}, not exactly '## [Unreleased]'`,
      );
      expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath }), shown).toThrow(
        `line 3 is ${shown}, not exactly '## [Unreleased]'`,
      );
      expect(readFileSync(changelogPath, "utf8")).toBe(text);
      expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
    }
  });

  // A second candidate can hide the entry under it from the note check: before
  // the exact heading its section is never read, and after it a candidate at
  // column one ends the section being read (an indented one leaves the entry
  // inside that section, where the note check would refuse it). Either way the
  // duplicate is refused first.
  it("REFUSES a second [Unreleased] heading hiding an entry, before or after the exact one, in check and in promote", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const noteLines = NOTE.split("\n").length;
    for (const second of [
      "## [Unreleased]",
      " ## [Unreleased]",
      "   ## [unreleased]",
      "## [Unreleased] - more",
      "## [Unreleased",
    ]) {
      const hidden = `${second}\n\n- a hidden entry\n\n`;
      const exact = `## [Unreleased]\n\n${NOTE}\n\n`;
      for (const [where, body, lines] of [
        ["before", hidden + exact, "3, 7"],
        ["after", exact + hidden, `3, ${4 + noteLines + 2}`],
      ] as const) {
        const text = `# Changelog\n\n${body}## [0.0.1] - 2020-01-01\n`;
        writeFileSync(changelogPath, text);
        const label = `${JSON.stringify(second)} ${where}`;
        const msg = `2 [Unreleased] headings (lines ${lines})`;
        expect(() => cf.check({ dir, changelogPath }), label).toThrow(msg);
        expect(
          () => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath }),
          label,
        ).toThrow(msg);
        expect(readFileSync(changelogPath, "utf8")).toBe(text);
        expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
      }
    }
  });

  it("REFUSES when CHANGELOG.md has no [Unreleased] header (cannot skip the stray check)", () => {
    const { dir, changelogPath } = project();
    writeFileSync(changelogPath, `# Changelog\n\n## [0.0.1] - 2020-01-01\n`);
    expect(() => cf.check({ dir, changelogPath })).toThrow(/no '## \[Unreleased\]' heading/);
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
    stageAll();
    const res = cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath });
    expect(res.version).toBe("1.2.3");
    expect(res.date).toBe("2022-01-02");
    expect(res.removed.sort()).toEqual(["added-b.md", "fixed-a.md"]);
    const text = readFileSync(changelogPath, "utf8");
    expect(text).toContain("## [1.2.3] - 2022-01-02");
    expect(text).toContain("### Added\n\n- **an addition.**");
    expect(text).toContain("### Fixed\n\n- **a fix.**");
    // The fragments are gone, and [Unreleased] carries the note again: the
    // result passes `check`.
    expect(cf.readFragments(dir)).toEqual([]);
    expect(text).toContain("Entries for the next release live as **fragment files**");
    expect(cf.check({ dir, changelogPath })).toEqual({ fragments: 0, entries: 0 });
  });

  it("promote REFUSES text other than the managed note under [Unreleased], and writes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const before = `# Changelog\n\n## [Unreleased]\n\n${NOTE}\n\nA hand-written paragraph.\n\n## [0.0.1] - 2020-01-01\n`;
    writeFileSync(changelogPath, before);
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(
      /promote: '## \[Unreleased\]' holds text other than the managed note/,
    );
    expect(readFileSync(changelogPath, "utf8")).toBe(before);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  it("promote REFUSES a --date that is not a real YYYY-MM-DD, and writes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const before = readFileSync(changelogPath, "utf8");
    for (const date of ["2022-1-2", "2022-02-30", "", "tomorrow"]) {
      expect(() => cf.promote("1.2.3", { date, dir, changelogPath })).toThrow(/invalid --date/);
    }
    expect(readFileSync(changelogPath, "utf8")).toBe(before);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  it("promote REFUSES a version outside MAJOR.MINOR.PATCH[-pre-release] or with a leading zero, and writes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const before = readFileSync(changelogPath, "utf8");
    for (const v of [
      "01.2.3",
      "1.02.3",
      "1.2.03",
      "1.2.3-rc.01",
      "1.2.3+build",
      "1.2.3-",
      "1.2.3-rc..1",
      "v1.2.3",
    ]) {
      expect(() => cf.promote(v, { date: "2022-01-02", dir, changelogPath }), v).toThrow(
        /invalid version/,
      );
    }
    expect(readFileSync(changelogPath, "utf8")).toBe(before);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  it("the version format accepts plain and pre-release versions", () => {
    for (const v of [
      "0.0.0",
      "0.31.0",
      "10.20.30",
      "1.0.0-rc.1",
      "1.2.3-alpha",
      "1.2.3-0",
      "1.2.3-x.7.z.92",
    ]) {
      expect(cf.isReleaseVersion(v), v).toBe(true);
    }
  });

  it("promote REFUSES a version that already has a section, and writes nothing", () => {
    const { dir, changelogPath } = project(); // carries '## [0.0.1] - 2020-01-01'
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const before = readFileSync(changelogPath, "utf8");
    expect(() => cf.promote("0.0.1", { date: "2022-01-02", dir, changelogPath })).toThrow(
      /already has a '## \[0\.0\.1\]' section \(line \d+\)/,
    );
    expect(readFileSync(changelogPath, "utf8")).toBe(before);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  it("promote REFUSES outside a git work tree, and writes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const before = readFileSync(changelogPath, "utf8");
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(
      /is not in a git work tree/,
    );
    expect(readFileSync(changelogPath, "utf8")).toBe(before);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  // git checkout restores from the index: a file that is not there, or differs
  // from it, could not be restored as it was, so promote touches nothing.
  it("promote REFUSES what git could not restore (untracked, or differing from the index), naming each, and writes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    fragment(dir, "fixed-b.md", "- **b fix.** \n");
    stageAll();
    fragment(dir, "fixed-new.md", "- **a new fragment, never staged.** \n");
    fragment(dir, "fixed-b.md", "- **b fix, edited after staging.** \n");
    const before = readFileSync(changelogPath, "utf8");
    const names = () =>
      cf
        .readFragments(dir)
        .map((f) => f.name)
        .sort();
    const tryPromote = () => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath });
    expect(tryPromote).toThrow(
      "untracked (not in the index): fixed-new.md; changed since staged (differs from the index): fixed-b.md",
    );
    expect(readFileSync(changelogPath, "utf8")).toBe(before);
    expect(names()).toEqual(["fixed-a.md", "fixed-b.md", "fixed-new.md"]);

    // CHANGELOG.md edited after staging, then CHANGELOG.md not in the index.
    stageAll();
    const edited = `${before}\na local edit in an old section\n`;
    writeFileSync(changelogPath, edited);
    expect(tryPromote).toThrow("changed since staged (differs from the index): CHANGELOG.md");
    expect(readFileSync(changelogPath, "utf8")).toBe(edited);
    stageAll();
    const rm = gitSync(root, ["rm", "-q", "--cached", "CHANGELOG.md"]);
    expect(rm.status, rm.stderr).toBe(0);
    expect(tryPromote).toThrow("untracked (not in the index): CHANGELOG.md");
    expect(readFileSync(changelogPath, "utf8")).toBe(edited);
    expect(names()).toEqual(["fixed-a.md", "fixed-b.md", "fixed-new.md"]);
  });

  // Every file is decoded as fatal UTF-8: bytes that are not valid UTF-8 are
  // refused by name, never read as U+FFFD and passed or written back.
  it("REFUSES a fragment that is not valid UTF-8, naming it, in check and in promote, and writes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    writeFileSync(
      join(dir, "fixed-bad-utf8.md"),
      Buffer.concat([Buffer.from("- **OK.** "), Buffer.from([0xff]), Buffer.from("\n")]),
    );
    stageAll();
    const before = readFileSync(changelogPath);
    const msg = ".changelog/unreleased/fixed-bad-utf8.md: not valid UTF-8";
    expect(() => cf.check({ dir, changelogPath })).toThrow(msg);
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(msg);
    expect(readFileSync(changelogPath).equals(before)).toBe(true);
    expect(readdirSync(dir).sort()).toEqual(["fixed-a.md", "fixed-bad-utf8.md"]);
  });

  it("promote REFUSES no fragments in the directory, and writes nothing", () => {
    const { dir, changelogPath } = project();
    stageAll();
    const beforeBytes = readFileSync(changelogPath);
    const beforeFNames = cf
      .readFragments(dir)
      .map((f) => f.name)
      .sort();
    const beforeFRags = readdirSync(dir)
      .map((n) => readFileSync(join(dir, n)))
      .sort();
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(
      new Error(
        `promote: no fragments in .changelog/unreleased/ — refusing to cut v1.2.3 with an empty changelog section. Add the entries for this release before running the release step.`,
      ),
    );
    expect(readFileSync(changelogPath)).toEqual(beforeBytes);
    expect(
      cf
        .readFragments(dir)
        .map((f) => f.name)
        .sort(),
    ).toEqual(beforeFNames);
    expect(
      readdirSync(dir)
        .map((n) => readFileSync(join(dir, n)))
        .sort(),
    ).toEqual(beforeFRags);
  });
  it("promote REFUSES git ls-files failure and writes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    stageAll();
    // Replace the default index path (.git/index) with a directory so ls-files fails regardless of file permissions.
    const index = join(root, ".git", "index");
    const save = `${index}.save`;
    renameSync(index, save);
    mkdirSync(index, { recursive: true });
    try {
      const beforeBytes = readFileSync(changelogPath);
      const beforeFNames = readdirSync(dir).sort();
      const beforeFRags = readdirSync(dir).map((n) => readFileSync(join(dir, n)));
      expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(
        new Error(
          `promote: git ls-files failed, so nothing was written; repair the Git index or its environment until ls-files succeeds, then retry promote.`,
        ),
      );
      expect(readFileSync(changelogPath)).toEqual(beforeBytes);
      expect(readdirSync(dir).sort()).toEqual(beforeFNames);
      const afterFRags = readdirSync(dir).map((n) => readFileSync(join(dir, n)));
      expect(afterFRags).toEqual(beforeFRags);
    } finally {
      rmSync(index, { recursive: true, force: true });
      renameSync(save, index);
    }
  });

  it("REFUSES a CHANGELOG.md that is not valid UTF-8, in check and in promote, and writes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const bad = Buffer.concat([readFileSync(changelogPath), Buffer.from([0xff, 0x0a])]);
    writeFileSync(changelogPath, bad);
    stageAll();
    expect(() => cf.check({ dir, changelogPath })).toThrow("CHANGELOG.md: not valid UTF-8");
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(
      "CHANGELOG.md: not valid UTF-8",
    );
    expect(readFileSync(changelogPath).equals(bad)).toBe(true);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  // git checkout restores a tracked LINK, not the file it points at, so a
  // CHANGELOG.md that is a symbolic link is refused before any read or write.
  it("REFUSES a CHANGELOG.md that is a tracked symbolic link, in check and in promote, and changes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const external = mkdtempSync(join(tmpdir(), "bob-fragments-ext-"));
    try {
      const target = join(external, "CHANGELOG.md");
      writeFileSync(target, readFileSync(changelogPath));
      rmSync(changelogPath);
      symlinkSync(target, changelogPath);
      stageAll();
      const commit = gitSync(root, [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@t.dev",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "base",
      ]);
      expect(commit.status, commit.stderr).toBe(0);
      const targetBefore = readFileSync(target);
      const msg = "CHANGELOG.md is a symbolic link";
      expect(() => cf.check({ dir, changelogPath })).toThrow(msg);
      expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(msg);
      expect(readFileSync(target).equals(targetBefore)).toBe(true);
      expect(lstatSync(changelogPath).isSymbolicLink()).toBe(true);
      expect(readlinkSync(changelogPath)).toBe(target);
      expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
    } finally {
      rmSync(external, { recursive: true, force: true });
      expect(existsSync(external), `external target survived cleanup: ${external}`).toBe(false);
    }
  });

  // A truncating write would change every hard link of CHANGELOG.md, and git
  // checkout restores only this path, so a second link is refused.
  it("REFUSES a CHANGELOG.md with another hard link, in check and in promote, and changes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const other = join(root, "other-link-to-CHANGELOG.md");
    linkSync(changelogPath, other);
    stageAll();
    const before = readFileSync(other);
    const msg = "CHANGELOG.md has 2 hard links";
    expect(() => cf.check({ dir, changelogPath })).toThrow(msg);
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(msg);
    expect(readFileSync(other).equals(before)).toBe(true);
    expect(readFileSync(changelogPath).equals(before)).toBe(true);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  it("REFUSES a CHANGELOG.md that is not a regular file (a directory), in check and in promote", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    rmSync(changelogPath);
    mkdirSync(changelogPath);
    const msg = "CHANGELOG.md is not a regular file";
    expect(() => cf.check({ dir, changelogPath })).toThrow(msg);
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(msg);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  // The write reopens CHANGELOG.md without following a link and writes only if
  // the file it opened has the same device and inode as the file that was read,
  // so a link or a file with another device or inode swapped in fails.
  it("writeChangelog REFUSES a link swapped in after the read, and writes nothing through it", () => {
    const { changelogPath } = project();
    const read = cf.readChangelog(changelogPath);
    const moved = join(root, "moved-CHANGELOG.md");
    renameSync(changelogPath, moved);
    symlinkSync(moved, changelogPath);
    const before = readFileSync(moved);
    expect(() => cf.writeChangelog(changelogPath, "replaced\n", read)).toThrow(
      "CHANGELOG.md is a symbolic link",
    );
    expect(readFileSync(moved).equals(before)).toBe(true);
  });

  it("writeChangelog REFUSES a different regular file swapped in after the read, and writes nothing", () => {
    const { changelogPath } = project();
    const read = cf.readChangelog(changelogPath);
    renameSync(changelogPath, join(root, "moved-CHANGELOG.md"));
    writeFileSync(changelogPath, "another file\n");
    expect(() => cf.writeChangelog(changelogPath, "replaced\n", read)).toThrow(
      "CHANGELOG.md was replaced after it was read",
    );
    expect(readFileSync(changelogPath, "utf8")).toBe("another file\n");
  });

  // Device and inode are compared as BigInt: as numbers, 2^53 and 2^53+1 are
  // equal, so a different file with an adjacent high inode would pass. Driven
  // through promote's stat seam, the write must refuse before truncating
  // CHANGELOG.md or deleting a fragment.
  it("promote REFUSES a CHANGELOG.md whose inode differs only above 2^53 (2^53 read, 2^53+1 at write), and changes nothing", () => {
    const { dir, changelogPath } = project();
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    stageAll();
    const before = readFileSync(changelogPath);
    let calls = 0;
    const fstat = (fd: number) => {
      const real = fstatSync(fd, { bigint: true });
      calls += 1;
      return {
        isFile: () => real.isFile(),
        nlink: 1n,
        dev: 7n,
        ino: calls === 1 ? 2n ** 53n : 2n ** 53n + 1n,
      };
    };
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath, fstat })).toThrow(
      "CHANGELOG.md was replaced after it was read",
    );
    expect(calls).toBe(2);
    expect(readFileSync(changelogPath).equals(before)).toBe(true);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
  });

  // An index flag hides an edit from `git ls-files -m`, so promote also compares
  // the raw bytes of each file it would change or delete with its index blob.
  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    it(`promote REFUSES an edit hidden by ${flag}, in a fragment and in CHANGELOG.md, and changes nothing`, () => {
      const { dir, changelogPath } = project();
      const original = "- **a fix.** \n";
      fragment(dir, "fixed-a.md", original);
      stageAll();
      const gitIn = (...args: string[]) => gitSync(root, args);
      const tryPromote = () => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath });

      // A hidden edit to a fragment.
      expect(gitIn("update-index", flag, ".changelog/unreleased/fixed-a.md").status).toBe(0);
      fragment(dir, "fixed-a.md", "- **a fix, edited behind the index flag.** \n");
      expect(gitIn("ls-files", "-m").stdout).toBe(""); // the flag hides it from ls-files -m
      const changelogBefore = readFileSync(changelogPath);
      const edited = readFileSync(join(dir, "fixed-a.md"));
      expect(tryPromote).toThrow("changed since staged (differs from the index): fixed-a.md");
      expect(readFileSync(changelogPath).equals(changelogBefore)).toBe(true);
      expect(readFileSync(join(dir, "fixed-a.md")).equals(edited)).toBe(true);

      // A hidden edit to CHANGELOG.md, with the fragment back to its staged bytes.
      fragment(dir, "fixed-a.md", original);
      expect(gitIn("update-index", flag, "CHANGELOG.md").status).toBe(0);
      const changelogEdited = Buffer.concat([
        changelogBefore,
        Buffer.from("\na local edit in an old section\n"),
      ]);
      writeFileSync(changelogPath, changelogEdited);
      expect(gitIn("ls-files", "-m").stdout).toBe("");
      expect(tryPromote).toThrow("changed since staged (differs from the index): CHANGELOG.md");
      expect(readFileSync(changelogPath).equals(changelogEdited)).toBe(true);
      expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
    });
  }

  // A filtered hash can miss a raw edit: with core.autocrlf=input, a CRLF rewrite
  // of an LF fragment hashes like the original, and the CRLF body still passes
  // validation. promote also compares raw bytes, so it refuses the rewrite.
  it("promote REFUSES a hidden CRLF rewrite that a filtered hash would miss (core.autocrlf=input), and changes nothing", () => {
    const { dir, changelogPath } = project();
    const lf = "- **a fix.** Detail.\n";
    fragment(dir, "fixed-a.md", lf);
    stageAll();
    const gitIn = (...args: string[]) => gitSync(root, args);
    const rel = ".changelog/unreleased/fixed-a.md";
    expect(gitIn("config", "core.autocrlf", "input").status).toBe(0);
    expect(gitIn("update-index", "--assume-unchanged", rel).status).toBe(0);
    const crlf = Buffer.from(lf.replace(/\n/g, "\r\n"));
    writeFileSync(join(dir, "fixed-a.md"), crlf);
    // The premise: ls-files -m sees nothing, the filtered hash equals the index
    // blob, and only the raw hash differs.
    expect(gitIn("ls-files", "-m").stdout).toBe("");
    const blob = gitIn("ls-files", "-s", "--", rel).stdout.split(" ")[1];
    expect(gitIn("hash-object", "--", rel).stdout.trim()).toBe(blob);
    expect(gitIn("hash-object", "--no-filters", "--", rel).stdout.trim()).not.toBe(blob);
    const changelogBefore = readFileSync(changelogPath);
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(
      "changed since staged (differs from the index): fixed-a.md",
    );
    expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(
      "promote also compares raw bytes with the index",
    );
    expect(readFileSync(changelogPath).equals(changelogBefore)).toBe(true);
    expect(readFileSync(join(dir, "fixed-a.md")).equals(crlf)).toBe(true);
  });

  // Permission bits do not bind root, so these two cannot fail a write as root.
  const asRoot = process.getuid?.() === 0;

  it.skipIf(asRoot)(
    "promote that cannot write CHANGELOG.md deletes no fragment and says how to recover",
    () => {
      const { dir, changelogPath } = project();
      fragment(dir, "fixed-a.md", "- **a fix.** \n");
      stageAll();
      chmodSync(changelogPath, 0o444);
      try {
        expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(
          /could not write CHANGELOG\.md \(EACCES\); no fragment was deleted/,
        );
      } finally {
        chmodSync(changelogPath, 0o644);
      }
      expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
    },
  );

  it.skipIf(asRoot)(
    "promote that cannot delete a fragment names it and says how to recover",
    () => {
      const { dir, changelogPath } = project();
      fragment(dir, "fixed-a.md", "- **a fix.** \n");
      stageAll();
      chmodSync(dir, 0o555);
      try {
        expect(() => cf.promote("1.2.3", { date: "2022-01-02", dir, changelogPath })).toThrow(
          /is written to CHANGELOG\.md, but 1 fragment\(s\) could not be deleted: fixed-a\.md \(EACCES\)/,
        );
      } finally {
        chmodSync(dir, 0o755);
      }
      expect(readFileSync(changelogPath, "utf8")).toContain("## [1.2.3] - 2022-01-02");
    },
  );
});

describe("changelog fragments — the migration (bob#236)", () => {
  // Pinned to fixtures, never the live directory: `promote` empties
  // .changelog/unreleased/ at every release, so a migration test that read it
  // would go red on the release PR. `unreleased-main-fff78d6a.md` is the body
  // of main's [Unreleased] block (its heading excluded) at fff78d6a, the main
  // commit whose entries were migrated, before they moved into fragments;
  // `migrated-bob-236/` is the fragment set made from it, every list entry of
  // that body included.
  const FIXTURES = join(import.meta.dir, "fixtures", "changelog");
  const before = ENTRIES(readFileSync(join(FIXTURES, "unreleased-main-fff78d6a.md"), "utf8"));
  const migrated = cf.readFragments(join(FIXTURES, "migrated-bob-236"));

  // The twenty-three entries the migration changed, each as EXACT edits of main's text
  // (applied in order, each `from` found exactly once) plus every word that
  // disappears from the entry (`dropped`). Five were changed to pass `check`
  // (fixed-17, fixed-19, added-09, fixed-bob225, fixed-bob228; fixed-19 was also corrected), and eighteen more were
  // corrected because they no longer matched bob's code or the rendered order,
  // most of them because code merged after they were written changed what they
  // describe.
  // Every other entry is main's text unchanged (whitespace at its end aside). A
  // new difference, or a word that vanishes without being listed, fails. That
  // detects unlisted vanished words; it does not prove every fact is preserved (a
  // rewrite that removes no word, such as swapping two names, would pass).
  type Repair = {
    fragment: string;
    was: string;
    why: string;
    edits: [string, string][];
    dropped: string[];
  };
  const REPAIRED: Repair[] = [
    {
      fragment: "fixed-17-bob-loads-the-raw-32-byte.md",
      was: "- **bob loads the raw 32-byte seed key",
      why: "An over-long lede, reshaped; every fact kept.",
      edits: [
        [
          "- **bob loads the raw 32-byte seed key Flair writes (and base64 of it), as well as base64 PKCS8 and PEM, and a malformed key fails with the file, its size and the accepted formats.**",
          "- **bob loads every key shape Flair writes, and a malformed key fails naming the file, its size and the accepted formats.** It accepts the raw 32-byte seed key Flair writes (and base64 of it), as well as base64 PKCS8 and PEM.",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "fixed-19-a-boolean-flag-bob-onboard-s.md",
      was: "- **A boolean flag — ",
      why: "A lede with no closing `**`, reshaped; and parsing `bob run --interactive` is not support for it.",
      edits: [
        [
          "- **A boolean flag — `bob onboard`'s",
          "- **A boolean flag is validated while the command line is parsed, before any command runs.** `bob onboard`'s",
        ],
        [
          "and `bob run`'s `--interactive` — is validated as the command line is parsed, before any command runs: it is on when written bare or as `=true`, off as `=false`, and every other spelling",
          "and `bob run`'s `--interactive`, parse as on when written bare or as `=true` and off as `=false`, and every other spelling",
        ],
        [
          "is a usage error with exit code 2, so a bad spelling never runs the real command and a boolean flag",
          "is a usage error with exit code 2; a bad spelling never runs the real command, and a boolean flag",
        ],
        [
          "keeps `testbot` as the name). (`test/shell/argv.test.ts`",
          "keeps `testbot` as the name). Parsing is not support: `bob run` refuses `--interactive` when it is on, with exit code 2, because its interactive mode does not exist on the embedded-SDK path yet. (`test/shell/argv.test.ts`",
        ],
      ],
      dropped: ["so"],
    },
    {
      fragment: "added-09-the-reachy-capability-jarvis-s3-memory.md",
      was: "- **The `reachy` capability",
      why: "A continuation line indented 3 spaces, re-indented to 2.",
      edits: [["\n   OrgEvent record id is", "\n  OrgEvent record id is"]],
      dropped: [],
    },
    {
      fragment: "fixed-bob225-mid-run-checkpoint-latch-and-doctor-context-window.md",
      was: "- **After a mid-run compaction checkpoint",
      why: "An over-long lede (36 words), reshaped; the text it moved opens the body, and no word is dropped.",
      edits: [
        [
          "- **After a mid-run compaction checkpoint, over-threshold tool turns do not checkpoint again for the same threshold until a valid reading at or below the threshold re-arms the check, and `bob doctor` reports a missing `provider.context_window` (bob#225).**",
          "- **After a mid-run compaction checkpoint, the check does not checkpoint again for that threshold until it re-arms, and `bob doctor` reports a missing `provider.context_window` (bob#225).** Over-threshold tool turns do not checkpoint again for the same threshold until a valid reading at or below the threshold re-arms the check.",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "fixed-bob228-install-service-writes-a-stable-node-path.md",
      was: "- **`bob install-service` run from an interpreter named `node` writes",
      why: 'An over-long lede (33 words, two sentences by the check\'s count: "e.g. " is a break), reshaped; the text it moved opens the body, and no word is dropped.',
      edits: [
        [
          "- **`bob install-service` run from an interpreter named `node` writes that interpreter's own path unless a trusted PATH symlink resolves to the same file, e.g. `/opt/homebrew/bin/node` instead of a versioned Homebrew Cellar path (bob#228).**",
          "- **`bob install-service` run from an interpreter named `node` writes that interpreter's own path unless a trusted PATH symlink resolves to the same file (bob#228).** It writes, e.g., `/opt/homebrew/bin/node` instead of a versioned Homebrew Cellar path.",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "added-07-the-anchored-edit-capability-and-the.md",
      was: "- **The `anchored-edit` capability and the `builder-local` role",
      why: "builder-local holds the `work` run tools, not `bash` (roles/builder-local/role.json).",
      edits: [
        [
          "plus `bash`, `grep`, `find`, `ls` and the flair tools,",
          "plus the `work` capability's `run`, `run_status` and `run_cancel` (it holds no `bash`), `grep`, `find`, `ls` and the flair tools,",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "fixed-04-a-resident-agent-keeps-a-tool.md",
      was: "- **A resident agent keeps a tool only when",
      why: "The resident rule's exception: a role that opts in keeps its writers. Then #247 added a fourth class, egress, with its own resident web grant.",
      edits: [
        [
          "- **A resident agent keeps a tool only when a reviewed classification says it writes no file and runs no command (bob#213).**",
          "- **Unless its role opts in, a resident agent keeps only the tools a reviewed classification says write no file and run no command (bob#213).**",
        ],
        [
          "no longer keeps them; builder-local, the one shipped role that lists them, opts in.",
          "no longer keeps them. A role that sets `tools.allowResidentShell: true` keeps its writers for a resident agent (the agent's `bob.yaml` can turn that off, not on); builder-local, the one shipped role that lists the anchored-edit writers, opts in, and so does coder.",
        ],
        [
          "`writer` (writes a file the model names, or runs a command) or `effect` (a memory write, a Discord post or reaction, a status report, a robot action, cancelling a job this run started).",
          "`writer` (writes a file the model names, or runs a command), `effect` (a memory write, a Discord post or reaction, a status report, a robot action, cancelling a job this run started) or `egress` (a web tool that sends model-influenced data outside the office; a resident agent drops it unless its role sets `tools.allowResidentWeb`, which the shell opt-in does not cover).",
        ],
      ],
      dropped: ["when"],
    },
    {
      fragment: "changed-09-onboarding-and-alignment-ran-under-a.md",
      was: "- **Onboarding and alignment ran under a FIXED setup policy",
      why: 'render puts Changed before Fixed, so "above" pointed the wrong way.',
      edits: [["(Fixed, above)", "(under Fixed)"]],
      dropped: ["above"],
    },
    {
      fragment: "changed-11-stated-limits-of-the-contract-above.md",
      was: "- **Stated limits of the contract above.**",
      why: '"the contract above" meant the task contract, which renders under Added. Then scoped to the run\'s own agent requests (#243).',
      edits: [
        [
          "- **Stated limits of the contract above.**",
          "- **Stated limits of the system-prompt task contract (under Added).**",
        ],
        [
          "AND in every agent request's system prompt, so it costs tokens per request",
          "AND in the system prompt of every agent request the run makes, so it costs tokens per request",
        ],
      ],
      dropped: ["above", "request's"],
    },
    {
      fragment: "changed-06-role-json-is-the-ceiling-on.md",
      was: "- **`role.json` is the ceiling on the tool allowlist",
      why: "`bash`/`write`/`edit` are the coder role's set; builder-local holds `run` and the anchored-edit writers. Then scoped to agent runtime sessions (#243), and the web tools' own resident opt-in, allowResidentWeb (#247), is named.",
      edits: [
        [
          "the coder role sets it `true`, so a persistent builder keeps `bash`/`write`/`edit` while no `bob.yaml` can grant itself a shell its role does not allow.",
          "the `coder` role sets it `true`, so a persistent agent of the `coder` role keeps `bash`/`write`/`edit` (builder-local sets it too, and keeps `run` and the anchored-edit writers instead), while no `bob.yaml` can grant itself a shell its role does not allow.",
        ],
        [
          "and it is read at session creation.**",
          "and it is read when each agent runtime session is created.**",
        ],
        [
          "The resident opt-in lives in the role schema as `tools.allowResidentShell` —",
          "The resident shell opt-in lives in the role schema as `tools.allowResidentShell` (the web tools have their own, `tools.allowResidentWeb`; see the data-classes entry under Added) —",
        ],
      ],
      dropped: ["at", "builder", "creation"],
    },
    {
      fragment: "changed-10-readme-usage-section-matches-the-cli.md",
      was: "- **README usage section matches the CLI.**",
      why: "The README stopped advertising an interactive `bob run` mode; the CLI parses `--interactive` and refuses it only when it is on.",
      edits: [
        [
          "The usage section no longer names commands or flags the CLI does not have: `bob serve`",
          "The usage section no longer advertises what the CLI does not support: `bob serve`",
        ],
        [
          "`--interactive` (the CLI rejects it),",
          "an interactive `bob run` mode (`bob run` parses `--interactive` but refuses it when it is on),",
        ],
        [
          "and fails if the retired `--interactive` flag appears as a word in a code span or code fence;",
          "and fails if a README code span or code fence holds `--interactive`, bare or as `--interactive=<value>`, as a token split on whitespace and commas, since the interactive `bob run` mode is unsupported;",
        ],
      ],
      dropped: ["appears", "flag", "flags", "have", "retired", "word"],
    },
    {
      fragment: "changed-04-one-session-factory-bob-never-spawns.md",
      was: "- **ONE session factory — bob never spawns pi and ne",
      why: "bob login/logout (bob#241, #243) start pi's TUI outside the factory; the claims are scoped to agent runtime sessions and the exception is stated here once.",
      edits: [
        [
          "- **ONE session factory — bob never spawns pi and never builds a pi command line.**",
          "- **ONE session factory builds every agent runtime session, and bob never spawns pi or builds a pi command line for one.**",
        ],
        [
          "Every session — `bob run`, the persistent runtime,",
          "Every agent runtime session — `bob run`, the persistent runtime,",
        ],
        [
          "so no caller-controlled argument reaches the session. (`test/shell/launch.test.ts`",
          "so no caller-controlled argument reaches the session. `bob login` and `bob logout` (bob#241, under Added) are the exception: they start pi's own TUI as a separate process, with no arguments and an allowlisted environment, outside the factory and outside these controls, for the operator to sign in or out. (`test/shell/launch.test.ts`",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "changed-05-a-session-s-resources-are-built.md",
      was: "- **A session's resources are built by bob, isolated",
      why: "Scoped to agent runtime sessions: bob login/logout (#243) run pi's own TUI, which is not built by bob.",
      edits: [
        [
          "- **A session's resources are built by bob, isolated.**",
          "- **An agent runtime session's resources are built by bob, isolated.**",
        ],
        ["no longer load for bob agents.**", "no longer load in a bob agent's runtime sessions.**"],
      ],
      dropped: ["agents", "for"],
    },
    {
      fragment: "changed-07-the-tool-audit-runs-at-creation.md",
      was: "- **The tool audit runs at creation, after the mode",
      why: "Scoped to agent runtime sessions: bob login/logout (#243) start pi outside the factory and its audit.",
      edits: [
        [
          "- **The tool audit runs at creation,",
          "- **The tool audit runs on every agent runtime session at creation,",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "added-01-an-explicit-model-budget-context-window.md",
      was: "- **An explicit model budget: context window, compac",
      why: "Scoped to agent runtime sessions (#243), and the mid-run checkpoint is once per threshold until the check re-arms (bob#225, #239).",
      edits: [
        [
          "(required: every session refuses to start without a window",
          "(required: every agent runtime session refuses to start without a window",
        ],
        [
          "so pi's own compaction runs mid-run and the run continues.",
          "so pi's own compaction runs mid-run and the run continues (once per threshold until the check re-arms: bob#225, under Fixed).",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "added-04-positions-packaged-role-compatible-agent-presets.md",
      was: "- **Positions — packaged, role-compatible agent pres",
      why: "Scoped to agent runtime session entry paths: bob login/logout (#243) do not go through the resolver.",
      edits: [
        [
          "routes through EVERY session entry path —",
          "routes through EVERY agent runtime session entry path —",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "added-06-the-jarvis-role-the-office-s.md",
      was: "- **The `jarvis` role — the office's resident agent.",
      why: "The jarvis ceiling gained web_fetch and web_search with allowResidentWeb (#247), and the reachy body capability shipped in this release though the role does not allow its tools.",
      edits: [
        [
          "Its exact tool ceiling is `flair_search`, `flair_write`, `flair_get`, `discord_reply`, `discord_fetch` and `discord_react`, with `allowResidentShell: false` and no shell or file-writing tools.",
          "Its exact tool ceiling is `flair_search`, `flair_write`, `flair_get`, `discord_reply`, `discord_fetch`, `discord_react`, `web_fetch` and `web_search`, with `allowResidentShell: false`, `allowResidentWeb: true` and no shell or file-writing tools; the web tools are classified `egress`, and the composition rule refuses web beside Flair or Discord (see the data-classes entry).",
        ],
        [
          "Discord still requires operator configuration; the body and automatic decision loop come later.",
          "Discord still requires operator configuration; the role does not yet allow the `reachy` body tools (that capability ships in this release, against a stub sidecar), and the automatic decision loop comes later.",
        ],
      ],
      dropped: ["come"],
    },
    {
      fragment: "added-08-an-openrouter-provider-bob-owns.md",
      was: "- **An `openrouter` provider bob OWNS.",
      why: "Scoped to agent runtime entry paths: bob login/logout (#243) do not go through the factory.",
      edits: [
        [
          "and every entry path (`bob run`, the persistent runtime, `bob onboard`, `bob align`) goes through that factory",
          "and every agent runtime entry path (`bob run`, the persistent runtime, `bob onboard`, `bob align`) goes through that factory",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "added-10-the-task-or-a-persistent-agent.md",
      was: "- **The task — or a persistent agent's standing cont",
      why: "Scoped to agent runtime sessions: bob login/logout (#243) run pi without the contract or the guard.",
      edits: [
        [
          "rides the SYSTEM PROMPT, and every agent request is checked for it.**",
          "rides the SYSTEM PROMPT, and each runtime session's agent requests are checked for it.**",
        ],
        [
          "**What the guard proves is that every agent request carries the contract block**",
          "**What the guard proves is that every agent request of the session carries the contract block**",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "added-12-after-a-compaction-bob-sends-one.md",
      was: '- **After a compaction bob sends ONE best-effort "wh',
      why: "A web session (#247) gets no post-compaction note.",
      edits: [
        [
          '- **After a compaction bob sends ONE best-effort "what remains" note**,',
          '- **After a compaction bob sends ONE best-effort "what remains" note, except into a web session**,',
        ],
      ],
      dropped: [],
    },
    {
      fragment: "fixed-30-every-launch-path-enforces-the-tool.md",
      was: "- **Every launch path enforces the tool policy.",
      why: "Scoped to agent runtime launch paths: bob login/logout (#243) start pi without the allowlist.",
      edits: [
        [
          "- **Every launch path enforces the tool policy.**",
          "- **Every agent runtime launch path enforces the tool policy.**",
        ],
        [
          "No path starts an agent session without the resolved allowlist.",
          "No path starts an agent runtime session without the resolved allowlist.",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "fixed-31-a-missing-or-unparseable-tool-policy.md",
      was: "- **A missing or unparseable tool policy is a load e",
      why: "The factory-delivery clause is scoped to agent runtime sessions (#243).",
      edits: [
        [
          "the resolved allowlist and denylist reach the session as the factory's `tools`/`excludeTools`.",
          "the resolved allowlist and denylist reach each agent runtime session as the factory's `tools`/`excludeTools`.",
        ],
      ],
      dropped: [],
    },
    {
      fragment: "fixed-32-an-allowlisted-tool-the-session-does.md",
      was: "- **An allowlisted tool the session does not actuall",
      why: "The factory-delivery clauses are scoped to agent runtime sessions (#243).",
      edits: [
        [
          "— fails the session, naming the tool",
          "— fails the agent runtime session, naming the tool",
        ],
        [
          "`bob doctor` reports the same condition before any session runs,",
          "`bob doctor` reports the same condition before any agent runtime session runs,",
        ],
      ],
      dropped: [],
    },
  ];

  it("render carries every pre-migration list entry unchanged (trailing whitespace aside), except the named repairs, each once", () => {
    const rendered = ENTRIES(cf.assemble(migrated));
    expect(rendered.length).toBe(before.length);
    expect(new Set(rendered).size).toBe(rendered.length);
    const differing = before.filter((e) => !rendered.includes(e));
    // An unnamed difference maps to a string naming the entry, so a failure says
    // which entry it is.
    const named = differing.map(
      (e) => REPAIRED.find((r) => e.startsWith(r.was))?.fragment ?? `differs: ${e.slice(0, 80)}`,
    );
    expect(named.sort()).toEqual(REPAIRED.map((r) => r.fragment).sort());
  });

  it("each repair is exactly its listed edits, and every word it removes is listed", () => {
    const words = (s: string) =>
      new Set(s.toLowerCase().match(/[a-z0-9]+(?:['’-][a-z0-9]+)*/g) ?? []);
    for (const r of REPAIRED) {
      const matches = before.filter((e) => e.startsWith(r.was));
      expect(matches, r.fragment).toHaveLength(1);
      const was = matches[0] ?? "";
      const now = migrated.find((f) => f.name === r.fragment)?.body;
      if (now === undefined) throw new Error(`no fixture copy: ${r.fragment}`);
      let text = was;
      for (const [from, to] of r.edits) {
        expect(text.split(from).length - 1, `${r.fragment}: ${from}`).toBe(1);
        text = text.replace(from, () => to);
      }
      expect(now, r.fragment).toBe(text);
      const kept = words(now);
      const vanished = [...words(was)].filter((w) => !kept.has(w)).sort();
      expect(vanished, r.fragment).toEqual([...r.dropped].sort());
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

  // A migrated fragment corrected in place must be corrected in its fixture copy
  // too, where the repair is named; after a release none is left to compare.
  it("each live fragment the migration made matches its fixture copy", () => {
    const fixture = new Map(
      cf
        .readFragments(join(import.meta.dir, "fixtures", "changelog", "migrated-bob-236"))
        .map((f) => [f.name, f.body]),
    );
    for (const f of cf.readFragments()) {
      const copy = fixture.get(f.name);
      if (copy !== undefined) expect(f.body, f.name).toBe(copy);
    }
  });
});

describe("changelog fragments — the CLI (bob#236)", () => {
  // The script copied into a temp project: its ROOT is the copy's grandparent,
  // so every command, promote included, acts on the temp project only.
  const SCRIPT = join(import.meta.dir, "..", "scripts", "changelog-fragments.mjs");

  function cli(): {
    run: (...args: string[]) => { code: number; out: string };
    dir: string;
    changelogPath: string;
  } {
    const { dir, changelogPath } = project();
    mkdirSync(join(root, "scripts"));
    const copy = join(root, "scripts", "changelog-fragments.mjs");
    copyFileSync(SCRIPT, copy);
    fragment(dir, "fixed-a.md", "- **a fix.** \n");
    const run = (...args: string[]) => {
      const r = spawnSync("node", [copy, ...args], {
        encoding: "utf8",
        timeout: CHILD_TIMEOUT_MS,
        env: process.env,
      });
      return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
    };
    return { run, dir, changelogPath };
  }

  for (const cmd of ["render", "list", "check"]) {
    it(`${cmd} exits 0, and 2 with an argument it does not take`, () => {
      const { run } = cli();
      const good = run(cmd);
      expect(good.code, good.out).toBe(0);
      const bad = run(cmd, "--bogus");
      expect(bad.code, bad.out).toBe(2);
      expect(bad.out).toContain(`${cmd}: unexpected argument(s): --bogus`);
    });
  }

  it("promote exits 2 on an argument it does not take or a repeated --date, and writes nothing", () => {
    const { run, dir, changelogPath } = cli();
    const before = readFileSync(changelogPath, "utf8");
    for (const args of [
      ["1.2.3", "--bogus"],
      ["1.2.3", "--date", "2026-01-01"],
      ["1.2.3", "--date=2026-01-01", "--date=2026-01-02"],
    ]) {
      const r = run("promote", ...args);
      expect(r.code, `${args.join(" ")}: ${r.out}`).toBe(2);
    }
    expect(readFileSync(changelogPath, "utf8")).toBe(before);
    expect(cf.readFragments(dir).map((f) => f.name)).toEqual(["fixed-a.md"]);
    stageAll();
    const ok = run("promote", "1.2.3", "--date=2026-01-01");
    expect(ok.code, ok.out).toBe(0);
    expect(readFileSync(changelogPath, "utf8")).toContain("## [1.2.3] - 2026-01-01");
  });

  it("the script's Git children inherit the test's maintenance settings", () => {
    const { run, dir, changelogPath } = cli();
    stageAll();
    expect(gitSync(root, ["config", "maintenance.auto", "true"]).status).toBe(0);
    expect(gitSync(root, ["config", "gc.auto", "100"]).status).toBe(0);
    // The test's own Git children (gitSync stages and commits) see them too.
    expect(gitSync(root, ["config", "--get", "maintenance.auto"]).stdout).toBe("false\n");
    expect(gitSync(root, ["config", "--get", "gc.auto"]).stdout).toBe("0\n");

    const bin = join(root, "bin");
    const trace = join(root, "git-child-config.log");
    mkdirSync(bin);
    const shim = join(bin, "git");
    writeFileSync(
      shim,
      `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const { appendFileSync } = require("node:fs");
const env = { ...process.env, PATH: process.env.BOB_TEST_GIT_PATH };
for (const key of ["maintenance.auto", "gc.auto"]) {
  const result = spawnSync("git", ["-C", process.env.BOB_TEST_REPO, "config", "--get", key], {
    encoding: "utf8", env, timeout: ${CHILD_TIMEOUT_MS},
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
  appendFileSync(process.env.BOB_TEST_GIT_TRACE, result.stdout);
}
const result = spawnSync("git", process.argv.slice(2), {
  stdio: "inherit", env, timeout: ${CHILD_TIMEOUT_MS},
});
process.exit(result.status ?? 1);
`,
    );
    chmodSync(shim, 0o755);
    const inProcessTrace = join(root, "in-process-git-child-config.log");
    const shimEnv: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BOB_TEST_GIT_PATH: process.env.PATH ?? "",
      BOB_TEST_GIT_TRACE: inProcessTrace,
      BOB_TEST_REPO: root,
    };
    const priorShimEnv = new Map(Object.keys(shimEnv).map((key) => [key, process.env[key]]));
    Object.assign(process.env, shimEnv);
    let promoted: { code: number; out: string };
    try {
      // The script imported into this process: Bun starts its Git children.
      cf.gitRestorableOrThrow({ changelogPath, dir, names: ["fixed-a.md"] });
      // The script launched by cli().run: Node starts its Git children.
      process.env.BOB_TEST_GIT_TRACE = trace;
      promoted = run("promote", "1.2.3", "--date=2026-01-01");
    } finally {
      for (const [key, value] of priorShimEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    expect(
      existsSync(inProcessTrace),
      "the in-process script's Git children were started without process.env (PATH did not reach them)",
    ).toBe(true);
    expect(readFileSync(inProcessTrace, "utf8")).toMatch(/^(false\n0\n)+$/);
    expect(promoted.code, promoted.out).toBe(0);
    expect(
      existsSync(trace),
      "cli().run's Git children were started without process.env (PATH did not reach them)",
    ).toBe(true);
    expect(readFileSync(trace, "utf8")).toMatch(/^(false\n0\n)+$/);
  });

  // The script's entry-point test compares real paths: run through a symlink, it
  // must still run (here: refuse a malformed fragment), not exit 0 doing nothing.
  it("runs through a symlinked path (a malformed fragment still fails check)", () => {
    const { dir } = cli();
    fragment(dir, "fixed-not-a-list.md", "just some prose\n");
    symlinkSync(root, join(root, "link"));
    const viaLink = join(root, "link", "scripts", "changelog-fragments.mjs");
    const r = spawnSync("node", [viaLink, "check"], {
      encoding: "utf8",
      timeout: CHILD_TIMEOUT_MS,
      env: process.env,
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(1);
    expect(r.stderr).toContain("fixed-not-a-list.md: fragment must start with '- '");
  });

  it("an unknown command exits 2", () => {
    const { run } = cli();
    const r = run("publish");
    expect(r.code, r.out).toBe(2);
    expect(r.out).toContain("unknown command 'publish'");
  });
});

// Acceptance: two PRs whose fragments have DISTINCT filenames merge in either
// order with no changelog conflict. Two real branches in a temp git repo: B merged into A,
// and separately A's original commit merged into B; both fragments must be
// present after each merge. (Two PRs that add the SAME filename with different
// contents can conflict on that file; the README says so.)
describe("changelog fragments — two PRs with distinct fragment filenames (bob#236)", () => {
  function git(cwd: string, ...args: string[]): { code: number; out: string } {
    const r = gitSync(cwd, args);
    return { code: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}${r.error ?? ""}` };
  }

  // Every setup step must succeed; a silently failed step would leave the merges
  // below testing something else.
  function ok(cwd: string, ...args: string[]): void {
    const r = git(cwd, ...args);
    expect(r.code, `git ${args.join(" ")}: ${r.out}`).toBe(0);
  }

  const A = join(".changelog", "unreleased", "fixed-from-a.md");
  const B = join(".changelog", "unreleased", "added-from-b.md");

  function repo(): string {
    const d = join(root, "repo");
    mkdirSync(d, { recursive: true });
    ok(d, "init", "-q", "-b", "main");
    ok(d, "config", "user.email", "t@t.dev");
    ok(d, "config", "user.name", "t");
    ok(d, "config", "commit.gpgsign", "false");
    writeFileSync(join(d, "CHANGELOG.md"), `# Changelog\n\n## [Unreleased]\n\n${NOTE}\n`);
    mkdirSync(join(d, ".changelog", "unreleased"), { recursive: true });
    writeFileSync(join(d, ".changelog", "unreleased", "README.md"), "# fragments\n");
    ok(d, "add", "-A");
    ok(d, "commit", "-q", "-m", "base");
    return d;
  }

  function bothFragments(d: string): void {
    expect(readFileSync(join(d, A), "utf8")).toBe("- **a.** \n");
    expect(readFileSync(join(d, B), "utf8")).toBe("- **b.** \n");
  }

  it("B merged into A, and A's original commit merged into B: both clean, both fragments present", () => {
    const d = repo();
    ok(d, "checkout", "-q", "-b", "a", "main");
    writeFileSync(join(d, A), "- **a.** \n");
    ok(d, "add", "--", A);
    ok(d, "commit", "-q", "-m", "a");
    ok(d, "checkout", "-q", "-b", "b", "main");
    writeFileSync(join(d, B), "- **b.** \n");
    ok(d, "add", "--", B);
    ok(d, "commit", "-q", "-m", "b");

    // Order 1: B into A, on a branch of its own so `a` keeps its original commit.
    ok(d, "checkout", "-q", "-b", "a-then-b", "a");
    const m1 = git(d, "merge", "--no-edit", "b");
    expect(m1.code, m1.out).toBe(0);
    bothFragments(d);

    // Order 2: A's original commit into B.
    ok(d, "checkout", "-q", "-b", "b-then-a", "b");
    const parents = git(d, "rev-list", "--parents", "-n", "1", "a");
    expect(parents.code, parents.out).toBe(0);
    expect(parents.out.trim().split(" ")).toHaveLength(2); // `a` is still A's one-parent commit
    const m2 = git(d, "merge", "--no-edit", "a");
    expect(m2.code, m2.out).toBe(0);
    bothFragments(d);
  });
});
