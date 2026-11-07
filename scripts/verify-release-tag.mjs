#!/usr/bin/env bun
/**
 * verify-release-tag.mjs — before the GitHub release job creates or edits a
 * release, confirm the tag still resolves to the commit the release guard
 * verified, and refuse when it resolves to another commit, naming the tag, the
 * expected sha and the resolved sha. An annotated tag is peeled to its commit.
 *
 * TAG is the already-validated `v<version>` tag and EXPECTED_SHA the full
 * 40-hex sha from the guard's job output; both arrive through the environment.
 *
 * Exit codes:
 *   0 — the tag resolves to EXPECTED_SHA
 *   1 — refused: the tag does not resolve to a commit, or resolves to another
 *       commit
 *   2 — the check could not run: a missing or malformed env value, or git
 *       could not run or exited with an error
 */

import { spawnSync } from "node:child_process";

// The guard emits a validated version, so the tag is a v<semver> string.
const TAG_RE = /^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$/;
const SHA_RE = /^[0-9a-f]{40}$/;

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    error: result.error,
  };
}

function refuse(message) {
  console.error(`refusing release: ${message}`);
  process.exit(1);
}

function fail(message) {
  console.error(`release tag guard could not run: ${message}`);
  process.exit(2);
}

function main() {
  const tag = process.env.TAG ?? "";
  const expected = process.env.EXPECTED_SHA ?? "";
  if (!TAG_RE.test(tag)) {
    fail(`TAG ${JSON.stringify(tag)} is not a v<version> tag`);
  }
  if (!SHA_RE.test(expected)) {
    fail(`EXPECTED_SHA ${JSON.stringify(expected)} is not a full 40-hex commit sha`);
  }

  const ref = `refs/tags/${tag}`;
  const peelArgs = ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`];
  const peeled = git(peelArgs);
  if (peeled.status === 1) {
    refuse(`tag ${tag} does not resolve to a commit; expected ${expected}`);
  }
  if (peeled.status !== 0) {
    const detail = peeled.stderr || peeled.error?.message || "no output";
    fail(`git ${peelArgs.join(" ")} failed: ${detail}`);
  }

  const resolved = peeled.stdout;
  if (resolved !== expected) {
    refuse(`tag ${tag} now resolves to ${resolved}; expected ${expected}`);
  }
  console.log(`  ok tag ${tag} still resolves to ${expected}`);
}

main();
