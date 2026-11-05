// verify-pack installs a packed tarball with npm, which resolves the tarball's
// dependency ranges from the registry and does not read bunfig.toml. The
// install environment carries npm's `before` cutoff so npm applies the same
// 7-day release-age bake as bun.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  isResolutionFailure,
  RELEASE_AGE_MS,
  releaseAgeCutoff,
  releaseAgeInstallEnv,
} from "../scripts/release-age-env.mjs";

const VERIFY_PACK = join(import.meta.dir, "..", "scripts", "verify-pack.mjs");
const NOW = Date.parse("2026-11-05T16:23:34.927Z");

test("the cutoff is exactly 7 days before the install started", () => {
  expect(RELEASE_AGE_MS).toBe(7 * 24 * 60 * 60 * 1000);
  expect(releaseAgeCutoff(NOW)).toBe("2026-10-29T16:23:34.927Z");
});

test("the install environment sets npm_config_before to the cutoff", () => {
  const base = { HOME: "/tmp/host-a-home", npm_config_cache: "/tmp/host-a-cache" };
  const env = releaseAgeInstallEnv(base, NOW);
  expect(env.npm_config_before).toBe("2026-10-29T16:23:34.927Z");
  expect(env.HOME).toBe(base.HOME);
  expect(env.npm_config_cache).toBe(base.npm_config_cache);
  expect(base).not.toHaveProperty("npm_config_before");
});

test("verify-pack builds its install environment with the release-age builder", () => {
  const source = readFileSync(VERIFY_PACK, "utf8");
  expect(source).toContain("releaseAgeInstallEnv(");
  expect(source).toContain("release-age cutoff:");
});

test.each([
  ["npm error code ETARGET", true],
  ["npm error notarget No matching version found for host-a-lib@^2.0.0", true],
  ["npm error code E404", false],
  ["", false],
])("only a resolution failure is classified as one: %s", (output, expected) => {
  expect(isResolutionFailure(output)).toBe(expected);
});
