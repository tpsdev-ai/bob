// bob#241 — bob login / bob logout, and the doctor check that rides on them.
//
// The login/logout child is pi's interactive flow. A STUB pi (a script on PATH
// in the test's temp dir) stands in for it: it records its environment to a
// file, so the test can assert PI_CODING_AGENT_DIR is the agent's OWN directory
// and that nothing else was reachable. The stub never sees a credential.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../../src/shell/doctor.js";
import { initAgent } from "../../src/shell/init.js";
import { runLogin, runLogout } from "../../src/shell/login.js";

let root: string;
let agentsRoot: string;
let binDir: string;
let envFile: string;
let argvFile: string;
let savedPath: string | undefined;

// A stub `pi` on PATH. It records the environment it was given (and its argv)
// and exits with the requested code. bob's allowlist decides what it can see.
function writeStubPi(exitCode = 0): void {
  const path = join(binDir, "pi");
  writeFileSync(
    path,
    [
      "#!/bin/sh",
      `env > '${envFile}'`,
      `printf '%s\\n' "$@" > '${argvFile}'`,
      `exit ${exitCode}`,
      "",
    ].join("\n"),
  );
  chmodSync(path, 0o755);
}

function envValue(name: string): string | undefined {
  const line = readFileSync(envFile, "utf8")
    .split("\n")
    .find((l) => l.startsWith(`${name}=`));
  return line?.slice(name.length + 1);
}

function makeAgent(name: string, provider = "anthropic"): string {
  const res = initAgent({
    name,
    role: "reviewer",
    provider,
    model: provider === "openai-codex" ? "gpt-5" : "claude-sonnet-4-6",
    contextWindow: 200_000,
    agentsRoot,
    skipFlair: true,
  });
  return res.agentDir;
}

function subscriptionCheck(name: string) {
  const report = runDoctor({
    name,
    agentsRoot,
    homeDir: root,
    flairKeysDir: join(root, ".flair", "keys"),
  });
  return report.checks.find((c) => c.name === "subscription auth");
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-login-241-"));
  agentsRoot = join(root, "agents");
  binDir = join(root, "bin");
  mkdirSync(binDir, { recursive: true });
  envFile = join(root, "child-env.txt");
  argvFile = join(root, "child-argv.txt");
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${savedPath ?? ""}`;
  writeStubPi(0);
});

afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
});

describe("bob#241 — bob login runs pi's interactive flow with the agent's own config dir", () => {
  it("spawns pi with PI_CODING_AGENT_DIR set to the agent's own .pi-agent, and leaves another agent's store untouched", async () => {
    const alphaDir = makeAgent("alpha");
    const betaDir = makeAgent("beta");
    // A second agent's store, with known bytes. bob must not touch it.
    const betaAuth = join(betaDir, ".pi-agent", "auth.json");
    writeFileSync(betaAuth, '{"beta-provider":{"type":"api_key","key":"beta-key"}}\n', {
      mode: 0o600,
    });
    const betaBefore = readFileSync(betaAuth);
    // A sentinel env var the child must NOT inherit (the env is an allowlist).
    process.env.BOB_LOGIN_SENTINEL = "must-not-leak";

    const code = await runLogin({
      name: "alpha",
      agentsRoot,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    delete process.env.BOB_LOGIN_SENTINEL;

    expect(code).toBe(0);
    // The child ran pi's interactive `/login` and saw the agent's OWN dir.
    expect(envValue("PI_CODING_AGENT_DIR")).toBe(join(alphaDir, ".pi-agent"));
    expect(readFileSync(argvFile, "utf8").trim()).toBe("/login");
    // The environment is an allowlist: an ambient variable did not reach pi.
    expect(envValue("BOB_LOGIN_SENTINEL")).toBeUndefined();
    // No other agent's store was touched — byte for byte.
    expect(readFileSync(betaAuth)).toEqual(betaBefore);
  });

  it("passes the named provider to pi's /login", async () => {
    makeAgent("alpha");
    await runLogin({
      name: "alpha",
      provider: "openai-codex",
      agentsRoot,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    expect(readFileSync(argvFile, "utf8").trim()).toBe("/login openai-codex");
  });

  it("refuses an unknown agent, naming the agents directory it looked in", async () => {
    makeAgent("alpha");
    await expect(
      runLogin({ name: "ghost", agentsRoot, stdinIsTTY: true, stdoutIsTTY: true }),
    ).rejects.toThrow(`no agent "ghost" under ${agentsRoot}`);
  });

  it("refuses a non-interactive terminal, saying to run it in a terminal", async () => {
    makeAgent("alpha");
    await expect(
      runLogin({ name: "alpha", agentsRoot, stdinIsTTY: false, stdoutIsTTY: true }),
    ).rejects.toThrow(/interactive.*run it in a terminal/s);
    await expect(
      runLogin({ name: "alpha", agentsRoot, stdinIsTTY: true, stdoutIsTTY: false }),
    ).rejects.toThrow(/interactive.*run it in a terminal/s);
  });

  it("bob logout runs pi's /logout in the same agent's own config dir", async () => {
    const alphaDir = makeAgent("alpha");
    const code = await runLogout({
      name: "alpha",
      agentsRoot,
      stdinIsTTY: true,
      stdoutIsTTY: true,
    });
    expect(code).toBe(0);
    expect(envValue("PI_CODING_AGENT_DIR")).toBe(join(alphaDir, ".pi-agent"));
    expect(readFileSync(argvFile, "utf8").trim()).toBe("/logout");
  });
});

describe("bob#241 — doctor fails a subscription provider with no stored credential", () => {
  it("fails with the `bob login` remedy when the credential is absent", () => {
    makeAgent("subbot", "openai-codex");
    // The scaffold writes a placeholder api key — not a credential.
    const check = subscriptionCheck("subbot");
    expect(check?.status).toBe("fail");
    expect(check?.fix).toBe("bob login subbot openai-codex");
  });

  it("passes when the store holds a real credential for the provider", () => {
    const agentDir = makeAgent("subbot", "openai-codex");
    const auth = join(agentDir, ".pi-agent", "auth.json");
    writeFileSync(
      auth,
      `${JSON.stringify({ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1 } })}\n`,
      { mode: 0o600 },
    );
    const check = subscriptionCheck("subbot");
    expect(check?.status).toBe("ok");
  });

  it("does not add a check for a provider that is not a subscription provider", () => {
    makeAgent("apibot", "anthropic");
    expect(subscriptionCheck("apibot")).toBeUndefined();
  });
});
