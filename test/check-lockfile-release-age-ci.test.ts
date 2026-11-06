// The test pins the structure of ci.yml, codeql.yml, socket.yml and release-publish.yml: every workflow, job and step key is from a fixed allow set, every action any step uses is from a fixed allow set, pinned to a full commit SHA, with fixed input names, a `uses:` step may not set `env`, a job with no run step must depend on a job that runs the checker first, no job or step condition uses a status-check function, and the checker and the ancestry guard have fixed shapes; an edit outside these sets fails the test until the sets are deliberately changed in review. Whether the SHA is the right release commit is checked by scripts/check-action-pins.mjs and review, not here. The action allow-set check does not inspect input values or action contents.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const REPO = join(import.meta.dir, "..");
const WORKFLOWS = join(REPO, ".github/workflows");
const CHECKER = "bun --no-install scripts/check-lockfile-release-age.mjs";
const NPM_PIN_CHECKER = "bun --no-install scripts/check-npm-pin-release-age.mjs";
const NPM_PIN_STEP = "npm pin release-age bake";
const SELF_UPDATE = /^npm install -g npm@\d+\.\d+\.\d+$/;
const PUBLISH_LINE = /^npm\s+(?:stage|publish)\b/;
const PRE_RUN_ACTIONS = new Map<string, readonly string[]>([
  ["actions/checkout", ["fetch-depth", "persist-credentials"]],
  ["oven-sh/setup-bun", ["bun-version"]],
  ["actions/setup-node", ["node-version"]],
  ["socketdev/action", ["mode"]],
]);
const ACTIONS = new Map<string, readonly string[]>([
  ...PRE_RUN_ACTIONS,
  ["github/codeql-action/init", ["languages", "queries"]],
  ["github/codeql-action/autobuild", []],
  ["github/codeql-action/analyze", ["category"]],
  ["actions/cache", ["key", "path", "restore-keys"]],
]);

type Step = {
  [key: string]: unknown;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};
type Permissions = Record<string, string> | string;
type Job = {
  [key: string]: unknown;
  if?: unknown;
  needs?: string | string[];
  permissions?: Permissions;
  steps?: Step[];
};
type Workflow = {
  [key: string]: unknown;
  permissions?: Permissions;
  jobs?: Record<string, Job>;
};

const WORKFLOW_KEYS = ["name", "on", "permissions", "concurrency", "jobs"];
const JOB_KEYS = [
  "name",
  "runs-on",
  "permissions",
  "steps",
  "needs",
  "strategy",
  "environment",
  "if",
];
const USES_STEP_KEYS = ["uses", "with", "name", "id", "if"];
const RUN_STEP_KEYS = ["run", "name", "env", "id", "if"];
const ANCESTRY_JOB = "verify-ancestry";
const CHECKER_STEP_KEYS = ["name", "run"];
const ANCESTRY_JOB_KEYS = ["name", "runs-on", "permissions", "steps"];
const DEPENDENT_JOB_KEYS = [
  "name",
  "needs",
  "runs-on",
  "environment",
  "if",
  "permissions",
  "steps",
];

function keyProblems(value: object, allowed: readonly string[], where: string): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${where}: key "${key}" is not allowed`);
}

// An if without a status-check function runs as success() && <expr>;
// contains(needs.X.result, 'failure') cannot start a job after a failed guard.
function conditionProblems(condition: unknown, where: string): string[] {
  return /\b(success|failure|always|cancelled)\s*\(/i.test(String(condition ?? ""))
    ? [`${where}: if contains a status-check function`]
    : [];
}

function needsOf(job: Job): string[] {
  if (job.needs === undefined) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}

// Permissions that grant a write scope, including `id-token: write`.
function writePermissions(job: Job, workflow: Workflow): string[] {
  const permissions = job.permissions === undefined ? workflow.permissions : job.permissions;
  if (permissions === undefined) return ["repository-default"];
  if (permissions === "write-all") return ["write-all"];
  if (permissions === null || typeof permissions !== "object") return [];
  return Object.entries(permissions)
    .filter(([, value]) => value === "write")
    .map(([name]) => name);
}

function actionOf(step: Step): string | undefined {
  if (typeof step.uses !== "string") return undefined;
  const parts = step.uses.split("@");
  return parts.length === 2 && /^[0-9a-f]{40}$/i.test(parts[1]) ? parts[0] : undefined;
}

function actionProblems(
  step: Step,
  where: string,
  allowed = PRE_RUN_ACTIONS,
  scope = " before the first run step",
): string[] {
  const action = actionOf(step);
  const inputs = action === undefined ? undefined : allowed.get(action);
  if (inputs === undefined) {
    const refProblem =
      action === undefined && typeof step.uses === "string" ? "; ref is not a full commit SHA" : "";
    return [
      `${where}: action "${step.uses ?? "<missing uses>"}" is not allowed${scope}${refProblem}`,
    ];
  }
  if (step.with === undefined) return [];
  if (step.with === null || typeof step.with !== "object" || Array.isArray(step.with)) {
    return [`${where}: action "${step.uses}" has invalid with inputs`];
  }
  return Object.keys(step.with)
    .filter((input) => !inputs.includes(input))
    .map((input) => `${where}: action "${step.uses}" input "${input}" is not allowed${scope}`);
}

function ancestryProblems(steps: Step[], where: string): string[] {
  const problems: string[] = [];
  if (steps.length !== 2) {
    problems.push(
      `${where}: expected exactly 2 steps (checkout, ancestry guard), found ${steps.length}`,
    );
  }
  const checkout = steps[0];
  if (checkout === undefined || actionOf(checkout) !== "actions/checkout") {
    problems.push(`${where} step 1: expected actions/checkout`);
  } else {
    problems.push(...actionProblems(checkout, `${where} step 1`));
    if (checkout.with?.["persist-credentials"] !== false) {
      problems.push(`${where} step 1: actions/checkout input "persist-credentials" must be false`);
    }
    for (const key of Object.keys(checkout)) {
      if (key !== "uses" && key !== "with") {
        problems.push(`${where} step 1: actions/checkout field "${key}" is not allowed`);
      }
    }
  }
  const guard = steps[1];
  if (
    guard === undefined ||
    guard.name !== "Verify the run's commit is on main" ||
    typeof guard.run !== "string" ||
    guard.run.trim() === ""
  ) {
    problems.push(`${where} step 2: expected run step named "Verify the run's commit is on main"`);
  }
  if (guard !== undefined) {
    for (const key of Object.keys(guard)) {
      if (key !== "name" && key !== "run") {
        problems.push(`${where} step 2: ancestry guard field "${key}" is not allowed`);
      }
    }
  }
  return problems;
}

function firstRunIndex(steps: Step[]): number {
  return steps.findIndex((step) => typeof step.run === "string");
}

function orderingProblems(workflow: Workflow, source: string): string[] {
  const problems = keyProblems(workflow, WORKFLOW_KEYS, source);
  for (const [job, definition] of Object.entries(workflow.jobs ?? {})) {
    const steps = definition.steps ?? [];
    const where = `${source}: job "${job}"`;
    const firstRun = firstRunIndex(steps);
    problems.push(...keyProblems(definition, JOB_KEYS, where));
    problems.push(...conditionProblems(definition.if, where));
    for (const [index, step] of steps.entries()) {
      const stepWhere = `${where} step ${index + 1}`;
      const hasUses = Object.hasOwn(step, "uses");
      const hasRun = Object.hasOwn(step, "run");
      if (hasUses === hasRun) {
        problems.push(`${stepWhere}: expected exactly one of uses or run`);
        continue;
      }
      problems.push(...keyProblems(step, hasUses ? USES_STEP_KEYS : RUN_STEP_KEYS, stepWhere));
      problems.push(...conditionProblems(step.if, stepWhere));
      if (step.uses !== undefined) {
        problems.push(...actionProblems(step, stepWhere, ACTIONS, ""));
      }
    }
    const isAncestry = source === ".github/workflows/release-publish.yml" && job === ANCESTRY_JOB;
    if (isAncestry) {
      problems.push(...keyProblems(definition, ANCESTRY_JOB_KEYS, where));
      problems.push(...ancestryProblems(steps, where));
    }
    if (dependsOn(workflow.jobs ?? {}, job, ANCESTRY_JOB)) {
      problems.push(...keyProblems(definition, DEPENDENT_JOB_KEYS, where));
    }
    if (firstRun === -1) {
      const jobs = workflow.jobs ?? {};
      const hasCheckerDependency = Object.entries(jobs).some(([name, candidate]) => {
        const candidateSteps = candidate.steps ?? [];
        const index = firstRunIndex(candidateSteps);
        return (
          name !== job &&
          index !== -1 &&
          candidateSteps[index].run?.trim() === CHECKER &&
          dependsOn(jobs, job, name)
        );
      });
      if (!hasCheckerDependency) {
        problems.push(
          `${where}: a job with no run step must need a job whose first run step is the checker`,
        );
      }
      continue;
    }
    if (!isAncestry) {
      problems.push(
        ...keyProblems(steps[firstRun], CHECKER_STEP_KEYS, `${where} step ${firstRun + 1}`),
      );
      if ((steps[firstRun].run ?? "").trim() !== CHECKER) {
        problems.push(
          `${where} step ${firstRun + 1}: the first run step is not the ${CHECKER} checker`,
        );
      }
    }
    for (let index = 0; index < firstRun; index += 1) {
      if (
        steps[index].uses === undefined ||
        actionProblems(steps[index], "", ACTIONS, "").length === 0
      ) {
        problems.push(...actionProblems(steps[index], `${where} step ${index + 1}`));
      }
    }
  }
  return [...new Set(problems)];
}

test("workflow keys, conditions, shapes and checker ordering", () => {
  const sources = readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
  expect(sources).toEqual(["ci.yml", "codeql.yml", "release-publish.yml", "socket.yml"]);
  const problems = sources.flatMap((name) => {
    const workflow = parseYaml(readFileSync(join(WORKFLOWS, name), "utf8")) as Workflow;
    return orderingProblems(workflow, `.github/workflows/${name}`);
  });
  expect(problems).toEqual([]);
});

test("ci.yml action-pins runs the npm pin release-age checker with no condition", () => {
  const workflow = loadWorkflow("ci.yml");
  const job = workflow.jobs?.["action-pins"];
  if (job === undefined) throw new Error("Missing action-pins");
  expect(job).not.toHaveProperty("if");
  expect(job).not.toHaveProperty("continue-on-error");
  const matches = (job.steps ?? []).filter(
    (step) => typeof step.run === "string" && step.run.trim() === NPM_PIN_CHECKER,
  );
  expect(matches).toHaveLength(1);
  const step = matches[0];
  if (step === undefined) throw new Error("Missing npm pin release-age checker step");
  expect(step.if).toBeUndefined();
  expect(step["continue-on-error"]).toBeUndefined();
});

function npmPinStepProblems(steps: Step[]): string[] {
  const matches = steps.filter(
    (step) => typeof step.run === "string" && step.run.trim() === NPM_PIN_CHECKER,
  );
  if (matches.length !== 1) {
    return [`expected exactly one ${NPM_PIN_STEP} step, found ${matches.length}`];
  }
  const step = matches[0];
  const index = steps.indexOf(step);
  const problems: string[] = [];
  if (step.name !== NPM_PIN_STEP) {
    problems.push(`the npm pin release-age step must be named "${NPM_PIN_STEP}"`);
  }
  if (step.if !== undefined) problems.push("the npm pin release-age step must not have an if");
  if (step["continue-on-error"] !== undefined) {
    problems.push("the npm pin release-age step must not have continue-on-error");
  }
  const upgrade = steps.findIndex((candidate) => SELF_UPDATE.test((candidate.run ?? "").trim()));
  if (upgrade === -1) {
    problems.push("expected the exact npm self-update step");
  } else if (index > upgrade) {
    problems.push("the npm pin release-age step must run before the npm self-update");
  }
  for (const [candidateIndex, candidate] of steps.entries()) {
    if (candidateIndex >= index) continue;
    const publishes = (candidate.run ?? "")
      .split("\n")
      .map((line) => line.trim())
      .some((line) => PUBLISH_LINE.test(line));
    if (publishes) {
      problems.push(
        `the npm pin release-age step must run before ${candidate.name} stages or publishes`,
      );
    }
  }
  return problems;
}

test("release-publish stage-publish runs the npm pin release-age checker before the npm self-update with no condition", () => {
  const workflow = loadWorkflow("release-publish.yml");
  const job = workflow.jobs?.["stage-publish"];
  if (job === undefined) throw new Error("Missing stage-publish");
  expect(job).not.toHaveProperty("if");
  expect(job).not.toHaveProperty("continue-on-error");
  expect(npmPinStepProblems(job.steps ?? [])).toEqual([]);
});

function npmPinStep(steps: Step[]): Step {
  const step = steps.find(
    (candidate) => typeof candidate.run === "string" && candidate.run.trim() === NPM_PIN_CHECKER,
  );
  if (step === undefined) throw new Error("Missing npm pin release-age step");
  return step;
}

test.each([
  [
    "removed",
    (steps: Step[]) => {
      steps.splice(steps.indexOf(npmPinStep(steps)), 1);
    },
    `expected exactly one ${NPM_PIN_STEP} step, found 0`,
  ],
  [
    "moved after the npm self-update",
    (steps: Step[]) => {
      const step = npmPinStep(steps);
      steps.splice(steps.indexOf(step), 1);
      const upgrade = steps.findIndex((candidate) =>
        SELF_UPDATE.test((candidate.run ?? "").trim()),
      );
      steps.splice(upgrade + 1, 0, step);
    },
    "the npm pin release-age step must run before the npm self-update",
  ],
  [
    "moved after the stage/publish step",
    (steps: Step[]) => {
      const step = npmPinStep(steps);
      steps.splice(steps.indexOf(step), 1);
      steps.push(step);
    },
    "the npm pin release-age step must run before Stage-publish stages or publishes",
  ],
  [
    "given an if",
    (steps: Step[]) => {
      npmPinStep(steps).if = `$` + `{{ false }}`;
    },
    "the npm pin release-age step must not have an if",
  ],
] satisfies [string, (steps: Step[]) => void, string][])(
  "npm pin release-age step %s is red",
  (_name, mutate, problem) => {
    const steps = loadWorkflow("release-publish.yml").jobs?.["stage-publish"]?.steps ?? [];
    mutate(steps);
    expect(npmPinStepProblems(steps)).toContain(problem);
  },
);

test.each([
  ["defaults", { run: { shell: "bash -c true {0}" } }],
  ["env", { CI: "" }],
  ["unlisted-key", false],
] satisfies [string, unknown][])("workflow key %s is red", (key, value) => {
  const workflow = loadWorkflow("ci.yml");
  workflow[key] = value;
  expect(orderingProblems(workflow, ".github/workflows/ci.yml")).toEqual([
    `.github/workflows/ci.yml: key "${key}" is not allowed`,
  ]);
});

test.each([
  ["defaults", { run: { shell: "bash -c true {0}" } }],
  ["continue-on-error", true],
  ["env", { CI: "" }],
  ["container", "node"],
  ["services", {}],
  ["timeout-minutes", 1],
  ["outputs", {}],
  ["unlisted-key", false],
] satisfies [string, unknown][])("build job key %s is red", (key, value) => {
  const workflow = loadWorkflow("ci.yml");
  const job = workflow.jobs?.build;
  if (job === undefined) throw new Error("Missing build");
  job[key] = value;
  expect(orderingProblems(workflow, ".github/workflows/ci.yml")).toEqual([
    `.github/workflows/ci.yml: job "build": key "${key}" is not allowed`,
  ]);
});

test.each([
  ["continue-on-error", true],
  ["shell", "bash"],
  ["working-directory", "."],
  ["timeout-minutes", 1],
  ["unlisted-key", false],
] satisfies [string, unknown][])(
  "step key %s is red before and after the checker and without run steps",
  (key, value) => {
    for (const [source, name, index] of [
      ["ci.yml", "build", 0],
      ["socket.yml", "socket-note", 3],
      ["codeql.yml", "analyze", 2],
    ] as const) {
      const workflow = loadWorkflow(source);
      const step = workflow.jobs?.[name].steps?.[index];
      if (step === undefined) throw new Error(`Missing ${source} ${name} step ${index + 1}`);
      step[key] = value;
      expect(orderingProblems(workflow, `.github/workflows/${source}`)).toEqual([
        `.github/workflows/${source}: job "${name}" step ${index + 1}: key "${key}" is not allowed`,
      ]);
    }
  },
);

test.each([
  ["ci.yml", "build", "oven-sh/setup-bun"],
  ["codeql.yml", "analyze", "github/codeql-action/analyze"],
  ["release-publish.yml", "verify-ancestry", "actions/checkout"],
])("%s job %s uses %s with env is red", (source, job, action) => {
  const workflow = loadWorkflow(source);
  const steps = workflow.jobs?.[job].steps ?? [];
  const index = steps.findIndex((step) => actionOf(step) === action);
  expect(index).toBeGreaterThanOrEqual(0);
  steps[index].env = { CI: "" };
  const expected = [
    `.github/workflows/${source}: job "${job}" step ${index + 1}: key "env" is not allowed`,
  ];
  if (job === ANCESTRY_JOB) {
    expected.push(
      `.github/workflows/${source}: job "${job}" step ${index + 1}: actions/checkout field "env" is not allowed`,
    );
  }
  expect(orderingProblems(workflow, `.github/workflows/${source}`)).toEqual(expected);
});

test.each(["both", "neither"])("a step with %s uses and run after the checker is red", (kind) => {
  const workflow = loadWorkflow("release-publish.yml");
  const steps = workflow.jobs?.["stage-publish"].steps ?? [];
  const index = steps.findIndex((step) => actionOf(step) === "actions/cache");
  expect(index).toBeGreaterThan(firstRunIndex(steps));
  if (kind === "both") steps[index].run = "echo test";
  else delete steps[index].uses;
  expect(orderingProblems(workflow, ".github/workflows/release-publish.yml")).toEqual([
    `.github/workflows/release-publish.yml: job "stage-publish" step ${index + 1}: expected exactly one of uses or run`,
  ]);
});

test.each(["success()", "$" + "{{ failure() }}", "always()", "cancelled()", "ALWAYS ()"])(
  "job and step if %s is red",
  (condition) => {
    for (const [source, name] of [
      ["ci.yml", "build"],
      ["socket.yml", "socket-note"],
      ["codeql.yml", "analyze"],
    ]) {
      const workflow = loadWorkflow(source);
      const job = workflow.jobs?.[name];
      if (job === undefined) throw new Error(`Missing ${source} ${name}`);
      job.if = condition;
      expect(orderingProblems(workflow, `.github/workflows/${source}`)).toEqual([
        `.github/workflows/${source}: job "${name}": if contains a status-check function`,
      ]);
      delete job.if;
      const steps = job.steps ?? [];
      for (const [index, step] of steps.entries()) {
        if (step.run === CHECKER) continue;
        step.if = condition;
        expect(orderingProblems(workflow, `.github/workflows/${source}`)).toEqual([
          `.github/workflows/${source}: job "${name}" step ${index + 1}: if contains a status-check function`,
        ]);
        delete step.if;
      }
    }
  },
);

test.each([
  ["continue-on-error", true],
  ["if", "$" + "{{ false }}"],
  ["env", { CI: "" }],
  ["shell", "bash"],
  ["working-directory", "."],
  ["timeout-minutes", 1],
  ["id", "checker"],
  ["unlisted-key", false],
] satisfies [string, unknown][])("checker step key %s is red", (key, value) => {
  const workflow = loadWorkflow("ci.yml");
  const steps = workflow.jobs?.build.steps ?? [];
  const index = firstRunIndex(steps);
  expect(index).toBeGreaterThanOrEqual(0);
  steps[index][key] = value;
  expect(orderingProblems(workflow, ".github/workflows/ci.yml")).toEqual([
    `.github/workflows/ci.yml: job "build" step ${index + 1}: key "${key}" is not allowed`,
  ]);
});

test.each([
  ["continue-on-error", true],
  ["if", "$" + "{{ false }}"],
  ["strategy", { matrix: { attempt: [1] } }],
  ["needs", "other"],
  ["environment", "release"],
  ["unlisted-key", false],
] satisfies [string, unknown][])("verify-ancestry job key %s is red", (key, value) => {
  const workflow = loadWorkflow("release-publish.yml");
  const guard = workflow.jobs?.[ANCESTRY_JOB];
  if (guard === undefined) throw new Error("Missing verify-ancestry");
  guard[key] = value;
  expect(orderingProblems(workflow, ".github/workflows/release-publish.yml")).toEqual([
    `.github/workflows/release-publish.yml: job "verify-ancestry": key "${key}" is not allowed`,
  ]);
});

test.each([
  ["stage-publish", "always()"],
  ["github-release", "$" + "{{ !cancelled() }}"],
  ["stage-publish", "success()"],
  ["stage-publish", "failure()"],
  ["stage-publish", "$" + "{{ ALWAYS () }}"],
])("%s if %s is red", (name, condition) => {
  const workflow = loadWorkflow("release-publish.yml");
  const job = workflow.jobs?.[name];
  if (job === undefined) throw new Error(`Missing ${name}`);
  job.if = condition;
  expect(orderingProblems(workflow, ".github/workflows/release-publish.yml")).toEqual([
    `.github/workflows/release-publish.yml: job "${name}": if contains a status-check function`,
  ]);
});

test.each(["stage-publish", "github-release"])(
  "%s job keys and status-check functions are checked through transitive needs",
  (name) => {
    for (const transitive of [false, true]) {
      for (const key of ["continue-on-error", "strategy", "unlisted-key", "if"]) {
        const workflow = loadWorkflow("release-publish.yml");
        const jobs = workflow.jobs ?? {};
        if (transitive) {
          jobs.bridge = { ...jobs[name], needs: ANCESTRY_JOB };
          jobs[name].needs = "bridge";
        }
        jobs[name][key] = key === "if" ? "always()" : true;
        expect(orderingProblems(workflow, ".github/workflows/release-publish.yml")).toEqual([
          key === "if"
            ? `.github/workflows/release-publish.yml: job "${name}": if contains a status-check function`
            : `.github/workflows/release-publish.yml: job "${name}": key "${key}" is not allowed`,
        ]);
      }
    }
  },
);

test("a first run step different from the checker is red", () => {
  const workflow = parseYaml(
    [
      "jobs:",
      "  bun-i:",
      "    steps:",
      "      - run: bun i",
      `      - run: ${CHECKER}`,
      "  bun-a:",
      "    steps:",
      "      - run: bun a",
      `      - run: ${CHECKER}`,
      "  npm-prefix:",
      "    steps:",
      "      - run: npm --prefix . install",
      `      - run: ${CHECKER}`,
      "  continued:",
      "    steps:",
      "      - run: |",
      "          bun \\",
      "            install --frozen-lockfile",
      `      - run: ${CHECKER}`,
    ].join("\n"),
  ) as Workflow;
  expect(orderingProblems(workflow, "fixture.yml")).toEqual([
    `fixture.yml: job "bun-i" step 1: the first run step is not the ${CHECKER} checker`,
    `fixture.yml: job "bun-a" step 1: the first run step is not the ${CHECKER} checker`,
    `fixture.yml: job "npm-prefix" step 1: the first run step is not the ${CHECKER} checker`,
    `fixture.yml: job "continued" step 1: the first run step is not the ${CHECKER} checker`,
  ]);
});

test.each([
  "actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
  "actions/cache@55cc8345863c7cc4c66a329aec7e433d2d1c52a9",
  "unknown/action@main",
])("%s before the first run step is red", (uses) => {
  const workflow = loadWorkflow("ci.yml");
  const steps = workflow.jobs?.build.steps;
  expect(steps).toBeDefined();
  steps?.splice(0, 0, { uses });
  expect(orderingProblems(workflow, ".github/workflows/ci.yml")).toEqual([
    `.github/workflows/ci.yml: job "build" step 1: action "${uses}" is not allowed${uses.startsWith("actions/cache@") ? " before the first run step" : ""}${uses === "unknown/action@main" ? "; ref is not a full commit SHA" : ""}`,
  ]);
});

test.each([
  ["ci.yml", "build", "actions/checkout@main", 0],
  ["release-publish.yml", "verify-ancestry", "actions/checkout@main", 0],
  ["codeql.yml", "release-age", "oven-sh/setup-bun@main", 1],
  ["ci.yml", "build", "actions/checkout@3d3c42e", 0],
  ["ci.yml", "build", "actions/checkout@v4", 0],
  ["ci.yml", "build", "actions/checkout@", 0],
] as const)("%s job %s uses %s is red", (source, job, uses, index) => {
  const workflow = loadWorkflow(source);
  const step = workflow.jobs?.[job].steps?.[index];
  if (step === undefined) throw new Error(`Missing ${source} ${job} step ${index + 1}`);
  step.uses = uses;
  expect(orderingProblems(workflow, `.github/workflows/${source}`)).toContain(
    `.github/workflows/${source}: job "${job}" step ${index + 1}: action "${uses}" is not allowed; ref is not a full commit SHA`,
  );
});

test.each([...PRE_RUN_ACTIONS.keys()])(
  "%s with an unlisted input before the first run step is red",
  (action) => {
    const workflow = loadWorkflow("ci.yml");
    const steps = workflow.jobs?.build.steps ?? [];
    const step = steps.find((candidate) => actionOf(candidate) === action);
    expect(step).toBeDefined();
    if (step === undefined) throw new Error(`Missing ${action}`);
    step.with = { ...step.with, cache: "bun" };
    expect(orderingProblems(workflow, ".github/workflows/ci.yml")).toEqual([
      `.github/workflows/ci.yml: job "build" step ${steps.indexOf(step) + 1}: action "${step.uses}" input "cache" is not allowed`,
    ]);
  },
);

test("a step with neither uses nor run before the first run step is red", () => {
  const workflow = loadWorkflow("ci.yml");
  workflow.jobs?.build.steps?.splice(0, 0, { name: "empty" });
  expect(orderingProblems(workflow, ".github/workflows/ci.yml")).toEqual([
    '.github/workflows/ci.yml: job "build" step 1: expected exactly one of uses or run',
    '.github/workflows/ci.yml: job "build" step 1: action "<missing uses>" is not allowed before the first run step',
  ]);
});

test.each(['git update-ref refs/remotes/origin/main "$GITHUB_SHA"', "bun install"])(
  "%s before the ancestry guard is red",
  (run) => {
    const workflow = loadWorkflow("release-publish.yml");
    workflow.jobs?.[ANCESTRY_JOB].steps?.splice(1, 0, { run });
    expect(orderingProblems(workflow, ".github/workflows/release-publish.yml")).toEqual([
      '.github/workflows/release-publish.yml: job "verify-ancestry": expected exactly 2 steps (checkout, ancestry guard), found 3',
      '.github/workflows/release-publish.yml: job "verify-ancestry" step 2: expected run step named "Verify the run\'s commit is on main"',
    ]);
  },
);

test.each([
  ["extra action", (steps: Step[]) => steps.push({ uses: "unknown/action@main" })],
  ["reordered steps", (steps: Step[]) => steps.reverse()],
  [
    "extra checkout input",
    (steps: Step[]) => {
      steps[0].with = { ...steps[0].with, ref: "main" };
    },
  ],
  [
    "persisted credentials",
    (steps: Step[]) => {
      steps[0].with = { "persist-credentials": true };
    },
  ],
  [
    "missing persist-credentials",
    (steps: Step[]) => {
      steps[0].with = {};
    },
  ],
  [
    "extra guard input",
    (steps: Step[]) => {
      steps[1].with = { cache: "bun" };
    },
  ],
  [
    "renamed guard",
    (steps: Step[]) => {
      steps[1].name = "other";
    },
  ],
  [
    "missing guard run",
    (steps: Step[]) => {
      delete steps[1].run;
    },
  ],
  [
    "extra checkout run",
    (steps: Step[]) => {
      steps[0].run = "bun install";
    },
  ],
] satisfies [string, (steps: Step[]) => unknown][])("ancestry %s is red", (_name, mutate) => {
  const workflow = loadWorkflow("release-publish.yml");
  mutate(workflow.jobs?.[ANCESTRY_JOB].steps ?? []);
  expect(
    orderingProblems(workflow, ".github/workflows/release-publish.yml").length,
  ).toBeGreaterThan(0);
});

test.each([
  ["bahmutov/npm-install@v1", false],
  ["./.github/actions/install-deps", false],
  ["actions/cache/restore@55cc8345863c7cc4c66a329aec7e433d2d1c52a9", false],
  ["bahmutov/npm-install@v1", true],
] as const)("run-less action %s with contents write %s is red", (uses, write) => {
  const workflow = loadWorkflow("socket.yml");
  const jobs = workflow.jobs ?? {};
  jobs["uses-only"] = {
    needs: "socket-note",
    permissions: { contents: write ? "write" : "read" },
    steps: [{ uses }],
  };
  expect(orderingProblems(workflow, ".github/workflows/socket.yml")).toEqual([
    `.github/workflows/socket.yml: job "uses-only" step 1: action "${uses}" is not allowed${actionOf({ uses }) === undefined ? "; ref is not a full commit SHA" : ""}`,
  ]);
});

test("an unlisted action input after the checker is red", () => {
  const workflow = loadWorkflow("socket.yml");
  workflow.jobs?.["socket-note"].steps?.push({
    uses: "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1",
    with: { cache: "npm" },
  });
  expect(orderingProblems(workflow, ".github/workflows/socket.yml")).toEqual([
    '.github/workflows/socket.yml: job "socket-note" step 5: action "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1" input "cache" is not allowed',
  ]);
});

test("codeql analyze without needs is red", () => {
  const workflow = loadWorkflow("codeql.yml");
  const analyze = workflow.jobs?.analyze;
  if (analyze === undefined) throw new Error("Missing analyze");
  delete analyze.needs;
  expect(orderingProblems(workflow, ".github/workflows/codeql.yml")).toEqual([
    '.github/workflows/codeql.yml: job "analyze": a job with no run step must need a job whose first run step is the checker',
  ]);
});

test("a run-less job can need the checker through another run-less job", () => {
  const workflow = loadWorkflow("codeql.yml");
  const jobs = workflow.jobs ?? {};
  jobs.bridge = { needs: "release-age", steps: [{ ...jobs["release-age"].steps?.[0] }] };
  jobs.analyze.needs = "bridge";
  expect(orderingProblems(workflow, ".github/workflows/codeql.yml")).toEqual([]);
});

function dependsOn(jobs: Record<string, Job>, from: string, target: string): boolean {
  const stack = [...needsOf(jobs[from])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const name = stack.pop();
    if (name === undefined) continue;
    if (name === target) return true;
    if (seen.has(name)) continue;
    seen.add(name);
    const job = jobs[name];
    if (job !== undefined) stack.push(...needsOf(job));
  }
  return false;
}

function workflowSources(): string[] {
  return readdirSync(WORKFLOWS)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort();
}

function loadWorkflow(name: string): Workflow {
  return parseYaml(readFileSync(join(WORKFLOWS, name), "utf8")) as Workflow;
}

test("the release guard has no effective write permission or id-token and checkout sets persist-credentials false", () => {
  const workflow = loadWorkflow("release-publish.yml");
  const jobs = workflow.jobs ?? {};
  const guard = jobs[ANCESTRY_JOB];
  expect(guard).toBeDefined();
  expect(writePermissions(guard, workflow)).toEqual([]);
  expect(guard.permissions).not.toHaveProperty("id-token");
  const checkout = (guard.steps ?? []).find((step) => actionOf(step) === "actions/checkout");
  expect(checkout?.with?.["persist-credentials"]).toBe(false);
});

test("every release job with an effective write permission needs verify-ancestry directly or transitively", () => {
  const workflow = loadWorkflow("release-publish.yml");
  const jobs = workflow.jobs ?? {};
  expect(jobs[ANCESTRY_JOB]).toBeDefined();
  const privileged = Object.entries(jobs).filter(
    ([, job]) => writePermissions(job, workflow).length > 0,
  );
  expect(privileged.length).toBeGreaterThan(0);
  for (const [name] of privileged) {
    expect(dependsOn(jobs, name, ANCESTRY_JOB), `${name} must need verify-ancestry`).toBe(true);
  }
});

test("each job with an effective write permission outside release-publish.yml has no run step", () => {
  const problems: string[] = [];
  for (const source of workflowSources()) {
    if (source === "release-publish.yml") continue;
    const workflow = loadWorkflow(source);
    for (const [name, job] of Object.entries(workflow.jobs ?? {})) {
      if (writePermissions(job, workflow).length === 0) continue;
      if ((job.steps ?? []).some((step) => Object.hasOwn(step, "run"))) {
        problems.push(
          `.github/workflows/${source}: job "${name}" has an effective write permission and a run: step`,
        );
      }
    }
  }
  expect(problems).toEqual([]);
});

test.each([
  ["job write-all", { permissions: "write-all" }, { permissions: { contents: "read" } }],
  ["inherited write", {}, { permissions: { contents: "write" } }],
  ["repository default", {}, {}],
] satisfies [string, Job, Workflow][])("%s is counted as privileged", (_name, job, workflow) => {
  expect(writePermissions(job, workflow).length).toBeGreaterThan(0);
});

test("job permissions override workflow permissions", () => {
  expect(writePermissions({ permissions: {} }, { permissions: "write-all" })).toEqual([]);
  expect(writePermissions({}, { permissions: "read-all" })).toEqual([]);
  expect(writePermissions({}, { permissions: "write-all" })).toEqual(["write-all"]);
});

test("the release guard accepts a merged commit and refuses an unmerged commit", () => {
  const workflow = loadWorkflow("release-publish.yml");
  const steps = workflow.jobs?.[ANCESTRY_JOB]?.steps ?? [];
  expect(
    ancestryProblems(steps, '.github/workflows/release-publish.yml: job "verify-ancestry"'),
  ).toEqual([]);
  const script = steps[1].run;
  expect(typeof script).toBe("string");
  const root = mkdtempSync(join(tmpdir(), "bob-release-ancestry-"));
  const checkout = join(root, "checkout");
  const remote = join(root, "origin.git");
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Release guard test",
    GIT_AUTHOR_EMAIL: "guard@example.invalid",
    GIT_COMMITTER_NAME: "Release guard test",
    GIT_COMMITTER_EMAIL: "guard@example.invalid",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  function git(...args: string[]): string {
    const result = spawnSync("git", args, { cwd: root, env, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }
  try {
    git("init", "--bare", "--initial-branch=main", remote);
    git("init", "--initial-branch=main", checkout);
    git("-C", checkout, "remote", "add", "origin", remote);
    git("-C", checkout, "commit", "--allow-empty", "-m", "base");
    git("-C", checkout, "checkout", "-b", "merged");
    git("-C", checkout, "commit", "--allow-empty", "-m", "merged change");
    const merged = git("-C", checkout, "rev-parse", "HEAD");
    git("-C", checkout, "checkout", "main");
    git("-C", checkout, "merge", "--no-ff", "merged", "-m", "merge change");
    git("-C", checkout, "push", "origin", "main");
    git("-C", checkout, "checkout", "-b", "unmerged");
    git("-C", checkout, "commit", "--allow-empty", "-m", "unmerged change");
    const unmerged = git("-C", checkout, "rev-parse", "HEAD");
    for (const [sha, accepted] of [
      [merged, true],
      [unmerged, false],
    ] as const) {
      const result = spawnSync("bash", ["-euo", "pipefail", "-c", script as string], {
        cwd: checkout,
        env: { ...env, GITHUB_SHA: sha },
        encoding: "utf8",
      });
      if (accepted) expect(result.status, result.stderr).toBe(0);
      else {
        expect(result.status).not.toBeNull();
        expect(result.status).not.toBe(0);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
