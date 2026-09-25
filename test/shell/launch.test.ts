// `bob launch <name> [pi args…]` — the pi CLI session for an agent, started
// with the agent's RESOLVED tool policy.
//
// This is the launch path the generated `bin/<name>` launcher runs, and
// therefore the path the mail consumer reaches when it invokes that launcher.
// Before this change the launcher called `exec pi --provider … --model …`
// itself, so an interactive or mail-driven session came up with pi's defaults
// (read, bash, edit, write) plus whatever pi felt like enabling — the same hole
// `bob run` had.
//
// Three levels, all three needed:
//   * launchAgent's argv — what pi is handed (the unit level);
//   * the REAL generated launcher, run as a script, reaching a stub pi through
//     the real `bob launch` (the chain level);
//   * the mail consumer driving that same launcher (the consumer level).
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { initAgent } from "../../src/shell/init.js";
import { MailConsumer } from "../../src/shell/mail-consumer.js";
import type { SpawnFn } from "../../src/shell/onboard.js";
import { loadRole } from "../../src/shell/role-loader.js";
import { launchAgent } from "../../src/shell/run.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// A fake spawn that records the argv + env and exits 0. Same shape as
// onboard.test.ts's fake (a minimal ChildProcess that emits 'exit').
function fakeSpawn(): {
  spawnFn: SpawnFn;
  cmds: string[];
  argvs: string[][];
  envs: NodeJS.ProcessEnv[];
} {
  const cmds: string[] = [];
  const argvs: string[][] = [];
  const envs: NodeJS.ProcessEnv[] = [];
  const spawnFn: SpawnFn = (cmd, args, options) => {
    cmds.push(cmd);
    argvs.push([...args]);
    envs.push(options.env ?? {});
    // biome-ignore lint/suspicious/noExplicitAny: minimal ChildProcess stub
    const ee = new EventEmitter() as any;
    queueMicrotask(() => ee.emit("exit", 0));
    return ee;
  };
  return { spawnFn, cmds, argvs, envs };
}

const AGENT = "testbot";

// A hand-written agent dir: bob.yaml + the dirs resolveRunConfig expects.
// `role` is the ceiling the allowlist is checked against.
function makeAgent(
  root: string,
  opts: {
    role?: string;
    allow?: string[];
    resident?: boolean;
    provider?: string;
    model?: string;
  } = {},
): string {
  const agentDir = join(root, AGENT);
  mkdirSync(join(agentDir, "work"), { recursive: true });
  mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
  const lines = [
    "agent:",
    `  id: ${AGENT}`,
    `  role: ${opts.role ?? "ea"}`,
    "",
    "provider:",
    `  name: ${opts.provider ?? "anthropic"}`,
    `  model: ${opts.model ?? "claude-sonnet-4-6"}`,
    "",
  ];
  if (opts.resident) lines.push("resident: true", "");
  lines.push("tools:", "  allow:");
  for (const name of opts.allow ?? ["read"]) lines.push(`    - ${name}`);
  lines.push("");
  writeFileSync(join(agentDir, "bob.yaml"), lines.join("\n"));
  return agentDir;
}

describe("launchAgent — the pi CLI session gets the resolved policy", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-launch-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("hands pi EXACTLY the resolved allowlist (--tools)", async () => {
    makeAgent(root, { role: "ea", allow: ["read", "flair_search"] });
    const { spawnFn, argvs } = fakeSpawn();
    const code = await launchAgent({ name: AGENT, agentsRoot: root, spawnFn });

    expect(code).toBe(0);
    const args = argvs[0];
    const i = args.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("read,flair_search");
    // Not pi's defaults, and not an empty strict list either.
    expect(args).not.toContain("--no-tools");
  });

  it("spells an EMPTY allowlist as --no-tools, never as an empty --tools value", async () => {
    // "No tools" is a decision. `--tools ""` would be an empty name list, which
    // pi reads as "no allowlist given" and leaves its defaults in place — the
    // fail-open shape this whole area exists to close.
    makeAgent(root, { role: "ea", allow: [] });
    const { spawnFn, argvs } = fakeSpawn();
    await launchAgent({ name: AGENT, agentsRoot: root, spawnFn });
    expect(argvs[0]).toContain("--no-tools");
    expect(argvs[0]).not.toContain("--tools");
  });

  it("carries the resident policy as --exclude-tools", async () => {
    // qa does not grant allowResidentShell, so a resident qa agent loses the
    // shell + file-writing tools even though its allowlist names bash.
    makeAgent(root, { role: "qa", allow: ["read", "bash"], resident: true });
    const { spawnFn, argvs } = fakeSpawn();
    await launchAgent({ name: AGENT, agentsRoot: root, spawnFn });
    const args = argvs[0];
    const i = args.indexOf("--exclude-tools");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1].split(",").sort()).toEqual(["bash", "edit", "powershell", "write"]);
  });

  it("keeps a resident coder's shell (the role grants allowResidentShell)", async () => {
    makeAgent(root, { role: "coder", allow: ["read", "bash"], resident: true });
    const { spawnFn, argvs } = fakeSpawn();
    await launchAgent({ name: AGENT, agentsRoot: root, spawnFn });
    expect(argvs[0]).not.toContain("--exclude-tools");
  });

  it("translates the bob provider to pi's provider id, and passes the model", async () => {
    makeAgent(root, {
      role: "ea",
      allow: ["read"],
      provider: "exe-dev-gateway",
      model: "claude-x",
    });
    const { spawnFn, argvs } = fakeSpawn();
    await launchAgent({ name: AGENT, agentsRoot: root, spawnFn });
    const args = argvs[0];
    expect(args[args.indexOf("--provider") + 1]).toBe("anthropic");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-x");
    expect(args).not.toContain("exe-dev-gateway");
  });

  it("loads the agent's capability extensions with their config env", async () => {
    const agentsRoot = mkdtempSync(join(tmpdir(), "bob-launch-init-"));
    try {
      const res = initAgent({
        name: AGENT,
        role: "ea",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        agentsRoot,
        flairKeysDir: join(agentsRoot, "keys"),
        skipFlair: true,
      });
      const { spawnFn, argvs, envs } = fakeSpawn();
      await launchAgent({ name: AGENT, agentsRoot, spawnFn });

      // The capability extension, by resolved path — same sources the SDK path
      // hands pi's resource loader.
      const args = argvs[0];
      const ext = args.filter((_a, i) => args[i - 1] === "--extension");
      expect(ext.length).toBeGreaterThan(0);
      for (const source of ext) expect(source).toContain("/dist/capabilities/");
      // Config for each capability, and the not-the-persistent-runtime signal.
      expect(Object.keys(envs[0]).some((k) => k.startsWith("BOB_CAP_"))).toBe(true);
      expect(envs[0].BOB_PERSISTENT).toBe("");
      // bob.yaml + soul.md are read from THIS agent dir, not ~/agents.
      expect(res.agentDir.startsWith(agentsRoot)).toBe(true);
    } finally {
      rmSync(agentsRoot, { recursive: true, force: true });
    }
  });

  it("forwards the launcher's own args to pi verbatim", async () => {
    makeAgent(root, { role: "ea", allow: ["read"] });
    const { spawnFn, argvs } = fakeSpawn();
    await launchAgent({
      name: AGENT,
      agentsRoot: root,
      spawnFn,
      args: ["--thinking", "high", "do the thing"],
    });
    const args = argvs[0];
    expect(args.slice(-3)).toEqual(["--thinking", "high", "do the thing"]);
  });

  it("REFUSES to start a session when bob.yaml declares no tool policy", async () => {
    const agentDir = makeAgent(root, { role: "ea", allow: ["read"] });
    writeFileSync(
      join(agentDir, "bob.yaml"),
      [
        "agent:",
        `  id: ${AGENT}`,
        "  role: ea",
        "",
        "provider:",
        "  name: anthropic",
        "  model: claude-sonnet-4-6",
        "",
      ].join("\n"),
    );
    const { spawnFn, cmds } = fakeSpawn();
    await expect(launchAgent({ name: AGENT, agentsRoot: root, spawnFn })).rejects.toThrow(
      /no tools: block/,
    );
    // Nothing was started — a policy-less session is the defect.
    expect(cmds).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The CHAIN: the real generated launcher, run as a script, reaching a stub pi
// through the real `bob launch` (via BOB_BIN). This is what "the generated
// launcher's session receives exactly the resolved allowlist" means end to
// end — not a mock, the emitted script plus the real CLI.
// ---------------------------------------------------------------------------

interface Chain {
  agentsRoot: string;
  agentDir: string;
  launcher: string;
  binDir: string;
  // The argv of the ONE pi invocation this chain makes, one arg per line.
  // (An arg's own newlines are flattened: only --append-system-prompt has any,
  // and the flags under test never do.)
  piArgv: () => string[];
  env: NodeJS.ProcessEnv;
}

// A stub `pi` that records its argv, and a `bob` shim that runs THIS checkout's
// CLI. The shim is what the launcher's BOB_BIN gets, so the policy is resolved
// by the real code under test.
function makeChain(root: string): Chain {
  const agentsRoot = join(root, "agents");
  const res = initAgent({
    name: AGENT,
    role: "ea",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    agentsRoot,
    // Under HOME=root (below): the generated launcher hardcodes
    // AGENT_DIR=$HOME/agents/<name>, and bob.yaml's keyFile is ~-relative.
    flairKeysDir: join(root, ".flair", "keys"),
    skipFlair: true,
  });

  const binDir = join(root, "stub-bin");
  mkdirSync(binDir, { recursive: true });

  const callsFile = join(root, "pi-argv.txt");
  writeFileSync(callsFile, "");
  const piStub = join(binDir, "pi");
  writeFileSync(
    piStub,
    [
      "#!/bin/sh",
      "# Record the argv, one argument per line. Newlines inside an argument are",
      "# flattened to spaces (only --append-system-prompt carries them).",
      `for a in "$@"; do printf %s "$a" | tr "\\n" " "; printf "\\n"; done >> ${callsFile}`,
      "exit 0",
      "",
    ].join("\n"),
  );
  chmodSync(piStub, 0o755);

  const bobShim = join(root, "bob-shim");
  writeFileSync(bobShim, `#!/bin/sh\nexec bun ${join(repoRoot, "src", "cli.ts")} "$@"\n`);
  chmodSync(bobShim, 0o755);

  return {
    agentsRoot,
    agentDir: res.agentDir,
    launcher: join(res.agentDir, "bin", AGENT),
    binDir,
    piArgv: () =>
      readFileSync(callsFile, "utf8")
        .split("\n")
        .filter((l) => l !== ""),
    env: {
      ...process.env,
      // The launcher resolves AGENT_DIR from $HOME, so the chain has to run with
      // a HOME that contains the agent the test just scaffolded.
      HOME: root,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      BOB_BIN: bobShim,
    },
  };
}

describe("the generated launcher's session", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-chain-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("starts pi with EXACTLY the role's resolved allowlist", () => {
    const chain = makeChain(root);
    const run = spawnSync(chain.launcher, ["hello"], {
      env: chain.env,
      encoding: "utf8",
    });
    expect(run.status).toBe(0);

    const argv = chain.piArgv();
    expect(argv.length).toBeGreaterThan(0);
    const i = argv.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    // The ea role's own allowlist, read from roles/ea/role.json — resolved at
    // launch time by bob, not baked into the launcher.
    expect(argv[i + 1]).toBe(loadRole("ea").tools.allow.join(","));
    // And the prompt the human passed arrived.
    expect(argv[argv.length - 1]).toBe("hello");
  });

  it("has no way to start pi without bob resolving the policy", () => {
    // The launcher script itself carries no pi flags: if it did, the policy
    // would be whatever the script said, which is the hole being closed.
    const chain = makeChain(root);
    const script = readFileSync(chain.launcher, "utf8");
    expect(script).toContain('launch testbot -- "$@"');
    // Comments name the flags on purpose; the EXECUTED lines must carry none.
    const code = script
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"))
      .join("\n");
    expect(code).not.toContain("--tools");
    expect(code).not.toContain("--provider");
  });
});

describe("the mail consumer's session", () => {
  let root: string;
  let savedBobBin: string | undefined;
  let savedPath: string | undefined;
  let savedHome: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-mail-chain-"));
    savedBobBin = process.env.BOB_BIN;
    savedPath = process.env.PATH;
    savedHome = process.env.HOME;
  });

  afterEach(() => {
    // The consumer spawns the launcher with the inherited env, so the chain is
    // wired through the test process's env — restore it.
    if (savedBobBin === undefined) delete process.env.BOB_BIN;
    else process.env.BOB_BIN = savedBobBin;
    if (savedPath !== undefined) process.env.PATH = savedPath;
    if (savedHome !== undefined) process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  it("drives the agent's session through bob — with the resolved allowlist", async () => {
    const chain = makeChain(root);
    process.env.BOB_BIN = chain.env.BOB_BIN;
    process.env.PATH = chain.env.PATH;
    process.env.HOME = chain.env.HOME;

    const inboxRoot = join(root, "inbox");
    // Both queues: poll() moves a handled message from new/ to cur/, and a
    // missing cur/ would count as a dispatch failure rather than the chain.
    mkdirSync(join(inboxRoot, "new"), { recursive: true });
    mkdirSync(join(inboxRoot, "cur"), { recursive: true });
    writeFileSync(
      join(inboxRoot, "new", "1-mail.json"),
      JSON.stringify({
        id: "m1",
        from: "flint",
        to: AGENT,
        // One token: the stub pi records space-joined argv, so a multi-word
        // prompt cannot be asserted back apart.
        body: "ping",
        timestamp: "2026-09-25T00:00:00Z",
      }),
    );

    const consumer = new MailConsumer({
      name: AGENT,
      inboxRoot,
      launcherPath: chain.launcher,
      lockFile: join(root, "lock"),
    });
    await consumer.poll();
    expect(consumer.stats.processed).toBe(1);
    expect(consumer.stats.failed).toBe(0);

    const argv = chain.piArgv();
    expect(argv.length).toBeGreaterThan(0);
    const i = argv.indexOf("--tools");
    expect(i).toBeGreaterThan(-1);
    expect(argv[i + 1]).toBe(loadRole("ea").tools.allow.join(","));
    // The mail body reaches the session as the prompt.
    expect(argv[argv.length - 1]).toBe("ping");
  });
});
