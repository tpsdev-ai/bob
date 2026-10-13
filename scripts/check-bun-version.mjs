#!/usr/bin/env node
// bob#355: package.json's packageManager declares the bun version bob's
// lockfile is written with. Every CI workflow step that uses oven-sh/setup-bun
// must install that same version: package.json is the one source of truth, and
// this check fails when a step's bun-version input is missing, is not a literal
// version, or drifts from it.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const BUN_PACKAGE_MANAGER = /^bun@(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)$/;
const SETUP_BUN = /^oven-sh\/setup-bun(?:@.+)?$/;
// A literal version, the shape packageManager uses. An expression (${{ ... }})
// or anything else is not one.
const LITERAL_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

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

// A step's label for error messages: its `name`, else its `uses`, else its
// position in the job's steps.
function stepLabel(step, index) {
  if (step && typeof step === "object") {
    if (typeof step.name === "string" && step.name.trim()) return `step "${step.name.trim()}"`;
    if (typeof step.uses === "string") return `step using ${step.uses}`;
  }
  return `step ${index + 1}`;
}

// Report a packageManager that is not a pinned bun, every setup-bun step that
// is missing, non-literal or drifting, a workflow that does not parse, and the
// vacuous case (no setup-bun step to check). [] means the check passed.
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
    const rel = relative(root, file);
    let doc;
    try {
      doc = parseYaml(readFileSync(file, "utf8"));
    } catch (error) {
      errors.push(`${rel}: could not be parsed as YAML: ${String(error.message).split("\n")[0]}`);
      continue;
    }
    for (const [job, config] of Object.entries(doc?.jobs ?? {})) {
      const steps = Array.isArray(config?.steps) ? config.steps : [];
      for (const [index, step] of steps.entries()) {
        if (!step || typeof step !== "object") continue;
        if (typeof step.uses !== "string" || !SETUP_BUN.test(step.uses.trim())) continue;
        pins++;
        const where = `${rel}: job ${job}, ${stepLabel(step, index)}`;
        const value = step.with ? step.with["bun-version"] : undefined;
        if (value === undefined) {
          errors.push(
            `${where}: setup-bun step has no bun-version input; set it to "${declared}" to match package.json`,
          );
        } else if (typeof value !== "string" || !LITERAL_VERSION.test(value)) {
          errors.push(
            `${where}: setup-bun bun-version ${JSON.stringify(value)} is not a literal version; set it to "${declared}" to match package.json`,
          );
        } else if (value !== declared) {
          errors.push(
            `${where}: setup-bun bun-version ${value} does not match package.json's bun ${declared}; set it to "${declared}"`,
          );
        }
      }
    }
  }
  // Only a run that parsed every workflow can conclude there is nothing to
  // check; a parse error above is already the finding.
  if (pins === 0 && errors.length === 0) {
    errors.push("no oven-sh/setup-bun step found in .github/workflows to check");
  }
  return { declared, pins, errors };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { pins, errors } = checkBunVersionPins();
  for (const error of errors) console.error(`bun version pin: ${error}`);
  if (errors.length > 0) process.exitCode = 1;
  else console.log(`bun version pin: ${pins} setup-bun step(s) match package.json's bun`);
}
