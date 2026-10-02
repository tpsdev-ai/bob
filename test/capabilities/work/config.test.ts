// Config-level and import-level assertions for the managed run tool (bob#211):
//   * builder-local's allowlist holds run / run_status / run_cancel and NOT bash
//     (so "run replaces bash" is a fact of the config, not of load order);
//   * `run` is shell-equivalent for the resident policy (RESIDENT_EXCLUDED_TOOLS);
//   * the runner REUSES pi's exported primitives by import, and the group
//     signal is bob's one shared module — never a pattern kill;
//   * the "not a sandbox" facts are stated in the tool description, the role
//     soul and every result.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as pi from "@earendil-works/pi-coding-agent";
import { type WorkPiLike, wireWork } from "../../../src/capabilities/work/capability.js";
import { CONFIG_ENV_VAR, loadConfigFromEnv } from "../../../src/capabilities/work/config.js";
import {
  GROUP_PRIMITIVES,
  LIMITS_TEXT,
  PI_PRIMITIVES,
} from "../../../src/capabilities/work/run.js";
import { lookupCapability } from "../../../src/shell/capability-catalog.js";
import * as groupModule from "../../../src/shell/process-group.js";
import { loadRole } from "../../../src/shell/role-loader.js";
import {
  RESIDENT_EXCLUDED_TOOLS,
  residentDroppedTools,
  resolveToolPolicy,
} from "../../../src/shell/tool-allowlist.js";

const ROOT = join(import.meta.dir, "..", "..", "..");
const WORK_SRC = join(ROOT, "src", "capabilities", "work");

describe("builder-local: run replaces bash (config-level)", () => {
  it("the role's allowlist holds run, run_status and run_cancel, and not bash", () => {
    const allow = loadRole("builder-local").tools.allow;
    for (const t of ["run", "run_status", "run_cancel"]) expect(allow).toContain(t);
    expect(allow).not.toContain("bash");
    expect(allow).not.toContain("powershell");
    // The names resolve to the blessed work capability, not to a pi built-in.
    expect(lookupCapability("work")?.manifest.provides?.tools).toEqual([
      "run",
      "run_status",
      "run_cancel",
      "apply_patch",
    ]);
  });

  it("the role keeps its resident-shell opt-in (run needs it for a resident builder)", () => {
    expect(loadRole("builder-local").tools.allowResidentShell).toBe(true);
  });
});

describe("the resident gate treats run as a shell", () => {
  it("run is in RESIDENT_EXCLUDED_TOOLS beside bash and powershell", () => {
    expect(RESIDENT_EXCLUDED_TOOLS).toContain("run");
    expect(RESIDENT_EXCLUDED_TOOLS).toContain("bash");
    expect(RESIDENT_EXCLUDED_TOOLS).toContain("powershell");
    // run_status / run_cancel execute nothing and are not gated.
    expect(RESIDENT_EXCLUDED_TOOLS).not.toContain("run_status");
    expect(RESIDENT_EXCLUDED_TOOLS).not.toContain("run_cancel");
  });

  it("a resident role WITHOUT the opt-in loses run (and keeps run_status/run_cancel)", () => {
    const yaml =
      "resident: true\ntools:\n  allow:\n    - run\n    - run_status\n    - run_cancel\n";
    const policy = resolveToolPolicy({
      tools: { allow: ["run", "run_status", "run_cancel"] },
      role: { name: "some-role", allow: ["run", "run_status", "run_cancel"] },
      resident: true,
      yamlText: yaml,
    });
    expect(policy.excludeTools).toContain("run");
    expect(residentDroppedTools(policy)).toEqual(["run"]);
  });

  it("builder-local's opt-in keeps run for a resident agent", () => {
    const allow = ["run", "run_status", "run_cancel"];
    const policy = resolveToolPolicy({
      tools: { allow },
      role: { name: "builder-local", allow, allowResidentShell: true },
      persistent: true,
      yamlText: "tools:\n  allow:\n    - run\n",
    });
    expect(policy.excludeTools).toEqual([]);
    expect(residentDroppedTools(policy)).toEqual([]);
  });
});

describe("reuse: pi's primitives by import, bob's group ops by import", () => {
  it("getShellConfig, truncateTail and formatSize ARE pi's exports (identity, not a copy)", () => {
    expect(PI_PRIMITIVES.getShellConfig).toBe(pi.getShellConfig);
    expect(PI_PRIMITIVES.truncateTail).toBe(pi.truncateTail);
    expect(PI_PRIMITIVES.formatSize).toBe(pi.formatSize);
  });

  it("pi does not export its process-tree kill or child wait — the reason for the named local group ops", () => {
    // If pi starts exporting these, this fails and the runner should import them.
    const root = pi as unknown as Record<string, unknown>;
    expect(root.killProcessTree).toBeUndefined();
    expect(root.waitForChildProcess).toBeUndefined();
    expect(root.getShellEnv).toBeUndefined();
  });

  it("the group signal/probe is bob's one shared module (also the tps-mail consumer's)", () => {
    expect(GROUP_PRIMITIVES.NODE_GROUP_OPS).toBe(groupModule.NODE_GROUP_OPS);
    expect(GROUP_PRIMITIVES.probeGroup).toBe(groupModule.probeGroup);
    const consumer = readFileSync(join(ROOT, "src", "shell", "mail-consumer.ts"), "utf8");
    expect(consumer).toContain('from "./process-group.js"');
    expect(consumer).not.toMatch(/const NODE_GROUP_OPS/);
  });

  it("the work capability never kills by name or pattern", () => {
    for (const f of ["run.ts", "capability.ts", "index.ts"]) {
      const src = readFileSync(join(WORK_SRC, f), "utf8");
      expect(src, f).not.toMatch(/\bpkill\b|\bkillall\b|\bpgrep\b/);
    }
  });

  it("refuses group ids that would signal bob's own group or every process", () => {
    expect(groupModule.isOwnedGroupId(0)).toBe(false);
    expect(groupModule.isOwnedGroupId(1)).toBe(false);
    expect(groupModule.isOwnedGroupId(-5)).toBe(false);
    expect(groupModule.isOwnedGroupId(process.pid)).toBe(false);
    expect(groupModule.isOwnedGroupId(1.5)).toBe(false);
    expect(groupModule.probeGroup(1)).toBe("unknown");
  });
});

describe("not a sandbox — stated where a reader meets it", () => {
  function descriptions(): Record<string, string> {
    const out: Record<string, string> = {};
    const fake: WorkPiLike = {
      registerTool(tool) {
        out[tool.name] = tool.description;
      },
    };
    const { manager } = wireWork({
      pi: fake,
      stateRoot: "/nonexistent-bob-work-test",
      log: () => {},
    });
    manager.endRunSync();
    return out;
  }

  it("the run tool description carries both Limits sentences verbatim, the S1 deadline note and the facts", () => {
    const d = descriptions().run;
    expect(d).toContain(
      "A process-group backend cannot promise cleanup of descendants that leave the group. cleanup_state reports what was verified.",
    );
    expect(d).toContain(
      "run does not stop arbitrary same-user code from signalling the supervisor. It removes the builder's reason to do that; it is not a sandbox.",
    );
    expect(d).toContain("same user");
    expect(d).toContain("not containment");
    expect(d).toContain("Cancellation covers only jobs this tool started");
    expect(d).toContain("it does not yet clamp to the run's remaining budget");
    expect(d).toContain("600 s");
    expect(d).toContain("3600 s");
  });

  it("run_cancel's description says it cancels only this tool's jobs", () => {
    const d = descriptions().run_cancel;
    expect(d).toContain("only this tool's own jobs");
    expect(d).toContain("never matches processes by name or command line");
  });

  it("every result closes with the limits line", () => {
    expect(LIMITS_TEXT).toContain("process-group backend");
    expect(LIMITS_TEXT).toContain("same user");
    expect(LIMITS_TEXT).toContain("NOT a sandbox or containment");
    expect(LIMITS_TEXT).toContain("Descendants that leave the job's process group may survive");
    expect(LIMITS_TEXT).toContain("Cancellation covers only jobs this tool started");
  });

  it("the role soul states the facts, keeps the prohibition, and drops the retired procedures", () => {
    const soul = loadRole("builder-local").soul;
    expect(soul).toContain("in its own process group");
    expect(soul).toContain("same user");
    expect(soul).toContain("not a sandbox and not containment");
    expect(soul).toContain("a process that leaves its job's group can survive");
    expect(soul).toContain("`run_cancel` stops only the jobs `run` started");
    // The prohibition run cannot own stays.
    expect(soul).toContain("Never signal or kill a process outside `run`'s own jobs");
    // The retired procedures are gone.
    expect(soul).not.toContain("pass an explicit `timeout`");
    expect(soul).not.toContain("pkill -f");
    expect(soul).not.toContain("The shell tool has no default timeout");
  });
});

describe("config", () => {
  it("takes no config: an empty block loads, an unknown key is refused by name", () => {
    expect(loadConfigFromEnv({ [CONFIG_ENV_VAR]: "{}" })).toEqual({});
    expect(loadConfigFromEnv({})).toEqual({});
    expect(() => loadConfigFromEnv({ [CONFIG_ENV_VAR]: '{"defaultTimeoutS":5}' })).toThrow(
      /Slice 1 takes no work config/,
    );
  });
});
