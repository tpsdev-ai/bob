#!/usr/bin/env bun
/**
 * check-lockfile-release-age.mjs — enforce bunfig.toml's release-age bake on
 * the committed bun.lock, where `bun install --frozen-lockfile` resolves
 * nothing and therefore does not apply `minimumReleaseAge`.
 *
 * Every entry in bun.lock's `packages` map is read. The lock's resolution
 * string is parsed as package@version.
 *
 * Non-registry entries are skipped by one explicit rule: the version part of
 * the resolution starts with `workspace:`, `file:`, `link:`, `git:`, `git+`
 * or `github:`. Every other entry must parse as package@version; each unique
 * pair not listed in `minimumReleaseAgeExcludes` is looked up. A registry
 * request that fails, times out, or returns no publish time fails the check.
 *
 * Exit codes:
 *   0 — every checked version is at least the bake length old
 *   1 — at least one checked registry version is too young, even if a lookup also fails
 *   2 — policy/lockfile error, or lookup failure with no too-young version
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const NON_REGISTRY_PREFIXES = ["workspace:", "file:", "link:", "git:", "git+", "github:"];

/** Encode a package name for a registry URL: `@scope/name` → `@scope%2fname`. */
export function encodePackageName(name) {
  return name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1)).replace(/%2F/g, "%2f")}`
    : encodeURIComponent(name);
}

/**
 * Parse bun.lock, a JSONC document Bun writes with trailing commas (and
 * optionally comments). Comments become whitespace; trailing commas outside
 * strings are removed before JSON.parse.
 */
export function parseBunLock(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      out += ch;
      i++;
      let closed = false;
      while (i < text.length) {
        const c = text[i];
        out += c;
        i++;
        if (c === "\\") {
          if (i < text.length) out += text[i++];
        } else if (c === '"') {
          closed = true;
          break;
        }
      }
      if (!closed) throw new Error("bun.lock is not parsable: unterminated string");
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      out += " ";
      i += 2;
      while (i < text.length && text[i] !== "\n" && text[i] !== "\r") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      out += " ";
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n" || text[i] === "\r") out += text[i];
        i++;
      }
      if (i >= text.length) {
        throw new Error("bun.lock is not parsable: unterminated block comment");
      }
      i += 2;
      continue;
    }
    if (ch === ",") {
      // Drop the comma only when the next token (comments and whitespace
      // skipped) closes the object or array.
      let j = i + 1;
      while (j < text.length) {
        if (/\s/.test(text[j])) {
          j++;
          continue;
        }
        if (text[j] === "/" && text[j + 1] === "/") {
          j += 2;
          while (j < text.length && text[j] !== "\n" && text[j] !== "\r") j++;
          continue;
        }
        if (text[j] === "/" && text[j + 1] === "*") {
          j += 2;
          while (j < text.length && !(text[j] === "*" && text[j + 1] === "/")) j++;
          j = Math.min(j + 2, text.length);
          continue;
        }
        break;
      }
      if (text[j] === "}" || text[j] === "]") {
        i++;
        continue;
      }
    }
    out += ch;
    i++;
  }
  try {
    return JSON.parse(out);
  } catch (err) {
    throw new Error(
      `bun.lock is not parsable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function bunTomlParser() {
  const parseToml = globalThis.Bun?.TOML?.parse;
  if (typeof parseToml !== "function") {
    const error = new Error("bunfig.toml requires Bun.TOML.parse; run with bun --no-install");
    error.name = "BunTOMLUnavailable";
    throw error;
  }
  return parseToml;
}

export function readBunfigPolicy(text) {
  const parseToml = bunTomlParser();
  let config;
  try {
    config = parseToml(text);
  } catch (error) {
    throw new Error(`bunfig.toml is not parsable: ${error.message}`);
  }
  const install = config.install;
  if (!isPlainObject(install)) {
    throw new Error("bunfig.toml install must be a table");
  }
  const bakeSeconds = install.minimumReleaseAge;
  if (!Number.isSafeInteger(bakeSeconds) || bakeSeconds < 0) {
    throw new Error(
      "bunfig.toml install.minimumReleaseAge must be a non-negative integer number of seconds",
    );
  }
  const excludes =
    install.minimumReleaseAgeExcludes === undefined ? [] : install.minimumReleaseAgeExcludes;
  if (
    !Array.isArray(excludes) ||
    excludes.some((name) => typeof name !== "string" || name.length === 0)
  ) {
    throw new Error(
      "bunfig.toml install.minimumReleaseAgeExcludes must be an array of non-empty strings",
    );
  }
  return { bakeSeconds, excludes };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Collect bun.lock's `packages` entries, including optional platform packages.
 * Returns { entries, skipped }: unique registry pairs and non-registry entries.
 * A missing/non-object or empty map, non-array entry, or missing/empty/non-string
 * resolution throws, as does a resolution without a name or version.
 * A one-element entry containing a name@version string is accepted.
 */
export function collectLockEntries(lock) {
  const packages = lock?.packages;
  if (!isPlainObject(packages)) {
    throw new Error('bun.lock has no "packages" object');
  }
  const keys = Object.keys(packages);
  if (keys.length === 0) {
    throw new Error("bun.lock has no packages: refusing to check an empty lockfile");
  }
  const entries = [];
  const seen = new Set();
  const skipped = [];
  for (const key of keys) {
    const entry = packages[key];
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || entry[0] === "") {
      throw new Error(
        `bun.lock packages[${JSON.stringify(key)}] does not name a package and version`,
      );
    }
    const resolution = entry[0];
    const at = resolution.lastIndexOf("@");
    if (at <= 0 || at === resolution.length - 1) {
      throw new Error(
        `bun.lock packages[${JSON.stringify(key)}] does not name a package and version`,
      );
    }
    const name = resolution.slice(0, at);
    const version = resolution.slice(at + 1);
    if (NON_REGISTRY_PREFIXES.some((prefix) => version.startsWith(prefix))) {
      skipped.push({ key, name, version });
      continue;
    }
    const id = `${name}\u0000${version}`;
    if (seen.has(id)) continue;
    seen.add(id);
    entries.push({ key, name, version });
  }
  return { entries, skipped };
}

async function lookupPublishTime(name, version, options) {
  const { fetchImpl, registry, timeoutMs } = options;
  const url = `${registry.replace(/\/+$/, "")}/${encodePackageName(name)}`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`registry request failed for ${name}@${version}: ${reason}`);
  }
  if (!response || typeof response.ok !== "boolean") {
    throw new Error(`registry request returned no response for ${name}@${version}`);
  }
  if (!response.ok) {
    throw new Error(`registry returned HTTP ${response.status} for ${name}@${version}`);
  }
  let body;
  try {
    body = await response.json();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`registry response is not JSON for ${name}@${version}: ${reason}`);
  }
  const published = body?.time?.[version];
  if (typeof published !== "string" || published === "") {
    throw new Error(`registry has no publish time for ${name}@${version}`);
  }
  const publishedAt = Date.parse(published);
  if (Number.isNaN(publishedAt)) {
    throw new Error(`registry publish time for ${name}@${version} is unparseable: ${published}`);
  }
  return publishedAt;
}

/** Run fn over items with at most `limit` in flight; results keep input order. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Filter out bunfig.toml exclusions before checking registry versions against its bake.
 */
export async function checkLockfileReleaseAge(options = {}) {
  const {
    root = join(dirname(fileURLToPath(import.meta.url)), ".."),
    fetchImpl = globalThis.fetch,
    now = Date.now(),
    registry = "https://registry.npmjs.org",
    concurrency = 8,
    timeoutMs = 15_000,
  } = options;

  if (typeof fetchImpl !== "function") {
    throw new Error("no fetch implementation available");
  }
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer: ${concurrency}`);
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`timeoutMs must be a positive integer: ${timeoutMs}`);
  }

  const bunfigText = readFileSync(join(root, "bunfig.toml"), "utf8");
  const policy = readBunfigPolicy(bunfigText);
  const lockText = readFileSync(join(root, "bun.lock"), "utf8");
  const lock = parseBunLock(lockText);
  const { entries, skipped } = collectLockEntries(lock);

  const excludedSet = new Set(policy.excludes);
  const toCheck = [];
  const excluded = [];
  for (const entry of entries) {
    if (excludedSet.has(entry.name)) excluded.push(entry);
    else toCheck.push(entry);
  }

  const bakeMs = policy.bakeSeconds * 1000;
  const lookupFailures = [];
  const tooYoung = [];
  await mapPool(toCheck, concurrency, async (entry) => {
    try {
      const publishedAt = await lookupPublishTime(entry.name, entry.version, {
        fetchImpl,
        registry,
        timeoutMs,
      });
      const ageMs = now - publishedAt;
      if (ageMs < bakeMs) {
        tooYoung.push({ ...entry, publishedAt, ageMs });
      }
    } catch (err) {
      lookupFailures.push({
        ...entry,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  tooYoung.sort((a, b) => b.ageMs - a.ageMs);
  return {
    ok: tooYoung.length === 0 && lookupFailures.length === 0,
    bakeSeconds: policy.bakeSeconds,
    excludes: policy.excludes,
    lockEntryCount: Object.keys(lock.packages).length,
    uniqueVersionCount: entries.length,
    checked: toCheck.length,
    excluded,
    skipped,
    tooYoung,
    lookupFailures,
  };
}

function formatDays(bakeSeconds) {
  return bakeSeconds % 86400 === 0 ? `${bakeSeconds / 86400}-day` : `${bakeSeconds}s`;
}

/** CLI: --registry and --timeout-ms override lookup defaults for local HTTP tests. */
async function main() {
  let result;
  try {
    bunTomlParser();
    const { values } = parseArgs({
      options: { registry: { type: "string" }, "timeout-ms": { type: "string" } },
    });
    result = await checkLockfileReleaseAge({
      registry: values.registry,
      timeoutMs: values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]),
    });
  } catch (err) {
    console.error(
      `Lockfile release-age check could not run: ${err instanceof Error ? `${err.name}: ${err.message}` : err}`,
    );
    process.exit(2);
  }

  console.log(
    `Checking ${result.checked} package version(s) (from ${result.lockEntryCount} lock entries) against the ${formatDays(result.bakeSeconds)} minimumReleaseAge bake (${result.bakeSeconds}s).`,
  );
  if (result.excluded.length > 0) {
    console.log(
      `Excluded by bunfig.toml minimumReleaseAgeExcludes (${result.excluded.length}): ${result.excluded.map((e) => `${e.name}@${e.version}`).join(", ")}`,
    );
  }
  if (result.skipped.length > 0) {
    console.log(`Skipped non-registry lock entries (${result.skipped.length}).`);
  }

  if (result.tooYoung.length > 0) {
    console.error("");
    console.error("Checked registry versions younger than the release-age bake:");
    for (const entry of result.tooYoung) {
      const ageDays = (entry.ageMs / 86_400_000).toFixed(1);
      console.error(
        `    ${entry.name}@${entry.version} — published ${new Date(entry.publishedAt).toISOString()} (${ageDays} days ago; bake: ${formatDays(result.bakeSeconds)})`,
      );
    }
  }

  if (result.lookupFailures.length > 0) {
    console.error("");
    console.error("Registry lookups that failed (treated as failure, never skipped):");
    for (const entry of result.lookupFailures) {
      console.error(`    ${entry.name}@${entry.version}: ${entry.error}`);
    }
  }

  if (!result.ok) {
    process.exit(result.tooYoung.length > 0 ? 1 : 2);
  }
  console.log(
    `All ${result.checked} checked package version(s) are at least ${formatDays(result.bakeSeconds)} old.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(2);
  });
}
