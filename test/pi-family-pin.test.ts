// bob#188: the pi runtime family is pinned at one version. Every
// @earendil-works/* resolution in bun.lock must equal the version package.json's
// overrides pin it to — the one place that version is written — and a family
// member in the lock with no override fails, so a new transitive dependency
// cannot arrive under a range.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
// Set BOB_PI_LOCKFILE to read a copy instead (the mutation check does).
const lockPath = process.env.BOB_PI_LOCKFILE ?? join(root, "bun.lock");
const SCOPE = "@earendil-works/";

// bun.lock is JSON with trailing commas.
function parseLock(text: string): { packages: Record<string, unknown[]> } {
  return JSON.parse(text.replace(/,\s*([}\]])/g, "$1"));
}

test("every @earendil-works resolution in bun.lock matches its package.json override", () => {
  const { overrides = {} } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
    overrides?: Record<string, string>;
  };
  const resolved = new Map<string, string>();
  for (const entry of Object.values(parseLock(readFileSync(lockPath, "utf8")).packages)) {
    const ref = Array.isArray(entry) && typeof entry[0] === "string" ? entry[0] : "";
    const at = ref.lastIndexOf("@");
    if (at <= 0) continue;
    const name = ref.slice(0, at);
    if (name.startsWith(SCOPE)) resolved.set(name, ref.slice(at + 1));
  }
  // The check must have seen the family: a lock the parse could not read is not a pass.
  expect(resolved.size).toBeGreaterThan(0);
  const drift = [...resolved]
    .filter(([name, version]) => overrides[name] !== version)
    .map(
      ([name, version]) =>
        `${name} resolves to ${version}; package.json overrides says ${overrides[name] ?? "(no override)"}`,
    );
  expect(drift).toEqual([]);
});
