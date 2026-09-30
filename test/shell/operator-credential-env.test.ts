// The operator's Flair password (FLAIR_ADMIN_PASS) never reaches an agent
// session. bob's CLI takes it out of the environment at startup, and the one
// session factory removes it again for every other entry path, so no session
// — the hiring interview, onboard's interview, align's check-in — nor any
// child process one of its tools starts, inherits it.
//
// Each session here is REAL (bob's factory, pi's services and tools); only the
// interactive mode is replaced by a probe that runs inside the live session.
// The agent is an adopted builder, whose granted tools include bash, so for
// onboard and align the probe runs the session's OWN bash tool, as the model
// would, and reads the environment a tool child actually gets. The probe also
// starts a child with the session's environment, as Node does by default.
// (Under Bun, a child started with NO env option receives the process's
// initial environment block instead of process.env; bob runs on Node, and
// pi's tools pass process.env explicitly.)

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADMIN_PASS_ENV,
  DEFAULT_POSITIONS_ROOT,
  hireAgent,
  runAlign,
  runInteractiveSession,
  runOnboard,
  type SessionRunner,
} from "../../src/shell/index.js";

const PLACEHOLDER = "placeholder-not-a-real-admin-credential";
// A variable the probe MUST see, so an empty or broken probe cannot pass.
const VISIBLE = "BOB_TEST_VISIBLE_TO_SESSIONS";

interface Probe {
  hasBash: boolean;
  inProcess: string | undefined;
  toolEnv: string;
  childEnv: string;
}

// An interactive-session runner that builds the real session, then probes it.
function probingRunner(seen: Probe[]): SessionRunner {
  return (input) =>
    runInteractiveSession({
      ...input,
      modeFactory: (runtime) => ({
        run: async () => {
          try {
            const bash = runtime.session.agent.state.tools.find((t) => t.name === "bash");
            const result = bash ? await bash.execute("probe-env", { command: "env" }) : undefined;
            seen.push({
              hasBash: bash !== undefined,
              inProcess: process.env[ADMIN_PASS_ENV],
              toolEnv: JSON.stringify(result?.content ?? null),
              childEnv: spawnSync("/usr/bin/env", { encoding: "utf8", env: process.env }).stdout,
            });
          } finally {
            // Await the runtime's disposal before returning, as pi's interactive
            // mode does when it quits.
            await runtime.dispose();
          }
        },
      }),
    });
}

function expectNoOperatorPassword(probe: Probe, viaBash: boolean): void {
  expect(probe.hasBash).toBe(viaBash);
  // Known-present: the probe does read the session's environment.
  const seenEnvs = viaBash ? [probe.toolEnv, probe.childEnv] : [probe.childEnv];
  for (const seenEnv of seenEnvs) expect(seenEnv).toContain(VISIBLE);
  // Known-absent: the operator password, by name and by value.
  expect(probe.inProcess).toBeUndefined();
  for (const seenEnv of seenEnvs) {
    expect(seenEnv).not.toContain(ADMIN_PASS_ENV);
    expect(seenEnv).not.toContain(PLACEHOLDER);
  }
}

describe("FLAIR_ADMIN_PASS never reaches an agent session", () => {
  let base: string;
  let agentsRoot: string;
  let hostRoot: string;
  const saved = { pass: process.env[ADMIN_PASS_ENV], visible: process.env[VISIBLE] };

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "bob-opcred-"));
    agentsRoot = join(base, "agents");
    hostRoot = join(base, "host");
    mkdirSync(agentsRoot, { recursive: true });
    process.env[VISIBLE] = "yes";
  });
  afterEach(() => {
    for (const [key, value] of [
      [ADMIN_PASS_ENV, saved.pass],
      [VISIBLE, saved.visible],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(base, { recursive: true, force: true });
    // bob#248: under Bun, rmSync can return without an error and leave the
    // tree when something changes inside it during the removal. Check, so a
    // leftover fails this test by name instead of leaking silently.
    if (existsSync(base)) {
      throw new Error(
        `cleanup left ${base} behind: ${readdirSync(base, { recursive: true }).slice(0, 20).join(", ")}`,
      );
    }
  });

  const hire = (name: string, interview: SessionRunner) =>
    hireAgent({
      name,
      positionName: "builder",
      agentsRoot,
      hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      contextWindow: 200_000,
      skipFlair: true,
      interview,
    });

  // The hiring interview runs before the grant exists, under the fixed
  // read + write setup policy: no bash, so only the child probe applies.
  it("the hiring interview", async () => {
    const seen: Probe[] = [];
    process.env[ADMIN_PASS_ENV] = PLACEHOLDER;
    await hire("opc-hire", probingRunner(seen));
    expect(seen).toHaveLength(1);
    expectNoOperatorPassword(seen[0], false);
  });

  it("onboard's interview", async () => {
    const hired = await hire("opc-onb", async () => 0);
    const seen: Probe[] = [];
    process.env[ADMIN_PASS_ENV] = PLACEHOLDER;
    await runOnboard({
      name: "opc-onb",
      role: "coder",
      agentDir: hired.agentDir,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      sessionRunner: probingRunner(seen),
    });
    expect(seen).toHaveLength(1);
    // Setup sessions hold only read + write_soul (bob#204), so there is no bash
    // to probe with; the child-process probe still reads the session's environment.
    expectNoOperatorPassword(seen[0], false);
  });

  it("align's check-in", async () => {
    const hired = await hire("opc-aln", async () => 0);
    const seen: Probe[] = [];
    process.env[ADMIN_PASS_ENV] = PLACEHOLDER;
    await runAlign({
      name: "opc-aln",
      agentDir: hired.agentDir,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      hostRoot,
      positionsRoot: DEFAULT_POSITIONS_ROOT,
      sessionRunner: probingRunner(seen),
    });
    expect(seen).toHaveLength(1);
    // Setup sessions hold only read + write_soul (bob#204), so there is no bash
    // to probe with; the child-process probe still reads the session's environment.
    expectNoOperatorPassword(seen[0], false);
  });
});
