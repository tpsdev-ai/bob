#!/usr/bin/env bun
/**
 * resolve-release-commit.mjs — choose the one commit a release run stages,
 * refuse it unless it is on main, and hand it to every later job as a full
 * commit sha.
 *
 * Tag push: the commit the pushed tag points at (GITHUB_SHA).
 * Manual dispatch: the commit of refs/tags/v<VERSION>, never the run's own
 * commit. The input is checked as a version string before any git command
 * runs, the tag is peeled to its commit (annotated tags included) and refused
 * when it is absent or its commit is not an ancestor of origin/main.
 *
 * Later jobs check out the sha this script prints, so the commit that was
 * verified is the commit that is staged even if the tag moves afterwards.
 *
 * Environment:
 *   GITHUB_EVENT_NAME  push | workflow_dispatch (set by the runner)
 *   GITHUB_SHA         the run's commit (tag push only)
 *   VERSION            the v<VERSION> tag to stage (workflow_dispatch only)
 *   GITHUB_OUTPUT      when set, receives `sha=<40-hex>` for the job output
 *
 * Exit codes:
 *   0 — the commit was resolved and is on origin/main; prints `sha=<40-hex>`
 *   1 — refused: invalid version, missing tag, a tag that is not a commit, or a
 *       commit that is not on main
 *   2 — the guard could not run (bad event, git failure)
 */

import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";

// Mirrors the version shape release-publish.yml has always accepted.
const VERSION_RE = /^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAIN_REF = "origin/main";

function git(args) {
  const result = spawnSync("git", args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout?.trim() ?? "",
    stderr: result.stderr?.trim() ?? "",
  };
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
  const found = git(["rev-parse", "--verify", "--quiet", tag]);
  if (found.status === 1) refuse(`tag v${version} does not exist`);
  if (found.status !== 0) fail(`git rev-parse ${tag} failed: ${found.stderr}`);

  const peeled = git(["rev-parse", "--verify", "--quiet", `${tag}^{commit}`]);
  if (peeled.status !== 0) refuse(`tag v${version} does not point at a commit`);
  return requireSha(peeled.stdout, `tag v${version}`);
}

function ensureOnMain(sha, label) {
  const fetch = git(["fetch", "--no-tags", "origin", "main"]);
  if (fetch.status !== 0) fail(`git fetch origin main failed: ${fetch.stderr}`);

  const ancestry = git(["merge-base", "--is-ancestor", sha, MAIN_REF]);
  if (ancestry.status === 0) return;
  if (ancestry.status === 1) refuse(`${label} ${sha} is not an ancestor of ${MAIN_REF}`);
  fail(`git merge-base --is-ancestor ${sha} ${MAIN_REF} failed: ${ancestry.stderr}`);
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
    sha = requireSha(process.env.GITHUB_SHA ?? "", "GITHUB_SHA");
    label = "the run's commit";
  } else {
    fail(`unsupported event ${JSON.stringify(event)}; expected push or workflow_dispatch`);
  }

  ensureOnMain(sha, label);

  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `sha=${sha}\n`);
  console.log(`  ok ${label} is ${sha} and is on ${MAIN_REF}`);
  console.log(`sha=${sha}`);
}

main();
