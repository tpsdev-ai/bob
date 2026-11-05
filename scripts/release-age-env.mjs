// The release-age bake applied to npm installs that resolve from the registry.
//
// npm does not read bunfig.toml, so `minimumReleaseAge` does not cover an npm
// install. npm has its own `before` config: an ISO date; npm resolves only
// versions published before it.
// https://docs.npmjs.com/cli/configuring-npm/npmrc#before

/** The bake length, in milliseconds. */
export const RELEASE_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** The cutoff for an install started at `now` (epoch ms): `now` minus the bake. */
export function releaseAgeCutoff(now) {
  return new Date(now - RELEASE_AGE_MS).toISOString();
}

/**
 * Build the environment for an npm install that resolves from the registry:
 * `base` plus the release-age cutoff in npm's `before` config.
 */
export function releaseAgeInstallEnv(base, now = Date.now()) {
  return { ...base, npm_config_before: releaseAgeCutoff(now) };
}

/**
 * Whether npm failed while resolving a dependency range (ETARGET/notarget).
 * The caller adds the cutoff and the remedy; the range may be unsatisfiable
 * because every version it allows was published after the cutoff.
 */
export function isResolutionFailure(output) {
  return /\bETARGET\b/i.test(output) || /No matching version found/i.test(output);
}
