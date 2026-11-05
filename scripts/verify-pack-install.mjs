// Resolve a packed tarball's dependency tree, verify every resolved registry
// version against the release-age cutoff, then install from that lock.
//
// npm's `before` config filters resolution, but its selector accepts a version
// whose publish time is absent, and an exclusion inherited from npm config can
// exempt a package. This module therefore does not trust resolution: it reads
// the lock, looks every registry version up in the registry metadata, and
// refuses a missing publish time or a version published after the cutoff
// before `npm ci` can run an install script.

import { spawn } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { RELEASE_AGE_MS, releaseAgeCutoff } from "./release-age-env.mjs";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CONCURRENCY = 8;
const DEFAULT_COMMAND_TIMEOUT_MS = 600_000;
const EXACT_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const CONTROLLED_NPM_ENV = new Set([
  "audit",
  "before",
  "cache",
  "fund",
  "globalconfig",
  "update-notifier",
  "userconfig",
]);

function namedError(name, message) {
  return Object.assign(new Error(message), { name });
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer: ${value}`);
  }
  return value;
}

function run(command, args, { cwd, env, timeoutMs }) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr: error.message, timedOut });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code, stdout, stderr, timedOut });
    });
  });
}

async function mapPool(items, limit, fn) {
  let next = 0;
  async function worker() {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  }
  const workers = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: workers }, worker));
}

/** Encode a package name for a registry URL: `@scope/name` → `@scope%2fname`. */
export function encodePackageName(name) {
  return name.startsWith("@")
    ? `@${encodeURIComponent(name.slice(1)).replace(/%2F/g, "%2f")}`
    : encodeURIComponent(name);
}

/** The package name a lock entry's key or `name` field identifies. */
function lockEntryName(key, entry) {
  if (typeof entry.name === "string" && entry.name) return entry.name;
  const marker = "node_modules/";
  const index = key.lastIndexOf(marker);
  return index === -1 ? undefined : key.slice(index + marker.length);
}

function isPackedTarball(resolved, installDir, tarball) {
  if (typeof resolved !== "string" || !resolved.startsWith("file:")) return false;
  try {
    return (
      realpathSync(resolve(installDir, resolved.slice("file:".length))) === realpathSync(tarball)
    );
  } catch {
    return false;
  }
}

/** Refuse npm config in the install environment that this module did not set. */
function assertControlledNpmEnv(env) {
  const extra = [];
  for (const key of Object.keys(env)) {
    const match = key.match(/^npm_config_(.+)$/i);
    if (!match) continue;
    const normalized = match[1].toLowerCase().replace(/_/g, "-");
    if (!CONTROLLED_NPM_ENV.has(normalized)) extra.push(key);
  }
  if (extra.length > 0) {
    throw namedError(
      "InheritedNpmConfigRefused",
      `refusing npm config in the install environment: ${extra.join(", ")}`,
    );
  }
}

/**
 * Every registry name@version in `package-lock.json`, or the entries this
 * module cannot verify. The packed tarball itself is the only `file:` source
 * allowed; links and other local sources are refused.
 */
export function lockRegistryVersions(lock, { installDir, tarball, registry }) {
  const origin = new URL(registry).origin;
  const versions = [];
  const problems = [];
  for (const [key, entry] of Object.entries(lock.packages ?? {})) {
    if (key === "") continue;
    if (!entry || typeof entry !== "object") {
      problems.push(`${key}: lock entry is not an object`);
      continue;
    }
    if (entry.link === true) {
      problems.push(`${key}: links a local path`);
      continue;
    }
    const name = lockEntryName(key, entry);
    const version = entry.version;
    if (!name || typeof version !== "string") {
      problems.push(`${key}: no name/version`);
      continue;
    }
    const resolved = entry.resolved;
    if (isPackedTarball(resolved, installDir, tarball)) continue;
    if (typeof resolved === "string" && resolved.startsWith("file:")) {
      problems.push(`${name}@${version}: local source ${resolved}`);
      continue;
    }
    if (typeof resolved === "string") {
      let url;
      try {
        url = new URL(resolved);
      } catch {
        problems.push(`${name}@${version}: unparsable resolved ${resolved}`);
        continue;
      }
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
        problems.push(`${name}@${version}: resolved from ${resolved}, not ${origin}`);
        continue;
      }
    }
    if (!EXACT_VERSION.test(version)) {
      problems.push(`${name}@${version}: not an exact version`);
      continue;
    }
    versions.push({ name, version });
  }
  const seen = new Set();
  return {
    versions: versions.filter(({ name, version }) => {
      const id = `${name}@${version}`;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
    problems,
  };
}

async function assertPublishTimes(
  versions,
  { registry, cutoffMs, fetchImpl, timeoutMs, concurrency },
) {
  const byName = new Map();
  for (const version of versions) {
    const list = byName.get(version.name) ?? [];
    list.push(version);
    byName.set(version.name, list);
  }
  const refusals = [];
  await mapPool([...byName.entries()], concurrency, async ([name, entries]) => {
    let metadata;
    try {
      const response = await fetchImpl(`${registry}/${encodePackageName(name)}`, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      metadata = await response.json();
    } catch (error) {
      throw namedError(
        "PublishTimeLookupFailed",
        `registry lookup failed for ${name}: ${error instanceof Error ? error.message : error}`,
      );
    }
    for (const entry of entries) {
      const published = metadata?.time?.[entry.version];
      const publishedMs = typeof published === "string" ? Date.parse(published) : Number.NaN;
      if (!Number.isFinite(publishedMs)) {
        refusals.push(`${name}@${entry.version} — no publish time in the registry metadata`);
      } else if (publishedMs > cutoffMs) {
        refusals.push(
          `${name}@${entry.version} — published ${published}, after the release-age cutoff`,
        );
      }
    }
  });
  if (refusals.length > 0) {
    throw namedError(
      "ReleaseAgeRefused",
      `refusing ${refusals.length} resolved version(s):\n  ${refusals.join("\n  ")}`,
    );
  }
}

/**
 * Resolve `tarball`'s dependencies with npm into a lock, verify every resolved
 * registry version's publish time against `now`'s cutoff, then `npm ci` from
 * that lock. Returns `{ cutoff, checked }`.
 *
 * `registry` is for tests only: verify-pack passes none and npm uses its
 * default. A local test registry must be enabled by the caller.
 */
export async function installVerifiedTarball({
  tarball,
  installDir,
  env,
  now = Date.now(),
  registry = DEFAULT_REGISTRY,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  concurrency = DEFAULT_CONCURRENCY,
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
}) {
  positiveInteger(timeoutMs, "timeoutMs");
  positiveInteger(concurrency, "concurrency");
  positiveInteger(commandTimeoutMs, "commandTimeoutMs");
  if (typeof fetchImpl !== "function") throw new Error("no fetch implementation available");
  const baseRegistry = registry.replace(/\/+$/, "");
  const cutoff = releaseAgeCutoff(now);
  const cutoffMs = now - RELEASE_AGE_MS;
  const home = env.HOME;
  if (typeof home !== "string" || home === "") {
    throw namedError("UnisolatedHome", "the install environment has no scratch HOME");
  }
  assertControlledNpmEnv(env);
  const installEnv = { ...env, npm_config_before: cutoff };
  for (const path of [join(installDir, ".npmrc"), join(home, ".npmrc")]) {
    if (existsSync(path)) {
      throw namedError(
        "InheritedNpmConfigRefused",
        `refusing to install with ${path} present; the scratch install and HOME must hold no .npmrc`,
      );
    }
  }

  const registryArgs = registry === DEFAULT_REGISTRY ? [] : ["--registry", baseRegistry];
  const resolved = await run(
    "npm",
    [
      "install",
      "--package-lock-only",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      ...registryArgs,
      tarball,
    ],
    { cwd: installDir, env: installEnv, timeoutMs: commandTimeoutMs },
  );
  if (resolved.code !== 0) {
    const output = resolved.stderr || resolved.stdout;
    const error = namedError(
      "ResolveFailed",
      resolved.timedOut
        ? `npm could not resolve the tarball's dependencies before the release-age cutoff ${cutoff}: timed out`
        : `npm could not resolve the tarball's dependencies before the release-age cutoff ${cutoff}`,
    );
    error.output = output;
    throw error;
  }

  const lock = JSON.parse(readFileSync(join(installDir, "package-lock.json"), "utf8"));
  const { versions, problems } = lockRegistryVersions(lock, {
    installDir,
    tarball,
    registry: baseRegistry,
  });
  if (problems.length > 0) {
    throw namedError(
      "UnsupportedResolution",
      `refusing ${problems.length} lock entr(ies) that cannot be verified:\n  ${problems.join("\n  ")}`,
    );
  }
  await assertPublishTimes(versions, {
    registry: baseRegistry,
    cutoffMs,
    fetchImpl,
    timeoutMs,
    concurrency,
  });

  const installed = await run("npm", ["ci", "--no-audit", "--no-fund", ...registryArgs], {
    cwd: installDir,
    env: installEnv,
    timeoutMs: commandTimeoutMs,
  });
  if (installed.code !== 0) {
    throw namedError(
      "InstallFailed",
      `npm ci failed after the release-age check: ${installed.timedOut ? "timed out" : `exit ${installed.code}`}`,
    );
  }
  return { cutoff, checked: versions.length };
}
