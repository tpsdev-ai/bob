#!/usr/bin/env bun
/**
 * verify-release-tag.mjs — read the release tag from the REMOTE and compare it
 * with the commit the release guard resolved, immediately before the GitHub
 * release job creates or edits the release. The tag is compared with the
 * verified commit just before the release is created or edited; a tag moved
 * after that comparison is not detected (tag immutability is a separate policy,
 * not this workflow).
 *
 * The lookup is `git ls-remote origin refs/tags/<tag> 'refs/tags/<tag>^{}'`, so
 * a missing remote tag or one resolving to a different object at this check
 * is refused. The peeled `^{}` line names the target object ID of an annotated
 * tag; without it, the plain ref's object ID is compared. An ls-remote failure
 * is a refusal, never a pass.
 *
 * TAG is the already-validated `v<version>` tag and EXPECTED_SHA the full
 * 40-hex sha from the guard's job output; both arrive through the environment.
 * TAG is checked with the workflow's version pattern before any git command.
 *
 * Exit codes:
 *   0 — the remote tag was read and matched EXPECTED_SHA at this check
 *   1 — refused: the remote tag is missing, unreadable, or resolves to another
 *       object at this check
 *   2 — the check could not run: a missing or malformed env value
 */

import { spawnSync } from "node:child_process";

// The workflow's version pattern for a v<version> tag.
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

// Split ls-remote output into the tag's own ref and its peeled `^{}` ref.
function parseRemote(output, tag) {
  let plain = null;
  let peeled = null;
  for (const line of output.split("\n")) {
    if (!line.trim()) continue;
    const [sha, ref] = line.split(/\s+/);
    if (ref === `refs/tags/${tag}`) plain = sha;
    else if (ref === `refs/tags/${tag}^{}`) peeled = sha;
  }
  return { plain, peeled };
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
  const lsArgs = ["ls-remote", "origin", ref, `${ref}^{}`];
  const listed = git(lsArgs);
  if (listed.status !== 0) {
    const detail = listed.stderr || listed.error?.message || "no output";
    refuse(
      `tag ${tag} is unreadable from origin; expected ${expected}; git ${lsArgs.join(" ")} failed: ${detail}`,
    );
  }

  const { plain, peeled } = parseRemote(listed.stdout, tag);
  if (plain === null) {
    refuse(`tag ${tag} is missing from origin; expected ${expected}`);
  }

  // Compare the peeled target object ID, or the plain ref's object ID.
  const resolved = peeled ?? plain;
  if (resolved !== expected) {
    refuse(`tag ${tag} resolves to ${resolved} on origin; expected ${expected}`);
  }
  console.log(`  ok tag ${tag} resolved to ${expected} on origin at this check`);
}

main();
