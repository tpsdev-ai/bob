#!/usr/bin/env node
// scripts/check-workspace-deps.mjs
//
// Catches the bug shape from flair 0.8.0: a workspace package declaring
// an internal @tpsdev-ai/* dep at a version different from the version
// that workspace package actually ships. Local dev hides the mismatch
// (bun symlinks); only consumers of the published tarball see the
// staleness.
//
// Lifted from flair (tpsdev-ai/flair/scripts/check-workspace-deps.mjs).
// Adapted for bob's package layout (packages/{shell,cli,discord}).
//
// Exits 0 if every internal dep version matches the dependency's own
// package.json `version`. Exits 1 with a clear report otherwise.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const packagesDir = join(root, "packages");

// TOCTOU-safe read: try readFileSync, swallow ENOENT. Avoids the
// check-then-read race that CodeQL flags on statSync/readFileSync pairs.
function tryReadJSON(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Build a map of internal package name → version it ships at.
const shipped = new Map();
for (const dirent of readdirSync(packagesDir)) {
  const pkg = tryReadJSON(join(packagesDir, dirent, "package.json"));
  if (!pkg) continue;
  if (pkg.name && pkg.version) {
    shipped.set(pkg.name, pkg.version);
  }
}

// For every workspace, scan its declared deps and check internal ones.
const problems = [];
for (const dirent of readdirSync(packagesDir)) {
  const pkg = tryReadJSON(join(packagesDir, dirent, "package.json"));
  if (!pkg) continue;
  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.peerDependencies || {}),
  };
  for (const [depName, declaredVersion] of Object.entries(allDeps)) {
    if (!shipped.has(depName)) continue; // not an internal dep
    const shippedVersion = shipped.get(depName);
    // The `workspace:` protocol is REJECTED, not accepted. It reads as a clean
    // "whatever ships" marker locally, but it is a publish-time landmine: the
    // release pipeline publishes with the npm CLI (OIDC trusted publishing is
    // an npm feature), and npm does NOT rewrite `workspace:` specs when it
    // builds a tarball. Verified empirically — `npm pack` on this repo emitted
    // a package.json whose dependency was the literal string "workspace:*",
    // which is uninstallable for every consumer. (bun pm pack DOES rewrite it,
    // which is exactly why the breakage is invisible in local dev.)
    // Pin the exact shipped version instead; that is the shape tpsdev-ai/flair
    // publishes with.
    if (declaredVersion.startsWith("workspace:")) {
      problems.push({
        package: pkg.name,
        dep: depName,
        declared: declaredVersion,
        shipped: shippedVersion,
        reason: "npm does not rewrite `workspace:` specs on publish",
      });
      continue;
    }
    // Otherwise, the version range must match the shipped version's
    // major.minor.patch (we don't accept exact-tag stale pins).
    if (!declaredVersion.includes(shippedVersion)) {
      problems.push({
        package: pkg.name,
        dep: depName,
        declared: declaredVersion,
        shipped: shippedVersion,
      });
    }
  }
}

if (problems.length === 0) {
  console.log("[check-workspace-deps] all internal deps in lockstep");
  process.exit(0);
}

console.error("[check-workspace-deps] internal deps out of lockstep:");
for (const p of problems) {
  const why = p.reason ? ` — ${p.reason}` : "";
  console.error(
    `  ${p.package} declares ${p.dep}@${p.declared}, but ${p.dep} ships ${p.shipped}${why}`,
  );
}
console.error('\nFix: declare the exact shipped version (e.g. "1.2.3"), not a `workspace:` spec.');
process.exit(1);
