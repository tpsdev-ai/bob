// bob#241 — bob login / bob logout, and the doctor check that rides on them.
//
// HOW PI'S LOGIN REALLY RUNS is a TUI slash command, not a process argument: pi
// hands its CLI startup arguments to `session.prompt`
// (pi dist/modes/interactive/interactive-mode.js:859), and `/login` and
// `/logout` run only on editor submits (…interactive-mode.js:2454). So bob runs
// pi's TUI attached to the terminal, in the agent's directory, with
// PI_CODING_AGENT_DIR set, and tells the operator to type the command.
//
// The tests use a STUB pi (a script) that stands in for the pi process: it
// records its environment, argv and cwd, and (as a real /login or /logout would)
// writes or removes a credential in the agent's own store. It proves bob SPAWNED
// a child with those argv/env/cwd — it does NOT prove a TUI was entered. It pins
// the REAL invocation shape — pi is spawned with NO arguments — so a change that
// passed a slash argument would fail here.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../../src/shell/doctor.js";
import { initAgent } from "../../src/shell/init.js";
import { resolvePiBin, runLogin, runLogout } from "../../src/shell/login.js";
import { type SpawnError, spawnNode } from "../cli-spawn.js";

const CLI = join(import.meta.dir, "..", "..", "dist", "cli.js");

let root: string;
let agentsRoot: string;
let binDir: string;
let envFile: string;
let argvFile: string;
let cwdFile: string;
let savedPath: string | undefined;

function oauthJson(provider: string): string {
  return `{"${provider}":{"type":"oauth","access":"a","refresh":"r","expires":123}}\n`;
}

// A stub `pi`: records env, argv and cwd; optionally writes an auth store (as a
// real /login would); exits with the requested code.
function writeStubPi(opts: { afterAuthJson?: string; exitCode?: number } = {}): void {
  const lines = [
    "#!/bin/sh",
    `env > '${envFile}'`,
    `printf '%s\\n' "$@" > '${argvFile}'`,
    `pwd > '${cwdFile}'`,
  ];
  if (opts.afterAuthJson !== undefined) {
    lines.push(`printf '%s' '${opts.afterAuthJson}' > "$PI_CODING_AGENT_DIR/auth.json"`);
  }
  lines.push(`exit ${opts.exitCode ?? 0}`, "");
  const path = join(binDir, "pi");
  writeFileSync(path, lines.join("\n"));
  chmodSync(path, 0o755);
}

const stubPi = () => join(binDir, "pi");

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

function capture() {
  const lines: string[] = [];
  return { lines, out: (l: string) => lines.push(l), err: (l: string) => lines.push(l) };
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
  cwdFile = join(root, "child-cwd.txt");
  savedPath = process.env.PATH;
  process.env.PATH = `${binDir}:${savedPath ?? ""}`;
});

afterEach(() => {
  process.env.PATH = savedPath;
  rmSync(root, { recursive: true, force: true });
});

describe("bob#241 — bob login runs pi's TUI with the agent's own config dir", () => {
  it("spawns pi with NO arguments, in the agent's directory, PI_CODING_AGENT_DIR set; a non-allowlisted env var is omitted and one other agent's store is untouched", async () => {
    writeStubPi({ afterAuthJson: oauthJson("openai-codex") });
    const alphaDir = makeAgent("alpha", "openai-codex");
    const betaDir = makeAgent("beta");
    const betaAuth = join(betaDir, ".pi-agent", "auth.json");
    writeFileSync(
      betaAuth,
      '{"beta-provider":{"type":"oauth","access":"a","refresh":"r","expires":1}}\n',
      { mode: 0o600 },
    );
    const betaBefore = readFileSync(betaAuth);
    process.env.BOB_LOGIN_SENTINEL = "must-not-leak";
    const cap = capture();

    const code = await runLogin({
      name: "alpha",
      provider: "openai-codex",
      agentsRoot,
      piBin: stubPi(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      out: cap.out,
      err: cap.err,
    });
    delete process.env.BOB_LOGIN_SENTINEL;

    expect(code).toBe(0);
    // bob spawned pi (the child ran), in the agent's own dir, with the agent's own store.
    expect(realpathSync(envValue("PI_CODING_AGENT_DIR") ?? "")).toBe(
      realpathSync(join(alphaDir, ".pi-agent")),
    );
    expect(readFileSync(cwdFile, "utf8").trim()).toBe(realpathSync(alphaDir));
    // NOT a slash argument — pi would send that to the model.
    expect(readFileSync(argvFile, "utf8").trim()).toBe("");
    // A var off the allowlist is omitted; an allowlisted one (PATH) is kept.
    expect(envValue("BOB_LOGIN_SENTINEL")).toBeUndefined();
    expect(envValue("PATH")).toBeDefined();
    // bob told the operator what to type.
    expect(cap.lines.join("\n")).toContain("type /login openai-codex");
    // The one other agent created here was untouched — byte for byte.
    expect(readFileSync(betaAuth)).toEqual(betaBefore);
  });

  it("uses bob.yaml's provider for its POST-RUN check when none is named (a bare /login still opens pi's own selector)", async () => {
    writeStubPi({ afterAuthJson: oauthJson("openai-codex") });
    makeAgent("alpha", "openai-codex");
    const cap = capture();
    const code = await runLogin({
      name: "alpha",
      agentsRoot,
      piBin: stubPi(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(0);
    expect(readFileSync(argvFile, "utf8").trim()).toBe("");
    expect(cap.lines.join("\n")).toContain("type /login ");
    expect(cap.lines.join("\n")).toContain("credential stored for openai-codex");
  });

  it("fails when pi exits 0 but stored nothing (a cancelled login)", async () => {
    writeStubPi({ exitCode: 0 }); // no credential written
    makeAgent("alpha", "openai-codex");
    const cap = capture();
    const code = await runLogin({
      name: "alpha",
      provider: "openai-codex",
      agentsRoot,
      piBin: stubPi(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(1);
    expect(cap.lines.join("\n")).toContain(
      "no credential that passes bob's local credential checks is stored for openai-codex",
    );
  });

  it("fails when the store is not valid JSON after the run", async () => {
    writeStubPi({ afterAuthJson: "not json at all\n" });
    makeAgent("alpha", "openai-codex");
    const cap = capture();
    const code = await runLogin({
      name: "alpha",
      provider: "openai-codex",
      agentsRoot,
      piBin: stubPi(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(1);
    expect(cap.lines.join("\n")).toContain("is not valid JSON");
  });

  it("fails when the operator cancels a sign-in for a provider that was already stored", async () => {
    writeStubPi({ exitCode: 0 }); // cancel: the stub writes nothing
    const dir = makeAgent("alpha", "openai-codex");
    writeFileSync(
      join(dir, ".pi-agent", "auth.json"),
      `{"openai-codex":{"type":"oauth","access":"a","refresh":"r","expires":1}}\n`,
      { mode: 0o600 },
    );
    const cap = capture();
    const code = await runLogin({
      name: "alpha",
      provider: "openai-codex",
      agentsRoot,
      piBin: stubPi(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(1);
    expect(cap.lines.join("\n")).toContain("already present");
  });

  it("succeeds when pi rewrites a store that already held the provider", async () => {
    // A re-sign-in that rewrites the credential leaves the store changed.
    writeStubPi({
      afterAuthJson:
        '{"openai-codex":{"type":"oauth","access":"bbbb","refresh":"rrrr","expires":2}}\n',
    });
    const dir = makeAgent("alpha", "openai-codex");
    writeFileSync(
      join(dir, ".pi-agent", "auth.json"),
      `{"openai-codex":{"type":"oauth","access":"a","refresh":"r","expires":1}}\n`,
      { mode: 0o600 },
    );
    const cap = capture();
    const code = await runLogin({
      name: "alpha",
      provider: "openai-codex",
      agentsRoot,
      piBin: stubPi(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(0);
    expect(cap.lines.join("\n")).toContain("credential stored for openai-codex");
  });

  it("fails when the operator signs in to a DIFFERENT provider (the target's credential is unchanged)", async () => {
    // pi writes a NEW provider and leaves openai-codex byte-identical.
    writeStubPi({
      afterAuthJson:
        '{"openai-codex":{"type":"oauth","access":"a","refresh":"r","expires":1},"xai":{"type":"oauth","access":"z","refresh":"z","expires":9}}\n',
    });
    const dir = makeAgent("alpha", "openai-codex");
    writeFileSync(
      join(dir, ".pi-agent", "auth.json"),
      `{"openai-codex":{"type":"oauth","access":"a","refresh":"r","expires":1}}\n`,
      { mode: 0o600 },
    );
    const cap = capture();
    const code = await runLogin({
      name: "alpha",
      provider: "openai-codex",
      agentsRoot,
      piBin: stubPi(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(1);
    expect(cap.lines.join("\n")).toContain("already present and unchanged");
  });

  it("fails when pi exits non-zero even though a credential was written", async () => {
    writeStubPi({ afterAuthJson: oauthJson("openai-codex"), exitCode: 2 });
    makeAgent("alpha", "openai-codex");
    const cap = capture();
    const code = await runLogin({
      name: "alpha",
      provider: "openai-codex",
      agentsRoot,
      piBin: stubPi(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(1);
    expect(cap.lines.join("\n")).toContain("bob cannot confirm the sign-in completed");
  });

  it("refuses an unknown agent, naming the agents directory", async () => {
    makeAgent("alpha");
    await expect(
      runLogin({ name: "ghost", agentsRoot, piBin: stubPi(), stdinIsTTY: true, stdoutIsTTY: true }),
    ).rejects.toThrow(`no agent "ghost" under ${agentsRoot}`);
  });

  it("refuses a non-interactive terminal", async () => {
    makeAgent("alpha");
    await expect(
      runLogin({
        name: "alpha",
        agentsRoot,
        piBin: stubPi(),
        stdinIsTTY: false,
        stdoutIsTTY: true,
      }),
    ).rejects.toThrow(/interactive.*run it in a terminal/s);
  });

  it("resolves the pi executable from the pi package path by default", () => {
    const bin = resolvePiBin();
    expect(bin).toContain("@earendil-works/pi-coding-agent");
    expect(bin).toMatch(/bundle[\\/]cli\.js$/);
  });

  it("refuses when the pi package path cannot be found, naming where it looked (never falls back to a PATH `pi`)", () => {
    const empty = mkdtempSync(join(tmpdir(), "bob-pi-search-"));
    try {
      expect(() => resolvePiBin(empty)).toThrow(
        /could not find the pi executable at the package path/,
      );
      // The refusal names the path it looked for...
      expect(() => resolvePiBin(empty)).toThrow(
        /pi-coding-agent[\s\S]*dist[\s\S]*bundle[\s\S]*cli\.js/,
      );
      // ...and the locations it searched.
      expect(() => resolvePiBin(empty)).toThrow(/location/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("bob#241 — bob logout", () => {
  it("spawns pi with no argument and succeeds when a credential was removed", async () => {
    writeStubPi({ afterAuthJson: oauthJson("anthropic") }); // openai-codex removed
    const dir = makeAgent("alpha", "openai-codex");
    writeFileSync(
      join(dir, ".pi-agent", "auth.json"),
      `{"openai-codex":{"type":"oauth","access":"a","refresh":"r","expires":1}}\n`,
      { mode: 0o600 },
    );
    const cap = capture();
    const code = await runLogout({
      name: "alpha",
      agentsRoot,
      piBin: stubPi(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(0);
    expect(readFileSync(argvFile, "utf8").trim()).toBe("");
    expect(cap.lines.join("\n")).toContain("removed openai-codex");
  });

  it("fails when the store is unchanged (a cancelled logout)", async () => {
    writeStubPi({ exitCode: 0 }); // no change
    const dir = makeAgent("alpha", "openai-codex");
    writeFileSync(
      join(dir, ".pi-agent", "auth.json"),
      `{"openai-codex":{"type":"oauth","access":"a","refresh":"r","expires":1}}\n`,
      { mode: 0o600 },
    );
    const cap = capture();
    const code = await runLogout({
      name: "alpha",
      agentsRoot,
      piBin: stubPi(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(1);
    expect(cap.lines.join("\n")).toContain("no credential was removed");
  });

  it("does not report a removal when a stored record only becomes unusable (its NAME is still stored)", async () => {
    // The record is still there after the run — as an unusable api_key — so no
    // provider name was removed even though the usable set changed.
    writeStubPi({ afterAuthJson: '{"openai-codex":{"type":"api_key"}}\n' });
    const dir = makeAgent("alpha", "openai-codex");
    writeFileSync(
      join(dir, ".pi-agent", "auth.json"),
      `{"openai-codex":{"type":"oauth","access":"a","refresh":"r","expires":1}}\n`,
      { mode: 0o600 },
    );
    const cap = capture();
    const code = await runLogout({
      name: "alpha",
      agentsRoot,
      piBin: stubPi(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(1);
    expect(cap.lines.join("\n")).toContain("no credential was removed");
    expect(cap.lines.join("\n")).not.toContain("removed openai-codex");
  });

  it("reports success when an ALREADY-UNUSABLE stored record is removed", async () => {
    writeStubPi({ afterAuthJson: "{}\n" }); // the unusable record is gone
    const dir = makeAgent("alpha", "openai-codex");
    writeFileSync(join(dir, ".pi-agent", "auth.json"), `{"openai-codex":{"type":"api_key"}}\n`, {
      mode: 0o600,
    });
    const cap = capture();
    const code = await runLogout({
      name: "alpha",
      agentsRoot,
      piBin: stubPi(),
      stdinIsTTY: true,
      stdoutIsTTY: true,
      out: cap.out,
      err: cap.err,
    });
    expect(code).toBe(0);
    expect(cap.lines.join("\n")).toContain("removed openai-codex");
  });

  it("the CLI refuses a provider argument to logout", () => {
    try {
      spawnNode([CLI, "logout", "alpha", "openai-codex"], { env: { ...process.env, HOME: root } });
      throw new Error("logout with a provider unexpectedly succeeded");
    } catch (err) {
      const e = err as SpawnError;
      expect(e.code).toBe(2);
      expect(e.stdout).toContain("takes no provider");
    }
  });

  it("the CLI refuses extra positionals to login", () => {
    try {
      spawnNode([CLI, "login", "alpha", "openai-codex", "extra"], {
        env: { ...process.env, HOME: root },
      });
      throw new Error("login with extra args unexpectedly succeeded");
    } catch (err) {
      const e = err as SpawnError;
      expect(e.code).toBe(2);
      expect(e.stdout).toContain("too many arguments");
    }
  });
});

describe("bob#241 — the doctor subscription-auth check", () => {
  it("fails with the `bob login` remedy when only a scaffold placeholder is stored", () => {
    makeAgent("subbot", "openai-codex"); // scaffold writes a placeholder api key
    const check = subscriptionCheck("subbot");
    expect(check?.status).toBe("fail");
    expect(check?.fix).toBe("bob login subbot openai-codex");
  });

  it("fails when a scaffold placeholder is supplied through an environment reference", () => {
    // The STORED key is "$BOB_R6_PLACEHOLDER", but it RESOLVES to a placeholder:
    // doctor must reject the resolved value, not just a literal one.
    const dir = makeAgent("subbot", "openai-codex");
    writeFileSync(
      join(dir, ".pi-agent", "auth.json"),
      `{"openai-codex":{"type":"api_key","key":"$BOB_R6_PLACEHOLDER","env":{"BOB_R6_PLACEHOLDER":"REPLACE_WITH_YOUR_API_KEY"}}}\n`,
      { mode: 0o600 },
    );
    const check = subscriptionCheck("subbot");
    expect(check?.status).toBe("fail");
    expect(check?.fix).toBe("bob login subbot openai-codex");
  });

  it("passes when the stored oauth credential has non-empty fields", () => {
    const dir = makeAgent("subbot", "openai-codex");
    writeFileSync(
      join(dir, ".pi-agent", "auth.json"),
      `{"openai-codex":{"type":"oauth","access":"a","refresh":"r","expires":1}}\n`,
      { mode: 0o600 },
    );
    expect(subscriptionCheck("subbot")?.status).toBe("ok");
  });

  it("fails when an api_key entry has no key (bob cannot resolve a usable key)", () => {
    const dir = makeAgent("subbot", "openai-codex");
    writeFileSync(join(dir, ".pi-agent", "auth.json"), `{"openai-codex":{"type":"api_key"}}\n`, {
      mode: 0o600,
    });
    const check = subscriptionCheck("subbot");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("does not pass bob's local credential checks");
    expect(check?.fix).toBe("bob login subbot openai-codex");
  });

  it("passes when an api_key resolves to a non-empty literal key", () => {
    const dir = makeAgent("subbot", "openai-codex");
    writeFileSync(
      join(dir, ".pi-agent", "auth.json"),
      `{"openai-codex":{"type":"api_key","key":"sk-live-abc"}}\n`,
      { mode: 0o600 },
    );
    expect(subscriptionCheck("subbot")?.status).toBe("ok");
  });

  it("fails when an api_key references an UNSET environment variable", () => {
    const dir = makeAgent("subbot", "openai-codex");
    delete process.env.BOB_R5_UNSET_243;
    writeFileSync(
      join(dir, ".pi-agent", "auth.json"),
      `{"openai-codex":{"type":"api_key","key":"$BOB_R5_UNSET_243"}}\n`,
      { mode: 0o600 },
    );
    const check = subscriptionCheck("subbot");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("does not pass bob's local credential checks");
  });

  it("passes when an api_key references a SET non-empty environment variable", () => {
    const dir = makeAgent("subbot", "openai-codex");
    process.env.BOB_R5_SET_243 = "resolved-key";
    try {
      writeFileSync(
        join(dir, ".pi-agent", "auth.json"),
        `{"openai-codex":{"type":"api_key","key":"$BOB_R5_SET_243"}}\n`,
        { mode: 0o600 },
      );
      expect(subscriptionCheck("subbot")?.status).toBe("ok");
    } finally {
      delete process.env.BOB_R5_SET_243;
    }
  });

  it("matches pi's resolver: an EMPTY stored env value falls back to the process variable", () => {
    // pi resolves `env?.[name] || process.env[name] || undefined`
    // (resolve-config-value.js:72), so a stored empty value falls back to the
    // process variable rather than resolving to no key.
    const dir = makeAgent("subbot", "openai-codex");
    process.env.BOB_R6_FALLBACK = "resolved-key";
    try {
      writeFileSync(
        join(dir, ".pi-agent", "auth.json"),
        `{"openai-codex":{"type":"api_key","key":"$BOB_R6_FALLBACK","env":{"BOB_R6_FALLBACK":""}}}\n`,
        { mode: 0o600 },
      );
      expect(subscriptionCheck("subbot")?.status).toBe("ok");
    } finally {
      delete process.env.BOB_R6_FALLBACK;
    }
  });

  it("does not count a command reference as a usable key (bob never executes it)", () => {
    const dir = makeAgent("subbot", "openai-codex");
    writeFileSync(
      join(dir, ".pi-agent", "auth.json"),
      `{"openai-codex":{"type":"api_key","key":"!echo nope"}}\n`,
      { mode: 0o600 },
    );
    expect(subscriptionCheck("subbot")?.status).toBe("fail");
  });

  it("fails the subscription-auth check when bob.yaml cannot be read", () => {
    const dir = makeAgent("subbot", "openai-codex");
    const yamlPath = join(dir, "bob.yaml");
    rmSync(yamlPath, { force: true });
    mkdirSync(yamlPath); // a directory: readFileSync fails, but the path exists
    const check = subscriptionCheck("subbot");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("cannot read");
    expect(check?.fix).toContain("bob.yaml");
  });

  it("fails the subscription-auth check when the provider block cannot be parsed", () => {
    const dir = makeAgent("subbot", "openai-codex");
    const yamlPath = join(dir, "bob.yaml");
    const original = readFileSync(yamlPath, "utf8");
    // A provider block that names a subscription provider but is an unsupported
    // nested mapping, so readBlock refuses it.
    writeFileSync(
      yamlPath,
      `provider:\n  name: openai-codex\n  auth:\n    mode: oauth\n\n${original}`,
    );
    const check = subscriptionCheck("subbot");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("provider block");
    expect(check?.fix).toContain("bob.yaml");
  });

  it("fails when the target entry fails bob's conservative store validation", () => {
    const dir = makeAgent("subbot", "openai-codex");
    writeFileSync(join(dir, ".pi-agent", "auth.json"), `{"openai-codex":{"token":"x"}}\n`, {
      mode: 0o600,
    });
    const check = subscriptionCheck("subbot");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("conservative store validation");
  });

  it("fails when an UNRELATED entry fails bob's validation (bob refuses the whole store)", () => {
    const dir = makeAgent("subbot", "openai-codex");
    writeFileSync(
      join(dir, ".pi-agent", "auth.json"),
      `{"openai-codex":{"type":"oauth","access":"a","refresh":"r","expires":1},"other":{"token":"x"}}\n`,
      { mode: 0o600 },
    );
    const check = subscriptionCheck("subbot");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("conservative store validation");
  });

  it("adds no check for a provider outside its scope (an API-key provider, and anthropic)", () => {
    makeAgent("apibot", "openai");
    expect(subscriptionCheck("apibot")).toBeUndefined();
    // anthropic is a pi subscription OAuth provider, but it is outside this
    // check's scope: bob's scaffold configures anthropic with an API key.
    makeAgent("antbot", "anthropic");
    expect(subscriptionCheck("antbot")).toBeUndefined();
  });
});

describe("bob#241 — the store read (absence vs. a failed read) and BOM handling", () => {
  it("treats an unreadable (EACCES) store as a failure, not as an absent store (doctor)", () => {
    const dir = makeAgent("subbot", "openai-codex");
    const piAgent = join(dir, ".pi-agent");
    writeFileSync(join(piAgent, "auth.json"), oauthJson("openai-codex"), { mode: 0o600 });
    // Strip the directory's search bit: readFileSync throws EACCES and — the
    // discriminating point — existsSync also returns false, so a code path that
    // gates on existsSync would treat this store as ABSENT.
    chmodSync(piAgent, 0o000);
    try {
      const check = subscriptionCheck("subbot");
      expect(check?.status).toBe("fail");
      // The store EXISTS but cannot be read: the failure names the read error,
      // it does not read as "no credential stored".
      expect(check?.detail).toContain("cannot read");
      expect(check?.detail).not.toContain("no credential stored");
    } finally {
      chmodSync(piAgent, 0o755);
    }
  });

  it("still treats a MISSING store as empty — the absent control", () => {
    const dir = makeAgent("subbot", "openai-codex");
    rmSync(join(dir, ".pi-agent", "auth.json"), { force: true });
    const check = subscriptionCheck("subbot");
    expect(check?.status).toBe("fail");
    expect(check?.detail).toContain("no credential stored");
    expect(check?.detail).not.toContain("cannot read");
  });

  it("refuses login BEFORE launching pi when the store cannot be read", async () => {
    writeStubPi({ afterAuthJson: oauthJson("openai-codex") });
    const dir = makeAgent("alpha", "openai-codex");
    const piAgent = join(dir, ".pi-agent");
    writeFileSync(join(piAgent, "auth.json"), oauthJson("openai-codex"), { mode: 0o600 });
    chmodSync(piAgent, 0o000);
    const cap = capture();
    try {
      const code = await runLogin({
        name: "alpha",
        provider: "openai-codex",
        agentsRoot,
        piBin: stubPi(),
        stdinIsTTY: true,
        stdoutIsTTY: true,
        out: cap.out,
        err: cap.err,
      });
      expect(code).toBe(1);
    } finally {
      chmodSync(piAgent, 0o755);
    }
    expect(cap.lines.join("\n")).toContain("cannot read");
    // The stub pi records its argv/cwd as soon as it runs: their absence proves
    // bob refused before it spawned the child.
    expect(existsSync(argvFile)).toBe(false);
    expect(existsSync(cwdFile)).toBe(false);
  });

  it("parses a BOM-prefixed auth.json (pi strips the BOM before JSON.parse)", () => {
    const dir = makeAgent("subbot", "openai-codex");
    writeFileSync(join(dir, ".pi-agent", "auth.json"), `\uFEFF${oauthJson("openai-codex")}`, {
      mode: 0o600,
    });
    expect(subscriptionCheck("subbot")?.status).toBe("ok");
  });
});
