// bob#345 — `bob doctor` must report a `provider` block with no `name` as a
// failure, matching the session's refusal, and name the remedy. Each case
// builds a real bob.yaml in a temp HOME and runs the real `bob doctor` entry
// point; the nameless case also runs the real session resolver, which refuses
// the same document.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DoctorCheck, runDoctor } from "../../src/shell/doctor.js";
import { resolveRunConfig } from "../../src/shell/run.js";

describe("bob#345 — doctor reports a provider block with no name", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "bob-345-doctor-"));
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

  it("fails a provider block with no name, naming the remedy, and the session refuses the same document", () => {
    writeAgentBobYaml("provider: {model: m, context_window: 100}\n");

    // The session's own resolution refuses this document (no provider.name)...
    let sessionRefusal: string | undefined;
    try {
      resolveRunConfig({ name: "testbot", agentsRoot: join(home, "agents") });
    } catch (err) {
      sessionRefusal = err instanceof Error ? err.message : String(err);
    }
    expect(sessionRefusal).toBeDefined();
    expect(sessionRefusal).toContain("missing provider.name");

    // ...and doctor reports the missing name as a failure that names the remedy.
    const check = subscriptionCheck();
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("provider.name is not declared");
    expect(check?.fix).toContain('add "name: <provider>" under "provider:"');
  });

  it("still runs the subscription check for a named provider, as before", () => {
    writeAgentBobYaml("provider:\n  name: openai-codex\n  model: gpt-5\n");
    const piAgent = join(home, "agents", "testbot", ".pi-agent");
    mkdirSync(piAgent, { recursive: true });
    writeFileSync(
      join(piAgent, "auth.json"),
      '{"openai-codex":{"type":"oauth","access":"a","refresh":"r","expires":123}}\n',
      { mode: 0o600 },
    );
    const check = subscriptionCheck();
    expect(check?.status).toBe("ok");
    expect(check?.detail).toContain("credential stored for openai-codex");
  });
});
