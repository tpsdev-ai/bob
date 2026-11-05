// The release pipeline upgrades npm before `npm stage publish`. That upgrade
// must be exactly one command naming one exact version: a range would resolve
// from the registry at run time with no release-age bake, and a second
// appended install would resolve one too.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const WORKFLOW = join(import.meta.dir, "..", ".github", "workflows", "release-publish.yml");

type Step = { name?: string; run?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

const SELF_UPDATE = /\bnpm\s+(?:install|i)\s+(?:-g|--global)\s+npm@(\S+)/;

test("the npm self-update is one command naming one exact version", () => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const steps = workflow.jobs?.["stage-publish"]?.steps ?? [];
  const step = steps.find(
    (candidate) => candidate.name === "Upgrade npm to a staging-capable version",
  );
  expect(step).toBeDefined();
  const commands = (step?.run ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .filter((line) => SELF_UPDATE.test(line));
  expect(commands).toHaveLength(1);
  const versions = [...commands[0].matchAll(/\bnpm@(\S+)/g)].map((match) => match[1]);
  expect(versions).toHaveLength(1);
  const version = versions[0];
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  const [major, minor] = version.split(".").map(Number);
  expect(major > 11 || (major === 11 && minor >= 15)).toBe(true);
});
