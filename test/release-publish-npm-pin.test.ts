// The release pipeline upgrades npm before `npm stage publish`. That upgrade
// must be exactly one command naming one exact version: a range would resolve
// from the registry at run time with no release-age bake, and a second
// appended global npm mutation would resolve or install one too.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const WORKFLOW = join(import.meta.dir, "..", ".github", "workflows", "release-publish.yml");

type Step = { name?: string; run?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

// Anchored to a whole simple command, so `echo npm install -g npm@11.21.1`
// and `npm install -g npm@11.21.1 --silent` are not the pin.
const SELF_UPDATE = /^npm\s+install\s+-g\s+npm@(\d+\.\d+\.\d+)$/;

// A global npm mutation is any of:
//   - npm install/i/add with -g or --global
//   - npm update/up/upgrade with -g or --global
//   - npm uninstall/remove/rm/unlink with -g or --global
//   - npm-check-updates, directly or through npx/bunx
//   - npx/bunx npm@<version>
//   - corepack preparing/enabling/using npm
const NPM_MUTATIONS = new Set([
  "install",
  "i",
  "add",
  "update",
  "up",
  "upgrade",
  "uninstall",
  "remove",
  "rm",
  "unlink",
]);
const PACKAGE_RUNNERS = new Set(["npx", "bunx"]);

function simpleCommands(run: string) {
  return run
    .split("\n")
    .flatMap((line) => line.split(/&&|\|\||[;|]/))
    .map((command) => command.trim())
    .filter((command) => command !== "" && !command.startsWith("#"));
}

function globalNpmMutation(command: string): string | undefined {
  const tokens = command.split(/\s+/);
  const [head] = tokens;
  if (head === "npm") {
    const subcommand = tokens.slice(1).find((token) => !token.startsWith("-"));
    const global = tokens.includes("-g") || tokens.includes("--global");
    if (subcommand && global && NPM_MUTATIONS.has(subcommand)) {
      return `npm ${subcommand} with a global flag`;
    }
  }
  if (head === "npm-check-updates") return "npm-check-updates";
  if (head && PACKAGE_RUNNERS.has(head)) {
    const pkg = tokens.slice(1).find((token) => !token.startsWith("-"));
    if (pkg === "npm-check-updates") return "npm-check-updates through a package runner";
    if (pkg === "npm" || pkg?.startsWith("npm@")) return "npm through a package runner";
  }
  if (head === "corepack" && tokens.some((token) => token === "npm" || token.startsWith("npm@"))) {
    return "corepack npm activation";
  }
  return undefined;
}

function scan(steps: Step[]) {
  const allowed: { step: string; version: string }[] = [];
  const refused: string[] = [];
  for (const step of steps) {
    for (const command of simpleCommands(step.run ?? "")) {
      const mutation = globalNpmMutation(command);
      if (mutation === undefined) continue;
      const match = command.match(SELF_UPDATE);
      if (match) allowed.push({ step: step.name ?? "(unnamed)", version: match[1] });
      else refused.push(`${step.name ?? "(unnamed)"}: ${command} (${mutation})`);
    }
  }
  return { allowed, refused };
}

test("the npm self-update is one command naming one exact version", () => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const steps = workflow.jobs?.["stage-publish"]?.steps ?? [];
  const { allowed, refused } = scan(steps);
  expect(refused).toEqual([]);
  expect(allowed).toHaveLength(1);
  const [{ version }] = allowed;
  const [major, minor] = version.split(".").map(Number);
  expect(major > 11 || (major === 11 && minor >= 15)).toBe(true);
});

test.each([
  ["an exact self-update", "npm install -g npm@11.21.1", true],
  ["the echo form", 'echo "npm install -g npm@11.21.1"', false],
  ["an appended range", "npm install -g npm@11.21.1\nnpm install -g npm@^11.15.0", false],
  ["an appended update", "npm install -g npm@11.21.1\nnpm update -g npm", false],
])("%s", (_name, run, expected) => {
  const { allowed, refused } = scan([{ name: "synthetic", run }]);
  expect(allowed.length === 1 && refused.length === 0).toBe(expected);
});
