#!/usr/bin/env bun
/**
 * resolve-release-commit.mjs — choose the one commit a release run stages,
 * refuse it unless it is on main, and hand it to every later job as a full
 * commit sha.
 *
 * Tag push: the pushed tag's commit (GITHUB_SHA). The version comes from
 * GITHUB_REF, which must be refs/tags/v<VERSION>, validated with the same
 * regex as the manual input before any git command runs.
 * Manual dispatch: the commit of refs/tags/v<VERSION>, never the run's own
 * commit. The input is checked as a version string before any git command
 * runs, the tag is peeled to its commit (annotated tags included) and refused
 * when it is absent or its commit is not an ancestor of origin/main.
 *
 * On both tag paths a refusal names the version and the reason; a push ref
 * that is not a v<version> tag is refused by ref.
 *
 * Later jobs check out the sha this script prints, so the commit that was
 * verified is the commit that is staged even if the tag moves afterwards.
 *
 * Environment:
 *   GITHUB_EVENT_NAME  push | workflow_dispatch (set by the runner)
 *   GITHUB_SHA         the run's commit (tag push only)
 *   GITHUB_REF         the pushed ref, refs/tags/v<VERSION> (tag push only)
 *   VERSION            the v<VERSION> tag to stage (workflow_dispatch only)
 *   GITHUB_OUTPUT      when set, receives `sha=<40-hex>` for the job output
 *
 * Exit codes:
 *   0 — the commit was resolved and is on origin/main; prints `sha=<40-hex>`
 *   1 — refused: an invalid version, a push ref that is not a v<version> tag,
 *       a missing tag, a tag that does not point at a commit, or a commit that
 *       is not on main
 *   2 — the guard could not run: unsupported event, a sha that is not a full
 *       40-hex sha, or git could not run or exited with an error
 *   3 — the resolved sha could not be written to GITHUB_OUTPUT
 */

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// Mirrors the version shape release-publish.yml has always accepted.
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const TAG_REF_RE = /^refs\/tags\/v(.+)$/;
const MAIN_REF = "origin/main";

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
    error: result.error,
  };
}

function gitFailure(args, result) {
  const detail = result.stderr || result.error?.message || "no output";
  return `git ${args.join(" ")} failed: ${detail}`;
}

function refuse(message) {
  console.error(`refusing release: ${message}`);
  process.exit(1);
}

function fail(message) {
  console.error(`release commit guard could not run: ${message}`);
  process.exit(2);
}

function requireVersion(value) {
  if (typeof value !== "string" || !VERSION_RE.test(value)) {
    // Prefix the input so a crafted value can never start a workflow command.
    refuse(
      `version input ${JSON.stringify(value)} is not a version (expected e.g. 0.3.0 or 1.0.0-rc.1)`,
    );
  }
  return value;
}

function requireSha(value, source) {
  if (typeof value !== "string" || !SHA_RE.test(value)) {
    fail(`${source} is not a full 40-hex commit sha: ${JSON.stringify(value)}`);
  }
  return value;
}

function tagCommit(version) {
  const tag = `refs/tags/v${version}`;
  const foundArgs = ["rev-parse", "--verify", "--quiet", tag];
  const found = git(foundArgs);
  if (found.status === 1) refuse(`tag v${version} does not exist`);
  if (found.status !== 0) fail(gitFailure(foundArgs, found));

  const peelArgs = ["rev-parse", "--verify", "--quiet", `${tag}^{commit}`];
  const peeled = git(peelArgs);
  // The tag exists (checked above), so exit 1 here means it peels to an object
  // that is not a commit. Any other status is git itself failing.
  if (peeled.status === 1) refuse(`tag v${version} does not point at a commit`);
  if (peeled.status !== 0) fail(gitFailure(peelArgs, peeled));
  return requireSha(peeled.stdout, `tag v${version}`);
}

function ensureOnMain(sha, label) {
  const fetchArgs = ["fetch", "--no-tags", "origin", "main"];
  const fetch = git(fetchArgs);
  if (fetch.status !== 0) fail(gitFailure(fetchArgs, fetch));

  const ancestryArgs = ["merge-base", "--is-ancestor", sha, MAIN_REF];
  const ancestry = git(ancestryArgs);
  if (ancestry.status === 0) return;
  if (ancestry.status === 1) refuse(`${label} ${sha} is not an ancestor of ${MAIN_REF}`);
  fail(gitFailure(ancestryArgs, ancestry));
}

function pushVersion(ref) {
  const match = TAG_REF_RE.exec(ref);
  if (!match || !VERSION_RE.test(match[1])) {
    refuse(`pushed ref ${JSON.stringify(ref)} is not a v<version> tag`);
  }
  return match[1];
}

function main() {
  const event = process.env.GITHUB_EVENT_NAME;
  let sha;
  let label;
  if (event === "workflow_dispatch") {
    const version = requireVersion(process.env.VERSION ?? "");
    sha = tagCommit(version);
    label = `tag v${version}`;
  } else if (event === "push") {
    const version = pushVersion(process.env.GITHUB_REF ?? "");
    sha = requireSha(process.env.GITHUB_SHA ?? "", "GITHUB_SHA");
    label = `tag v${version}`;
  } else {
    fail(`unsupported event ${JSON.stringify(event)}; expected push or workflow_dispatch`);
  }

  ensureOnMain(sha, label);

  const output = process.env.GITHUB_OUTPUT;
  if (output) {
    try {
      appendFileSync(output, `sha=${sha}\n`);
    } catch (error) {
      console.error(
        `release commit guard could not write the job output to GITHUB_OUTPUT ${output}: ${error?.message ?? error}`,
      );
      process.exit(3);
    }
  }
  console.log(`  ok ${label} is ${sha} and is on ${MAIN_REF}`);
  console.log(`sha=${sha}`);
}

main();
