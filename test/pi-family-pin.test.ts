// bob#188: package.json overrides pin the @earendil-works (pi) packages. CI fails
// when any @earendil-works/* entry in bun.lock resolves to a version other than its
// exact override, or has no override. Each lock entry is checked on its own, nested
// paths included, so a nested entry cannot hide behind a top-level one. package.json's
// overrides are the test's source for the expected version, so a coordinated
// override + lock upgrade passes.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const SCOPE = "@earendil-works/";

// Report malformed or mismatched entries, and report when no family entry is found; [] means the check passed.
function pinViolations(lockText: string, overrides: Record<string, unknown>): string[] {
  // bun.lock is JSONC (trailing commas); Bun's own parser reads it.
  const { packages = {} } = Bun.JSONC.parse(lockText) as { packages?: Record<string, unknown> };
  const violations: string[] = [];
  let family = 0;
  for (const [path, entry] of Object.entries(packages)) {
    // An entry is [ "name@version", ... ]; a scoped name starts with "@".
    const ref = Array.isArray(entry) ? entry[0] : undefined;
    const at = typeof ref === "string" ? ref.indexOf("@", 1) : -1;
    if (typeof ref !== "string" || at < 1) {
      violations.push(`${path}: no name@version to check`);
      continue;
    }
    const name = ref.slice(0, at);
    if (!name.startsWith(SCOPE)) continue;
    family++;
    const version = ref.slice(at + 1);
    const pinned = Object.hasOwn(overrides, name) ? overrides[name] : undefined;
    if (pinned !== version) {
      const says = typeof pinned === "string" ? pinned : "(no override)";
      violations.push(`${path} resolves ${name}@${version}; package.json overrides says ${says}`);
    }
  }
  // A lock in which the check found no family entry is not a pass.
  if (family === 0) violations.push(`bun.lock has no ${SCOPE}* entry to check`);
  return violations;
}

test("each @earendil-works/* entry in bun.lock resolves to its exact package.json override", () => {
  const { overrides = {} } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    overrides?: Record<string, unknown>;
  };
  expect(pinViolations(readFileSync(join(root, "bun.lock"), "utf8"), overrides)).toEqual([]);
});

describe("pinViolations on fixture locks", () => {
  const TUI = "@earendil-works/pi-tui";
  const NESTED = `@earendil-works/pi-coding-agent/${TUI}`;
  const pins = { "@earendil-works/pi-coding-agent": "0.84.3", [TUI]: "0.84.3" };

  // The shape bun.lock writes, trailing commas included.
  function lock(entries: Array<[path: string, ref: string]>): string {
    const rows = entries.map(
      ([path, ref]) =>
        `    ${JSON.stringify(path)}: [${JSON.stringify(ref)}, "", {}, "sha512-x"],\n`,
    );
    return `{\n  "lockfileVersion": 1,\n  "packages": {\n${rows.join("\n")}  },\n}\n`;
  }

  test("fails a moved nested entry listed before the top-level one", () => {
    const text = lock([
      ["@earendil-works/pi-coding-agent", "@earendil-works/pi-coding-agent@0.84.3"],
      [NESTED, `${TUI}@0.84.4`],
      [TUI, `${TUI}@0.84.3`],
    ]);
    expect(pinViolations(text, pins)).toEqual([
      `${NESTED} resolves ${TUI}@0.84.4; package.json overrides says 0.84.3`,
    ]);
  });

  test("fails a moved nested entry listed after the top-level one", () => {
    const text = lock([
      [TUI, `${TUI}@0.84.3`],
      [NESTED, `${TUI}@0.84.4`],
    ]);
    expect(pinViolations(text, pins)).toEqual([
      `${NESTED} resolves ${TUI}@0.84.4; package.json overrides says 0.84.3`,
    ]);
  });

  test("fails a moved top-level entry", () => {
    expect(pinViolations(lock([[TUI, `${TUI}@0.84.4`]]), pins)).toEqual([
      `${TUI} resolves ${TUI}@0.84.4; package.json overrides says 0.84.3`,
    ]);
  });

  test("fails a family entry with no override", () => {
    const client = "@earendil-works/pi-client";
    expect(pinViolations(lock([[client, `${client}@0.84.3`]]), pins)).toEqual([
      `${client} resolves ${client}@0.84.3; package.json overrides says (no override)`,
    ]);
  });

  test("passes a coordinated override and lock upgrade", () => {
    const text = lock([
      [TUI, `${TUI}@0.84.4`],
      [NESTED, `${TUI}@0.84.4`],
    ]);
    expect(pinViolations(text, { ...pins, [TUI]: "0.84.4" })).toEqual([]);
  });

  test("fails an entry with no name@version, and a lock with no family entry", () => {
    expect(pinViolations(lock([["typebox", "typebox"]]), pins)).toEqual([
      "typebox: no name@version to check",
      "bun.lock has no @earendil-works/* entry to check",
    ]);
  });
});
