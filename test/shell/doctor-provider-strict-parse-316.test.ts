// bob#316 — `bob doctor` must read `provider.name` with the SAME strict YAML
// parser a session uses, so the checks it runs are the ones the selected
// provider requires. Each case builds a real bob.yaml in a temp HOME and runs
// the real `bob doctor` entry point; the refusal case also runs the real
// session resolver (`resolveRunConfig`) to pin that doctor reports the same
// refusal the session gives.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DoctorCheck, runDoctor } from "../../src/shell/doctor.js";
import { resolveRunConfig } from "../../src/shell/run.js";

describe("bob#316 — doctor reads provider.name with the session's parser", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bob-316-doctor-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function writeAgentBobYaml(yaml: string): void {
    const agentDir = join(home, "agents", "testbot");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, "bob.yaml"), yaml);
  }

  function subscriptionCheck(): DoctorCheck | undefined {
    return runDoctor({
      name: "testbot",
      agentsRoot: join(home, "agents"),
      homeDir: home,
      flairKeysDir: join(home, ".flair", "keys"),
    }).checks.find((c) => c.name === "subscription auth");
  }

  it("runs the subscription check for a provider name with a trailing comment", () => {
    writeAgentBobYaml("provider:\n  name: xai # comment\n");
    const check = subscriptionCheck();
    // The session reads this provider as `xai`, a subscription provider, so
    // doctor must run that provider's subscription check (which fails here:
    // nothing is stored).
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("no credential stored for xai");
  });

  it("runs the subscription check for a flow-mapping provider block", () => {
    writeAgentBobYaml("provider: {name: xai}\n");
    const check = subscriptionCheck();
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("no credential stored for xai");
  });

  it("reports the session's own refusal for a provider name the session refuses", () => {
    const yaml = "provider:\n  name: [xai, openai-codex]\n";
    writeAgentBobYaml(yaml);

    // The session's provider resolution refuses this document (a non-scalar
    // name)...
    let sessionRefusal: string | undefined;
    try {
      resolveRunConfig({ name: "testbot", agentsRoot: join(home, "agents") });
    } catch (err) {
      sessionRefusal = err instanceof Error ? err.message : String(err);
    }
    expect(sessionRefusal).toBeDefined();

    // ...and doctor reports the same refusal rather than skipping the check.
    const check = subscriptionCheck();
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain(sessionRefusal as string);
  });
});
