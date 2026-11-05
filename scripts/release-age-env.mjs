// The release-age cutoff and the environment for npm installs that resolve
// from the registry.
//
// npm does not read bunfig.toml, so `minimumReleaseAge` does not cover an npm
// install. npm has its own `before` config: an ISO date; its selector prefers
// versions published before it. `before` alone is not fail-closed: npm accepts
// a version whose publish time is absent, and an exclusion inherited from the
// environment can exempt a package. scripts/verify-pack-install.mjs verifies
// the resolved lock against publish times and refuses inherited npm config.
// https://docs.npmjs.com/cli/configuring-npm/npmrc#before

/** The bake length, in milliseconds. */
export const RELEASE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The cutoff for an install started at `now` (epoch ms): `now` minus the bake. */
export function releaseAgeCutoff(now) {
  return new Date(now - RELEASE_AGE_MS).toISOString();
}

/**
 * npm config keys that can widen what `before` admits, select different
 * registry metadata, or point at an .npmrc this script did not write.
 * `@scope:registry` keys are refused as well.
 */
export const RELAXING_NPM_CONFIG = Object.freeze([
  "before",
  "min-release-age",
  "min-release-age-exclude",
  "registry",
  "replace-registry-host",
  "userconfig",
  "globalconfig",
  "prefix",
]);

/**
 * The inherited environment variables that could relax the cutoff. Names are
 * returned exactly as they appear in `env`; an empty array means none.
 */
export function inheritedNpmSettings(env) {
  const found = [];
  for (const key of Object.keys(env)) {
    const match = key.match(/^npm_config_(.+)$/i);
    if (!match) continue;
    const normalized = match[1].toLowerCase().replace(/_/g, "-");
    if (RELAXING_NPM_CONFIG.includes(normalized) || normalized.endsWith(":registry")) {
      found.push(key);
    }
  }
  return found;
}

function namedError(name, message) {
  return Object.assign(new Error(message), { name });
}

/**
 * Build the environment for an npm install that resolves from the registry:
 * `base` without any npm config, plus the release-age cutoff in npm's `before`
 * config. Inherited npm config is dropped so the environment cannot carry an
 * exclusion into npm; settings that could relax the cutoff are refused by name
 * rather than dropped silently. `overrides` is for the caller's own controlled
 * settings (cache, empty userconfig/globalconfig paths).
 */
export function releaseAgeInstallEnv(base, now = Date.now(), overrides = {}) {
  const inherited = inheritedNpmSettings(base);
  if (inherited.length > 0) {
    throw namedError(
      "InheritedNpmConfigRefused",
      `refusing inherited npm config that could relax the release-age cutoff: ${inherited.join(", ")}`,
    );
  }
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^npm_config_/i.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    ...overrides,
  });
  env.npm_config_before = releaseAgeCutoff(now);
  return env;
}

/**
 * Whether npm failed while resolving a dependency range (ETARGET/notarget or
 * ENOVERSIONS). The caller adds the cutoff and the remedy; the range may be
 * unsatisfiable because every version it allows was published after the cutoff.
 */
export function isResolutionFailure(output) {
  return (
    /\bETARGET\b/i.test(output) ||
    /\bENOVERSIONS\b/i.test(output) ||
    /No matching version found/i.test(output)
  );
}
