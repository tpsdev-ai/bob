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

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const packagesDir = join(root, "packages");

// Build a map of internal package name → version it ships at.
const shipped = new Map();
for (const dirent of readdirSync(packagesDir)) {
  const pkgPath = join(packagesDir, dirent, "package.json");
  if (!statSync(pkgPath, { throwIfNoEntry: false })?.isFile()) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  if (pkg.name && pkg.version) {
    shipped.set(pkg.name, pkg.version);
  }
}

// For every workspace, scan its declared deps and check internal ones.
const problems = [];
for (const dirent of readdirSync(packagesDir)) {
  const pkgPath = join(packagesDir, dirent, "package.json");
  if (!statSync(pkgPath, { throwIfNoEntry: false })?.isFile()) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  const allDeps = {
    ...(pkg.dependencies || {}),
    ...(pkg.devDependencies || {}),
    ...(pkg.peerDependencies || {}),
  };
  for (const [depName, declaredVersion] of Object.entries(allDeps)) {
    if (!shipped.has(depName)) continue; // not an internal dep
    // workspace:* is the canonical local-symlink form; we accept it as
    // a clean marker that the publisher intends "whatever ships."
    if (declaredVersion === "workspace:*" || declaredVersion === "workspace:^") {
      continue;
    }
    // Otherwise, the version range must match the shipped version's
    // major.minor.patch (we don't accept exact-tag stale pins).
    const shippedVersion = shipped.get(depName);
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
  console.error(`  ${p.package} declares ${p.dep}@${p.declared}, but ${p.dep} ships ${p.shipped}`);
}
console.error("\nFix: align the declared version to the shipped version (or use workspace:*).");
process.exit(1);
