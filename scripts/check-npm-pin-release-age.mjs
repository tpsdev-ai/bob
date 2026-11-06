#!/usr/bin/env bun
/**
 * check-npm-pin-release-age.mjs — hold the release pipeline's npm pin to the
 * 7-day release-age bake.
 *
 * release-publish.yml installs an exact npm version before it stages a
 * release. That pin is a registry install like any other, but it happens in a
 * workflow that no lockfile covers. This checker reads the pin from
 * release-publish.yml and refuses it when the registry has no valid publish time in
 * `YYYY-MM-DDTHH:mm:ss[.sss]Z` format for `npm@<pin>` or published it less than seven days ago.
 *
 * Exit codes:
 *   0 — the pinned npm version is at least the bake length old
 *   1 — the pin is younger than the bake, or its publish time is missing or invalid
 *   2 — policy/workflow error, or the registry lookup failed
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { RELEASE_AGE_MS } from "./release-age-env.mjs";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const WORKFLOW_REL = join(".github", "workflows", "release-publish.yml");
const UPGRADE_STEP = "Upgrade npm to a staging-capable version";
const EXACT_PIN = /^npm install -g npm@(\d+\.\d+\.\d+) --registry=(\S+)$/;

const UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function namedError(name, message) {
  return Object.assign(new Error(message), { name });
}

function bunYaml() {
  const parse = globalThis.Bun?.YAML?.parse;
  if (typeof parse !== "function") {
    throw namedError(
      "BunYAMLUnavailable",
      "release-publish.yml requires Bun.YAML.parse; run with bun --no-install",
    );
  }
  return parse;
}

/** The exact npm version release-publish.yml installs before staging. */
export function readNpmPin(workflowText) {
  let workflow;
  try {
    workflow = bunYaml()(workflowText);
  } catch (error) {
    throw namedError(
      "UnreadableWorkflow",
      `release-publish.yml is not parsable: ${error instanceof Error ? error.message : error}`,
    );
  }
  const steps = workflow?.jobs?.["stage-publish"]?.steps;
  if (!Array.isArray(steps)) {
    throw namedError(
      "UnpinnedNpmVersion",
      "release-publish.yml has no stage-publish steps to read the npm pin from",
    );
  }
  const upgrades = steps.filter((step) => step?.name === UPGRADE_STEP);
  if (upgrades.length !== 1) {
    throw namedError(
      "UnpinnedNpmVersion",
      `expected exactly one "${UPGRADE_STEP}" step, found ${upgrades.length}`,
    );
  }
  const upgrade = upgrades[0];
  for (const key of ["if", "continue-on-error"]) {
    if (Object.hasOwn(upgrade, key)) {
      throw namedError("UnpinnedNpmVersion", `"${UPGRADE_STEP}" must not set "${key}"`);
    }
  }
  const run = typeof upgrade.run === "string" ? upgrade.run.trim() : "";
  const match = EXACT_PIN.exec(run);
  if (!match || match[2] !== DEFAULT_REGISTRY) {
    throw namedError(
      "UnpinnedNpmVersion",
      `"${UPGRADE_STEP}" must run exactly npm install -g npm@<x.y.z> --registry=${DEFAULT_REGISTRY}; found ${run}`,
    );
  }
  return match[1];
}

function requireTestRegistry(registry, env) {
  if (env.CI !== undefined || env.GITHUB_ACTIONS !== undefined) {
    throw namedError(
      "TestRegistryOverrideRefusedInCi",
      "--registry is refused when CI or GITHUB_ACTIONS is set",
    );
  }
  let url;
  try {
    url = new URL(registry);
  } catch {}
  if (
    env.BOB_RELEASE_AGE_TEST_REGISTRY !== "1" ||
    !url ||
    !["http:", "https:"].includes(url.protocol) ||
    !(url.hostname === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(url.hostname)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw namedError(
      "TestRegistryOverrideRefused",
      "--registry requires an enabled loopback test registry",
    );
  }
}

/**
 * Check `npm@<pin>` from release-publish.yml against the registry's publish
 * time. `registry` is for tests only and must be a loopback test registry.
 */
export async function checkNpmPinReleaseAge(options = {}) {
  const {
    root = join(dirname(fileURLToPath(import.meta.url)), ".."),
    workflowPath = join(root, WORKFLOW_REL),
    fetchImpl = globalThis.fetch,
    now = Date.now(),
    registry,
    env = process.env,
    timeoutMs = 15_000,
  } = options;
  if (typeof fetchImpl !== "function") throw new Error("no fetch implementation available");
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`timeoutMs must be a positive integer: ${timeoutMs}`);
  }
  if (registry !== undefined) requireTestRegistry(registry, env);

  const pin = readNpmPin(readFileSync(workflowPath, "utf8"));
  const base = (registry ?? DEFAULT_REGISTRY).replace(/\/+$/, "");
  let metadata;
  try {
    const response = await fetchImpl(`${base}/npm`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    metadata = await response.json();
  } catch (error) {
    throw namedError(
      "PublishTimeLookupFailed",
      `registry lookup failed for npm: ${error instanceof Error ? error.message : error}`,
    );
  }

  const published = metadata?.time?.[pin];
  const publishedMs =
    typeof published === "string" && UTC_TIMESTAMP.test(published)
      ? Date.parse(published)
      : Number.NaN;
  if (
    !Number.isFinite(publishedMs) ||
    new Date(publishedMs).toISOString() !== published.replace(/(:\d{2})Z$/, "$1.000Z")
  ) {
    return {
      ok: false,
      pin,
      publishedAt: null,
      ageMs: null,
      bakeMs: RELEASE_AGE_MS,
      reason: `npm@${pin} — no publish time or invalid UTC timestamp in the registry metadata: ${JSON.stringify(published)}`,
    };
  }
  const ageMs = now - publishedMs;
  if (ageMs < RELEASE_AGE_MS) {
    const ageDays = (ageMs / 86_400_000).toFixed(1);
    return {
      ok: false,
      pin,
      publishedAt: published,
      ageMs,
      bakeMs: RELEASE_AGE_MS,
      reason: `npm@${pin} — published ${published} (${ageDays} days ago; bake: 7 days)`,
    };
  }
  return { ok: true, pin, publishedAt: published, ageMs, bakeMs: RELEASE_AGE_MS, reason: "" };
}

/** CLI: --registry and --timeout-ms override lookup defaults for local HTTP tests. */
async function main() {
  let result;
  try {
    const { values } = parseArgs({
      options: { registry: { type: "string" }, "timeout-ms": { type: "string" } },
    });
    result = await checkNpmPinReleaseAge({
      registry: values.registry,
      timeoutMs: values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]),
    });
  } catch (error) {
    console.error(
      `npm pin release-age check could not run: ${error instanceof Error ? `${error.name}: ${error.message}` : error}`,
    );
    process.exit(2);
  }

  if (!result.ok) {
    console.error(`npm pin is not old enough for the release-age bake: ${result.reason}`);
    process.exit(1);
  }
  console.log(
    `The pinned npm@${result.pin} is at least 7 days old (published ${result.publishedAt}).`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(2);
  });
}
