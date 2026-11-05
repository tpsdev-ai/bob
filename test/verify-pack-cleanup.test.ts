import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..");
const VERIFY_PACK = join(REPO, "scripts", "verify-pack.mjs");

test.each([false, true])("an npm pack failure cleans scratch unless --keep is set: %s", (keep) => {
  const root = mkdtempSync(join(tmpdir(), "bob-pack-failure-"));
  try {
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "npm"), '#!/bin/sh\necho "pack failed" >&2\nexit 1\n', { mode: 0o755 });
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key)),
    );
    const result = spawnSync("node", [VERIFY_PACK, ...(keep ? ["--keep"] : [])], {
      cwd: REPO,
      env: { ...env, TMPDIR: root, PATH: `${bin}:${process.env.PATH ?? ""}` },
      encoding: "utf8",
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain("pack failed");
    expect(readdirSync(root).filter((name) => name.startsWith("bob-verify-pack-"))).toHaveLength(
      keep ? 1 : 0,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
