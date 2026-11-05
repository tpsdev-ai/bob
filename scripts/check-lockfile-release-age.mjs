#!/usr/bin/env bun
/**
 * check-lockfile-release-age.mjs — enforce bunfig.toml's release-age bake on
 * the committed bun.lock, where `bun install --frozen-lockfile` resolves
 * nothing and therefore does not apply `minimumReleaseAge`.
 *
 * Every entry in bun.lock's `packages` map is read. The lock's resolution
 * string is parsed as package@version.
 *
 * An entry is checked only when its version is an exact semver version.
 * `workspace:`, `file:` and `link:` targets are skipped only when realpath
 * resolves them inside the checkout. Any other version
 * form — `git:`, `git+…`, `github:`, `http:`, `https:` or an unrecognised
 * value — is refused before any lookup, naming the lock key and version.
 * Each unique checked pair not listed in `minimumReleaseAgeExcludes` is
 * looked up. The bake is pinned: the checker refuses any
 * `minimumReleaseAge` other than 604800.
 *
 * Exit codes:
 *   0 — every checked version is at least the bake length old
 *   1 — at least one checked registry version is too young, even if a lookup also fails
 *   2 — policy/lockfile error, or lookup failure with no too-young version
 */

import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, parseEnv } from "node:util";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const REGISTRY_ENV = ["BUN_CONFIG_REGISTRY", "NPM_CONFIG_REGISTRY", "npm_config_registry"];

function namedError(name, message) {
  return Object.assign(new Error(message), { name });
}

function requireNpmRegistry(value, source, tarball = false) {
  let url;
  try {
    url = new URL(value);
  } catch {}
  if (
    url?.protocol !== "https:" ||
    url.hostname !== "registry.npmjs.org" ||
    url.port ||
    (!tarball && (url.pathname !== "/" || url.search || url.hash))
  ) {
    throw namedError("UnsupportedRegistry", `${source} must use the default npm registry`);
  }
}

/**
 * Read a configuration file; an absent optional file returns undefined.
 * Bun skips an unreadable .npmrc; the checker refuses rather than guess.
 */
function configurationText(path, optional = false) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (optional && error.code === "ENOENT") return undefined;
    throw namedError(
      "UnreadableConfiguration",
      `${path}: ${error.code ?? error.message}; make it readable${optional ? ", or remove it if it holds no settings for this install" : ""}`,
    );
  }
}

function optionalText(path) {
  return configurationText(path, true);
}

function expandRegistry(value, env) {
  return value.replace(
    /\$\{([^}?]+)(\?)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g,
    (match, key, optional, bare) => env[key ?? bare] ?? (optional ? "" : match),
  );
}

function checkTomlRegistries(config, source, env) {
  const check = (value, key, inheritDefault = false) => {
    if (value === undefined) return;
    const url = isPlainObject(value) ? value.url : value;
    if (url === undefined && isPlainObject(value)) return;
    const expanded = typeof url === "string" ? expandRegistry(url, env) : url;
    if (inheritDefault && expanded === "") return;
    requireNpmRegistry(expanded, `${source} ${key}`);
  };
  check(config.install?.registry, "install.registry");
  const scopes = config.install?.scopes;
  if (scopes !== undefined && !isPlainObject(scopes)) {
    throw namedError("UnsupportedRegistry", `${source} install.scopes must be a table`);
  }
  for (const [scope, value] of Object.entries(scopes ?? {})) {
    check(value, `install.scopes.${scope}`, true);
  }
}

function checkNpmrcRegistries(text, source, env) {
  for (const line of text.split(/\r\n|\r|\n/)) {
    const match = line.match(/^\s*([^=]+?)\s*=\s*(.*)$/);
    if (!match) continue;
    const key = match[1].replace(/^['"]|['"]$/g, "");
    if (!/^(?:registry|@[^:]+:registry)$/i.test(key)) continue;
    let value = match[2].trim();
    if (value.startsWith('"') || value.startsWith("'")) {
      const end = value.indexOf(value[0], 1);
      value = end < 0 ? value : value.slice(1, end);
    } else {
      value = value.replace(/\\([;#])|[;#].*$/g, (_match, escaped) => escaped ?? "").trim();
    }
    const expanded = expandRegistry(value, env);
    if (key.startsWith("@") && expanded === "") continue;
    requireNpmRegistry(expanded, `${source} ${key}`);
  }
}

function checkRegistryConfiguration(root, bunfigText, env) {
  const config = bunTomlParser()(bunfigText);
  const installEnv = { ...env };
  if (config.env !== false && config.env?.file !== false) {
    const mode = (env.BUN_ENV ?? env.NODE_ENV) === "development" ? "development" : "production";
    for (const file of [`.env.${mode}.local`, ".env.local", `.env.${mode}`, ".env"]) {
      const text = optionalText(join(root, file));
      if (text === undefined) continue;
      const values = parseEnv(text);
      for (const [key, value] of Object.entries(values)) {
        if (REGISTRY_ENV.includes(key)) {
          requireNpmRegistry(expandRegistry(value, { ...values, ...installEnv }), `${file} ${key}`);
        }
        installEnv[key] ??= expandRegistry(value, { ...values, ...installEnv });
      }
    }
  }
  for (const key of REGISTRY_ENV) {
    if (env[key] !== undefined) requireNpmRegistry(env[key], key);
  }
  const home = installEnv.HOME ?? homedir();
  const xdg = installEnv.XDG_CONFIG_HOME;
  const userconfig = installEnv.NPM_CONFIG_USERCONFIG ?? installEnv.npm_config_userconfig;
  const xdgNpmrc = xdg ? join(xdg, ".npmrc") : undefined;
  const userNpmrc = userconfig
    ? resolve(root, userconfig.startsWith("~/") ? join(home, userconfig.slice(2)) : userconfig)
    : xdgNpmrc && optionalText(xdgNpmrc) !== undefined
      ? xdgNpmrc
      : join(home, ".npmrc");
  for (const path of new Set([userNpmrc, join(root, ".npmrc")])) {
    const text = optionalText(path);
    if (text !== undefined) checkNpmrcRegistries(text, path, installEnv);
  }
  const globalBunfig = join(xdg && isAbsolute(xdg) ? xdg : home, ".bunfig.toml");
  const globalText = optionalText(globalBunfig);
  if (globalText !== undefined) {
    checkTomlRegistries(bunTomlParser()(globalText), globalBunfig, installEnv);
  }
  checkTomlRegistries(config, "bunfig.toml", installEnv);
}

function requireTestRegistry(registry, env) {
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

const LOCAL_SOURCE_PREFIXES = ["workspace:", "file:", "link:"];
// The SemVer 2.0.0 grammar: a numeric pre-release identifier has no leading zero.
const PRERELEASE_IDENTIFIER = "(?:0|[1-9]\\d*|\\d*[A-Za-z-][0-9A-Za-z-]*)";
const EXACT_VERSION = new RegExp(
  "^(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)" +
    `(?:-${PRERELEASE_IDENTIFIER}(?:\\.${PRERELEASE_IDENTIFIER})*)?` +
    "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
);

/** The release-age policy the checker enforces, in seconds. */
const PINNED_RELEASE_AGE_SECONDS = 7 * 24 * 60 * 60;

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
  if (bakeSeconds !== PINNED_RELEASE_AGE_SECONDS) {
    throw namedError(
      "UnpinnedReleaseAge",
      `bunfig.toml install.minimumReleaseAge must be ${PINNED_RELEASE_AGE_SECONDS}, found ${bakeSeconds}`,
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
 * Local-source targets are skipped only when realpath resolves inside root;
 * other non-semver versions are refused by name.
 */
export function collectLockEntries(lock, root) {
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
    const at = resolution.indexOf("@", 1);
    if (at <= 0 || at === resolution.length - 1) {
      throw new Error(
        `bun.lock packages[${JSON.stringify(key)}] does not name a package and version`,
      );
    }
    const name = resolution.slice(0, at);
    const version = resolution.slice(at + 1);
    const localPrefix = LOCAL_SOURCE_PREFIXES.find((prefix) => version.startsWith(prefix));
    if (localPrefix) {
      let target = resolve(root, version.slice(localPrefix.length));
      let checkout;
      try {
        checkout = realpathSync(root);
        target = realpathSync(target);
      } catch (error) {
        throw namedError(
          "LocalSourceOutsideCheckout",
          `bun.lock packages[${JSON.stringify(key)}] local target ${JSON.stringify(target)} cannot be resolved: ${error.code ?? error.message}; use an existing source inside the checkout`,
        );
      }
      const fromCheckout = relative(checkout, target);
      if (
        fromCheckout === ".." ||
        fromCheckout.startsWith(`..${sep}`) ||
        isAbsolute(fromCheckout)
      ) {
        throw namedError(
          "LocalSourceOutsideCheckout",
          `bun.lock packages[${JSON.stringify(key)}] local target ${JSON.stringify(target)} is outside the checkout; use a source inside the checkout`,
        );
      }
      skipped.push({ key, name, version });
      continue;
    }
    if (!EXACT_VERSION.test(version)) {
      throw namedError(
        "NonRegistryDependency",
        `bun.lock packages[${JSON.stringify(key)}] resolves to version ${JSON.stringify(version)}; only exact semver versions are checked and only in-checkout workspace:, file: and link: sources are skipped`,
      );
    }
    if (entry[1] !== undefined && entry[1] !== "") {
      requireNpmRegistry(entry[1], `bun.lock packages[${JSON.stringify(key)}] resolution`, true);
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
  const totalSignal = AbortSignal.timeout(60_000);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await fetchImpl(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.any([totalSignal, AbortSignal.timeout(timeoutMs)]),
        redirect: "error",
      });
      if (attempt !== 0 || ![429, 503].includes(response?.status)) break;
      const delayMs = retryAfterMs(response.headers?.get("retry-after"), Date.now());
      await response.body?.cancel();
      await sleep(delayMs, undefined, { signal: totalSignal });
    }
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

export function retryAfterMs(value, now) {
  if (!value) return 1000;
  const delay = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isNaN(delay) ? 1000 : Math.min(30_000, Math.max(0, delay));
}

/** Run fn over items with at most `limit` in flight; results keep input order. */
async function mapPool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]);
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
    registry,
    env = process.env,
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

  const bunfigText = configurationText(join(root, "bunfig.toml"));
  const policy = readBunfigPolicy(bunfigText);
  checkRegistryConfiguration(root, bunfigText, env);
  if (registry !== undefined) requireTestRegistry(registry, env);
  const lockText = readFileSync(join(root, "bun.lock"), "utf8");
  const lock = parseBunLock(lockText);
  const { entries, skipped } = collectLockEntries(lock, root);

  const excludedSet = new Set(policy.excludes);
  const toCheck = [];
  const excluded = [];
  for (const entry of entries) {
    if (excludedSet.has(entry.name)) excluded.push(entry);
    else toCheck.push(entry);
  }
  if (toCheck.length === 0) {
    throw namedError(
      "EmptyCheckedSet",
      "bun.lock has no registry versions to check after exclusions",
    );
  }

  const bakeMs = policy.bakeSeconds * 1000;
  const lookupFailures = [];
  const tooYoung = [];
  await mapPool(toCheck, concurrency, async (entry) => {
    try {
      const publishedAt = await lookupPublishTime(entry.name, entry.version, {
        fetchImpl,
        registry: registry ?? DEFAULT_REGISTRY,
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

  tooYoung.sort((a, b) => a.ageMs - b.ageMs);
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
    console.log(
      `Skipped local-source lock entries (${result.skipped.length}): ${result.skipped.map((e) => `${e.name}@${e.version}`).join(", ")}`,
    );
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
