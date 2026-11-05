// The release pipeline upgrades npm before `npm stage publish`. That upgrade
// must name one exact version: a range would resolve from the registry at run
// time with no release-age bake.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const WORKFLOW = join(import.meta.dir, "..", ".github", "workflows", "release-publish.yml");

type Step = { name?: string; run?: string };
type Workflow = { jobs?: Record<string, { steps?: Step[] }> };

test("the npm self-update names an exact version with no range operator", () => {
  const workflow = parseYaml(readFileSync(WORKFLOW, "utf8")) as Workflow;
  const steps = workflow.jobs?.["stage-publish"]?.steps ?? [];
  const step = steps.find(
    (candidate) => candidate.name === "Upgrade npm to a staging-capable version",
  );
  expect(step).toBeDefined();
  const run = step?.run ?? "";
  const match = run.match(/npm install -g npm@(\S+)/);
  expect(match).not.toBeNull();
  const version = match?.[1] ?? "";
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  const [major, minor] = version.split(".").map(Number);
  expect(major > 11 || (major === 11 && minor >= 15)).toBe(true);
});
