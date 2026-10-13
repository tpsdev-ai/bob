#!/usr/bin/env bun
// bob#355: package.json's packageManager declares the bun version bob's
// lockfile is written with. Every CI workflow step that uses oven-sh/setup-bun
// must install that same version: package.json is the one source of truth, and
// this check fails when a step's bun-version input is missing, is not a literal
// version, or drifts from it.
//
// It runs on bun and parses with bun's built-in YAML parser, with no installed
// dependency, so CI runs it before `bun install --frozen-lockfile`. When the
// setup-bun step succeeds and Bun.YAML is available, it names a drifting step,
// and a workflow's read or parse error, even when that install would fail.
// Without Bun.YAML it still fails, with a parser-unavailable error; a failed
// setup step stops the job before it runs.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

// What a parsed JSON or YAML value is, for an error message.
function shapeOf(value) {
  if (value === null) return "null";
  return Array.isArray(value) ? "an array" : `a ${typeof value}`;
}

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Report a package.json that cannot be read, parsed, or is not an object, a
// packageManager that is not a pinned bun, every setup-bun step that is
// missing, non-literal or drifting, a workflow that cannot be read or parsed,
// and the vacuous case (no setup-bun step to check). Without Bun.YAML the
// workflows are not read, and a package.json that passes yields a
// parser-unavailable error instead. [] means the check passed.
export function checkBunVersionPins({ root = ROOT } = {}) {
  const errors = [];
  const fail = (error) => {
    errors.push(error);
    return { declared: undefined, pins: 0, errors };
  };
  let raw;
  try {
    raw = readFileSync(join(root, "package.json"), "utf8");
  } catch (error) {
    return fail(`package.json could not be read: ${error.message}`);
  }
  let pkg;
  try {
    pkg = JSON.parse(raw);
  } catch (error) {
    return fail(`package.json could not be parsed as JSON: ${error.message}`);
  }
  if (!isMapping(pkg)) {
    return fail(
      `package.json has an invalid manifest shape: expected a JSON object, got ${shapeOf(pkg)}`,
    );
  }
  const declared =
    typeof pkg.packageManager === "string"
      ? BUN_PACKAGE_MANAGER.exec(pkg.packageManager.trim())?.[1]
      : undefined;
  if (declared === undefined) {
    return fail(
      'package.json packageManager is not a pinned "bun@<version>", so the workflow pins cannot be checked against it',
    );
  }
  const parseYaml = globalThis.Bun?.YAML?.parse;
  if (typeof parseYaml !== "function") {
    errors.push(
      "Bun.YAML is not available: run this check with a bun that has the built-in YAML parser",
    );
    return { declared, pins: 0, errors };
  }
  let pins = 0;
  for (const file of workflowFiles(root)) {
    const rel = relative(root, file);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      errors.push(`${rel}: could not be read: ${error.message}`);
      continue;
    }
    let doc;
    try {
      doc = parseYaml(text);
    } catch (error) {
      errors.push(`${rel}: could not be parsed as YAML: ${String(error.message).split("\n")[0]}`);
      continue;
    }
    // bun's parser returns an array for a stream of several documents, where a
    // workflow is one mapping; such a file is reported, not skipped.
    if (!isMapping(doc)) {
      errors.push(`${rel}: is not one YAML mapping (parsed as ${shapeOf(doc)})`);
      continue;
    }
    for (const [job, config] of Object.entries(doc.jobs ?? {})) {
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
  // Only a run that read and parsed every workflow can conclude there is
  // nothing to check; an error above is already the finding.
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
