#!/usr/bin/env node
/**
 * check-lockfile-release-age.mjs — enforce bunfig.toml's release-age bake on
 * the committed bun.lock, where `bun install --frozen-lockfile` resolves
 * nothing and therefore does not apply `minimumReleaseAge`.
 *
 * Every entry in bun.lock's `packages` map is read. The lock's resolution
 * string is parsed as package@version; the publish time comes from the npm
 * registry document's `time[version]`. The bake length and
 * `minimumReleaseAgeExcludes` are read from bunfig.toml on every run; neither
 * is hard-coded here.
 *
 * Non-registry entries are skipped by one explicit rule: the version part of
 * the resolution starts with `workspace:`, `file:`, `link:`, `git:`, `git+`
 * or `github:`. Every other entry must parse as package@version; each unique
 * pair not listed in `minimumReleaseAgeExcludes` is looked up. A registry
 * request that fails, times out, or returns no publish time for that version
 * fails the check; it never passes by default.
 *
 * Exit codes:
 *   0 — every checked version is at least the bake length old
 *   1 — at least one package version is younger than the bake
 *   2 — a policy, lockfile or registry lookup could not be read (fail closed)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const NON_REGISTRY_PREFIXES = ["workspace:", "file:", "link:", "git:", "git+", "github:"];

/** Encode a package name for a registry URL: `@scope/name` → `@scope%2fname`. */
export function encodePackageName(name) {
  return name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1)).replace(/%2F/g, "%2f")}`
    : encodeURIComponent(name);
}

/**
 * Parse bun.lock, a JSONC document Bun writes with trailing commas (and
 * optionally comments). Comments and trailing commas outside strings are
 * removed before JSON.parse; an unparsable lock throws rather than reading as
 * an empty tree.
 */
export function parseBunLock(text) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"') {
      out += ch;
      i++;
      while (i < text.length) {
        const c = text[i];
        out += c;
        i++;
        if (c === "\\") {
          if (i < text.length) out += text[i++];
        } else if (c === '"') {
          break;
        }
      }
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i = Math.min(i + 2, text.length);
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
          while (j < text.length && text[j] !== "\n") j++;
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

/** Remove a TOML comment, leaving '#' inside quoted strings alone. */
function stripTomlComment(line) {
  let out = "";
  let quote = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote !== null) {
      out += c;
      if (quote === '"' && escaped) {
        escaped = false;
      } else if (quote === '"' && c === "\\") {
        escaped = true;
      } else if (c === quote) {
        quote = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      out += c;
      continue;
    }
    if (c === "#") break;
    out += c;
  }
  return out;
}

/** The lines of bunfig.toml's [install] table, with comments removed. */
function installTableLines(text) {
  let section = "";
  const lines = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = stripTomlComment(raw);
    const header = /^\s*\[([^\]]+)\]\s*$/.exec(line);
    if (header) {
      section = header[1].trim();
      continue;
    }
    if (section === "install") lines.push(line);
  }
  return lines.join("\n");
}

/** Parse a TOML array of strings starting at its opening bracket. */
function parseTomlStringArray(text, start) {
  let i = start + 1;
  let quote = null;
  let escaped = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote !== null) {
      if (quote === '"' && escaped) escaped = false;
      else if (quote === '"' && c === "\\") escaped = true;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "]") break;
  }
  if (i >= text.length) throw new Error("bunfig.toml minimumReleaseAgeExcludes has no closing ]");
  const body = text.slice(start + 1, i);
  const items = [];
  let j = 0;
  while (j < body.length) {
    const c = body[j];
    if (/\s/.test(c) || c === ",") {
      j++;
      continue;
    }
    if (c === '"') {
      let k = j + 1;
      let esc = false;
      for (; k < body.length; k++) {
        const d = body[k];
        if (esc) esc = false;
        else if (d === "\\") esc = true;
        else if (d === '"') break;
      }
      if (k >= body.length)
        throw new Error("bunfig.toml minimumReleaseAgeExcludes has an unterminated string");
      let value;
      try {
        value = JSON.parse(body.slice(j, k + 1));
      } catch (err) {
        throw new Error(
          `bunfig.toml minimumReleaseAgeExcludes has an invalid string: ${err.message}`,
        );
      }
      items.push(value);
      j = k + 1;
      continue;
    }
    if (c === "'") {
      const k = body.indexOf("'", j + 1);
      if (k === -1)
        throw new Error("bunfig.toml minimumReleaseAgeExcludes has an unterminated string");
      items.push(body.slice(j + 1, k));
      j = k + 1;
      continue;
    }
    throw new Error(
      `bunfig.toml minimumReleaseAgeExcludes must be an array of strings; found ${JSON.stringify(c)}`,
    );
  }
  return items;
}

/**
 * Read the release-age policy from bunfig.toml.
 * Returns { bakeSeconds, excludes }. A missing or malformed value throws: the
 * check has no default bake and no default exclusion list.
 */
export function readBunfigPolicy(text) {
  const install = installTableLines(text);
  if (install.trim() === "") {
    throw new Error("bunfig.toml has no [install] table with minimumReleaseAge");
  }
  const bakeMatch = /^\s*minimumReleaseAge\s*=\s*(.+?)\s*$/m.exec(install);
  if (!bakeMatch) {
    throw new Error("bunfig.toml [install] has no minimumReleaseAge");
  }
  let raw = bakeMatch[1].trim();
  if (raw.startsWith('"') || raw.startsWith("'")) {
    throw new Error("bunfig.toml minimumReleaseAge must be a number of seconds");
  }
  raw = raw.replace(/_/g, "");
  if (!/^\d+$/.test(raw)) {
    throw new Error(`bunfig.toml minimumReleaseAge is not a non-negative integer: ${bakeMatch[1]}`);
  }
  const bakeSeconds = Number(raw);
  if (!Number.isSafeInteger(bakeSeconds)) {
    throw new Error(`bunfig.toml minimumReleaseAge is out of range: ${bakeMatch[1]}`);
  }

  const excludesKey = /^\s*minimumReleaseAgeExcludes\s*=/m.exec(install);
  let excludes = [];
  if (excludesKey) {
    const start = install.indexOf("[", excludesKey.index);
    if (start === -1) {
      throw new Error("bunfig.toml minimumReleaseAgeExcludes must be an array of strings");
    }
    excludes = parseTomlStringArray(install, start);
  }
  return { bakeSeconds, excludes };
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Collect every installed copy in bun.lock's `packages` map.
 * Returns { entries, skipped }: entries are unique registry package versions,
 * in lock order, and skipped are explicit non-registry copies. A malformed
 * entry, an empty map, or a resolution without a version throws.
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
 * Check every registry package version in bun.lock against bunfig.toml's bake.
 * `fetchImpl` and `now` are injectable for tests; production uses node's fetch
 * and the current time.
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

/** CLI: one line per failure, then a non-zero exit. */
async function main() {
  let result;
  try {
    result = await checkLockfileReleaseAge();
  } catch (err) {
    console.error(
      `Lockfile release-age check could not run: ${err instanceof Error ? err.message : err}`,
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
    console.error("Package versions younger than the release-age bake:");
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
