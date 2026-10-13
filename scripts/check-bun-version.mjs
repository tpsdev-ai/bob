#!/usr/bin/env node
// bob#355: package.json's packageManager declares the bun version bob's
// lockfile is written with; every CI workflow's setup-bun pin must be that same
// version. The version has ONE source of truth (package.json); this check fails
// when a pin drifts from it.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const BUN_PACKAGE_MANAGER = /^bun@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
// The setup-bun input line: `bun-version: "1.3.10"`, quotes optional, a trailing
// comment allowed.
const BUN_VERSION_INPUT = /^\s*bun-version:\s*(["']?)([^\s"'#]+)\1\s*(?:#.*)?$/;

function workflowFiles(root) {
  const dir = join(root, ".github", "workflows");
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isFile() && /\.ya?ml$/.test(entry.name))
    .map((entry) => join(dir, entry.name))
    .sort();
}

// Report a packageManager that is not a pinned bun, every pin that disagrees
// with it, and the vacuous case (no pin to check). [] means the check passed.
export function checkBunVersionPins({ root = ROOT } = {}) {
  const errors = [];
  let declared;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    declared =
      typeof pkg.packageManager === "string"
        ? BUN_PACKAGE_MANAGER.exec(pkg.packageManager.trim())?.[1]
        : undefined;
  } catch (error) {
    errors.push(`package.json could not be read: ${error.message}`);
    return { declared: undefined, pins: 0, errors };
  }
  if (declared === undefined) {
    errors.push(
      'package.json packageManager is not a pinned "bun@<version>", so the workflow pins cannot be checked against it',
    );
    return { declared: undefined, pins: 0, errors };
  }
  let pins = 0;
  for (const file of workflowFiles(root)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      const match = line.match(BUN_VERSION_INPUT);
      if (!match) continue;
      pins++;
      if (match[2] !== declared) {
        errors.push(
          `${relative(root, file)}:${index + 1}: setup-bun pin ${match[2]} does not match package.json's bun ${declared}`,
        );
      }
    }
  }
  if (pins === 0) errors.push("no bun-version pin found in .github/workflows to check");
  return { declared, pins, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { pins, errors } = checkBunVersionPins();
  for (const error of errors) console.error(`bun version pin: ${error}`);
  if (errors.length > 0) process.exitCode = 1;
  else console.log(`bun version pin: ${pins} workflow pin(s) match package.json's bun`);
}
