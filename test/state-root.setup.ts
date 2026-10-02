import { afterAll, afterEach, beforeEach, expect } from "bun:test";
import { lstatSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

function snapshot(path: string): unknown {
  try {
    const st = lstatSync(path, { bigint: true });
    return [
      String(st.dev),
      String(st.ino),
      String(st.mode),
      String(st.size),
      String(st.mtimeNs),
      String(st.ctimeNs),
      st.isDirectory()
        ? readdirSync(path)
            .sort()
            .map((name) => [name, snapshot(join(path, name))])
        : null,
    ];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

const homeRoots = [
  join(homedir(), ".local", "state", "bob"),
  join(homedir(), "Library", "Application Support", "bob"),
];
const homeBefore = homeRoots.map(snapshot);
let isolated: string;
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.BOB_STATE_DIR;
  isolated = mkdtempSync(join(tmpdir(), "bob-test-state-"));
  process.env.BOB_STATE_DIR = isolated;
});

afterEach(() => {
  rmSync(isolated, { recursive: true, force: true });
  if (saved === undefined) delete process.env.BOB_STATE_DIR;
  else process.env.BOB_STATE_DIR = saved;
});

afterAll(() => {
  expect(homeRoots.map(snapshot), "tests must leave the real home state roots unchanged").toEqual(
    homeBefore,
  );
});
