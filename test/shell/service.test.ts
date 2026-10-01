import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectPlatform,
  down,
  installService,
  type LaunchctlRunner,
  plistPath,
  renderPlist,
  renderSystemdUnit,
  resolveNodeExecutable,
  restart,
  serviceCommandArgs,
  serviceLabel,
  servicePath,
  systemdUnitName,
  systemdUnitPath,
  up,
} from "../../src/shell/service.js";
import { spawnNode } from "../cli-spawn.js";

const HOME = "/Users/test";
// A fixed interpreter for render assertions (the real default is the resolved
// Node executable — see resolveNodeExecutable).
const INTERPRETER = "/opt/node/bin/node";
// The repo's bin/bob — the acceptance test runs the unit's OWN command line.
const BOB_BIN = fileURLToPath(new URL("../../bin/bob", import.meta.url));
// The built CLI, for the test that reads its printed install-service command.
const CLI = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));

// Capture launchctl/systemctl invocations without running the real binary.
function captureRunner(): { runner: LaunchctlRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: LaunchctlRunner = async (args) => {
    calls.push(args);
    return { code: 0, stderr: "" };
  };
  return { runner, calls };
}

// The installer uid the direct resolver tests, and the installService tests
// that resolve, inject: the running uid, which owns the temp directories the
// tests create. TRUST also turns the administrators-group exception off, so
// those results do not depend on the host's group database; tests about those
// rules override it. The CLI test's child process resolves with its own real
// uid and the host's default group policy. (The owner test is skipped when the
// suite runs as root.)
const ME = process.getuid?.() ?? 0;
const TRUST = { getUid: () => ME, adminGid: null };

// Temp directories the file-level fixtures create, removed after the file.
const fixtureDirs: string[] = [];
afterAll(() => {
  for (const dir of fixtureDirs) rmSync(dir, { recursive: true, force: true });
});

// A fresh 0700 temp directory holding an executable stub named node: a TRUSTED
// PATH entry. A test that passes it as its only PATH entry resolves this stub,
// never the host's node.
function stubNodeDir(prefix: string): { dir: string; node: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  fixtureDirs.push(dir);
  chmodSync(dir, 0o700);
  const node = join(dir, "node");
  writeFileSync(node, "#!/bin/sh\n");
  chmodSync(node, 0o755);
  return { dir, node };
}

// A REAL Node binary, for the acceptance tests that EXECUTE the rendered unit's
// command (`bob --help`). It is a fixture to run, not the resolution under test,
// so it is found without the trust screen: BOB_TEST_NODE when set, else the
// first `node` on this process's PATH that is a regular file with execute
// permission. This lookup is the one place these tests read the host's PATH.
// With neither, those tests are skipped, except under CI, where they run and
// fail naming this remedy.
function findRealNode(): string | undefined {
  const fromEnv = process.env.BOB_TEST_NODE;
  if (fromEnv) return fromEnv;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir.startsWith("/")) continue;
    const candidate = join(dir, "node");
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not here
    }
  }
  return undefined;
}
const REAL_NODE = findRealNode();
function realNode(): string {
  if (REAL_NODE === undefined) {
    throw new Error(
      "no Node binary to run the unit's command: set BOB_TEST_NODE or put node on PATH",
    );
  }
  return REAL_NODE;
}
const itWithRealNode = it.skipIf(REAL_NODE === undefined && !process.env.CI);

describe("renderPlist", () => {
  it("references the PERSISTENT entrypoint (bob run <name>)", () => {
    const xml = renderPlist({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      interpreter: INTERPRETER,
      home: HOME,
    });
    expect(xml).toContain("<string>/usr/local/bin/bob</string>");
    expect(xml).toContain("<string>run</string>");
    expect(xml).toContain("<string>pulse</string>");
    // The interpreter is absolute and comes BEFORE the bob script (bob#218).
    expect(xml).toContain(
      `    <string>${INTERPRETER}</string>\n    <string>/usr/local/bin/bob</string>`,
    );
  });

  it("sets KeepAlive + RunAtLoad (the agent self-runs)", () => {
    const xml = renderPlist({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      interpreter: INTERPRETER,
      home: HOME,
    });
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
  });

  it("uses a stable, unique Label per agent", () => {
    const xml = renderPlist({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      interpreter: INTERPRETER,
      home: HOME,
    });
    expect(serviceLabel("pulse")).toBe("ai.tpsdev.bob.pulse");
    expect(xml).toContain("<string>ai.tpsdev.bob.pulse</string>");
  });

  it("threads a model override into ProgramArguments", () => {
    const xml = renderPlist({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      model: "claude-fast",
      interpreter: INTERPRETER,
      home: HOME,
    });
    expect(xml).toContain("<string>--model</string>");
    expect(xml).toContain("<string>claude-fast</string>");
  });

  it("NEVER embeds a token or any secret (security)", () => {
    const xml = renderPlist({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      interpreter: INTERPRETER,
      home: HOME,
    });
    // No env-var block at all, and nothing token-shaped.
    expect(xml).not.toContain("EnvironmentVariables");
    expect(xml).not.toContain("TOKEN");
    expect(xml.toLowerCase()).not.toContain("token");
    expect(xml.toLowerCase()).not.toContain("secret");
  });

  it("points logs + WorkingDirectory at the agent's home", () => {
    const xml = renderPlist({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      interpreter: INTERPRETER,
      home: HOME,
    });
    expect(xml).toContain(`<string>${HOME}/agents/pulse/work</string>`);
    expect(xml).toContain(`<string>${HOME}/agents/pulse/service.out.log</string>`);
    expect(xml).toContain(`<string>${HOME}/agents/pulse/service.err.log</string>`);
  });

  it("XML-escapes injected values (defense in depth)", () => {
    const xml = renderPlist({
      name: "pulse",
      bobBin: "/opt/bob & co/bob",
      model: 'a"<b>',
      interpreter: INTERPRETER,
      home: HOME,
    });
    expect(xml).toContain("/opt/bob &amp; co/bob");
    expect(xml).toContain("a&quot;&lt;b&gt;");
    expect(xml).not.toContain('a"<b>');
  });

  it("rejects an invalid agent name (path/XML injection defense)", () => {
    expect(() =>
      renderPlist({ name: "../evil", bobBin: "/bin/bob", interpreter: INTERPRETER }),
    ).toThrow(/invalid agent name/);
    expect(() =>
      renderPlist({ name: "a b", bobBin: "/bin/bob", interpreter: INTERPRETER }),
    ).toThrow(/invalid agent name/);
  });
});

describe("plistPath", () => {
  it("lives under ~/Library/LaunchAgents with the service label", () => {
    expect(plistPath("pulse", HOME)).toBe(`${HOME}/Library/LaunchAgents/ai.tpsdev.bob.pulse.plist`);
  });
});

describe("installService (launchd)", () => {
  it("writes the plist to the LaunchAgents path via the injected writer", async () => {
    const written: Array<{ path: string; contents: string }> = [];
    const res = await installService({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      interpreter: INTERPRETER,
      home: HOME,
      platform: "launchd",
      writeFile: (path, contents) => written.push({ path, contents }),
    });
    expect(res.path).toBe(`${HOME}/Library/LaunchAgents/ai.tpsdev.bob.pulse.plist`);
    expect(written).toHaveLength(1);
    expect(written[0].path).toBe(res.path);
    expect(written[0].contents).toContain("ai.tpsdev.bob.pulse");
    expect(written[0].contents.toLowerCase()).not.toContain("token");
  });
});

// CI runs on Linux, so detectPlatform() would default to systemd — the launchd
// lifecycle tests pin platform: "launchd" to exercise the launchctl branch.
describe("lifecycle (launchd) — up / down / restart invoke the right launchctl ops", () => {
  const launchd = { home: HOME, getUid: () => 501, platform: "launchd" as const };

  it("up → bootstrap gui/<uid> <plist>", async () => {
    const { runner, calls } = captureRunner();
    await up({ name: "pulse", ...launchd, runLaunchctl: runner });
    expect(calls).toEqual([
      ["bootstrap", "gui/501", `${HOME}/Library/LaunchAgents/ai.tpsdev.bob.pulse.plist`],
    ]);
  });

  it("down → bootout gui/<uid> <plist>", async () => {
    const { runner, calls } = captureRunner();
    await down({ name: "pulse", ...launchd, runLaunchctl: runner });
    expect(calls).toEqual([
      ["bootout", "gui/501", `${HOME}/Library/LaunchAgents/ai.tpsdev.bob.pulse.plist`],
    ]);
  });

  it("restart → kickstart -k gui/<uid>/<label> (graceful: SIGTERM then relaunch)", async () => {
    const { runner, calls } = captureRunner();
    await restart({ name: "pulse", ...launchd, runLaunchctl: runner });
    expect(calls).toEqual([["kickstart", "-k", "gui/501/ai.tpsdev.bob.pulse"]]);
  });

  it("surfaces a launchctl failure with the args (no secrets in these commands)", async () => {
    const runner: LaunchctlRunner = async () => ({
      code: 5,
      stderr: "Bootstrap failed: 5: Input/output error",
    });
    await expect(up({ name: "pulse", ...launchd, runLaunchctl: runner })).rejects.toThrow(
      /launchctl bootstrap .* failed \(exit 5\)/,
    );
  });
});
// Parse systemd ExecStart= value back into an argv array: split on double-
// quoted tokens (with \ escaping) and unquoted spaces.
function execStart(unit: string): string[] {
  const line = unit.split("\n").find((l) => l.startsWith("ExecStart="));
  if (!line) throw new Error("no ExecStart in the systemd unit");
  const raw = line.slice("ExecStart=".length);
  const tokens: string[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i] === " ") {
      i++;
      continue;
    }
    if (raw[i] === '"') {
      i++;
      let token = "";
      while (i < raw.length && raw[i] !== '"') {
        if (raw[i] === "\\" && i + 1 < raw.length) {
          token += raw[i + 1];
          i += 2;
        } else {
          token += raw[i];
          i++;
        }
      }
      i++;
      tokens.push(token);
    } else {
      let token = "";
      while (i < raw.length && raw[i] !== " ") {
        token += raw[i];
        i++;
      }
      tokens.push(token);
    }
  }
  return tokens;
}

describe("systemd backend", () => {
  it("renderSystemdUnit runs the persistent entrypoint + Restart=always, no secret", () => {
    const unit = renderSystemdUnit({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      interpreter: INTERPRETER,
      home: HOME,
    });
    expect(unit).toContain(`ExecStart="${INTERPRETER}" "/usr/local/bin/bob" "run" "pulse"`);
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain(`WorkingDirectory=${HOME}/agents/pulse/work`);
    expect(unit).toContain(`StandardError=append:${HOME}/agents/pulse/service.err.log`);
    expect(unit.toLowerCase()).not.toContain("token");
    expect(unit.toLowerCase()).not.toContain("secret");
  });

  it("renderSystemdUnit threads a model override + rejects bad names", () => {
    const unit = renderSystemdUnit({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      model: "claude-fast",
      interpreter: INTERPRETER,
      home: HOME,
    });
    expect(unit).toContain(
      `ExecStart="${INTERPRETER}" "/usr/local/bin/bob" "run" "pulse" "--model" "claude-fast"`,
    );
    expect(() =>
      renderSystemdUnit({ name: "../evil", bobBin: "/bin/bob", interpreter: INTERPRETER }),
    ).toThrow(/invalid agent name/);
  });

  it("systemdUnitPath + servicePath resolve the user-unit location", () => {
    expect(systemdUnitName("pulse")).toBe("bob-pulse.service");
    expect(systemdUnitPath("pulse", HOME)).toBe(`${HOME}/.config/systemd/user/bob-pulse.service`);
    expect(servicePath("pulse", { platform: "systemd", home: HOME })).toBe(
      `${HOME}/.config/systemd/user/bob-pulse.service`,
    );
  });

  it("installService writes the user unit + runs daemon-reload", async () => {
    const written: Array<{ path: string; contents: string }> = [];
    const { runner, calls } = captureRunner();
    const res = await installService({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      interpreter: INTERPRETER,
      home: HOME,
      platform: "systemd",
      writeFile: (path, contents) => written.push({ path, contents }),
      runSystemctl: runner,
    });
    expect(res.path).toBe(`${HOME}/.config/systemd/user/bob-pulse.service`);
    expect(written[0].path).toBe(res.path);
    expect(written[0].contents).toContain(
      `ExecStart="${INTERPRETER}" "/usr/local/bin/bob" "run" "pulse"`,
    );
    expect(calls).toEqual([["--user", "daemon-reload"]]);
  });

  it("up/down/restart map to systemctl --user enable/disable/restart", async () => {
    const sysd = { home: HOME, platform: "systemd" as const };

    const u = captureRunner();
    await up({ name: "pulse", ...sysd, runSystemctl: u.runner });
    expect(u.calls).toEqual([["--user", "enable", "--now", "bob-pulse.service"]]);

    const d = captureRunner();
    await down({ name: "pulse", ...sysd, runSystemctl: d.runner });
    expect(d.calls).toEqual([["--user", "disable", "--now", "bob-pulse.service"]]);

    const r = captureRunner();
    await restart({ name: "pulse", ...sysd, runSystemctl: r.runner });
    expect(r.calls).toEqual([["--user", "restart", "bob-pulse.service"]]);
  });

  it("surfaces a systemctl failure with the args", async () => {
    const runner: LaunchctlRunner = async () => ({ code: 1, stderr: "Failed to connect to bus" });
    await expect(
      up({ name: "pulse", home: HOME, platform: "systemd", runSystemctl: runner }),
    ).rejects.toThrow(/systemctl --user enable --now bob-pulse.service failed \(exit 1\)/);
  });

  it("detectPlatform: darwin → launchd, linux → systemd", () => {
    expect(detectPlatform("launchd")).toBe("launchd");
    expect(detectPlatform("systemd")).toBe("systemd");
    // No override → host platform (just assert it returns a valid backend).
    expect(["launchd", "systemd"]).toContain(detectPlatform());
  });

  it("ExecStart quoting: fixtures with space, backslash, and double-quote (bob#222)", () => {
    const unit = renderSystemdUnit({
      name: "pulse",
      bobBin: '/opt/bo"b \\path/bin/bob',
      interpreter: '/usr/local/it "ner/bin/node',
      home: HOME,
    });
    // The systemd renderer must quote every argument; execStart() decodes back
    // to the original argv array, including spaces, backslashes, and quotes
    // embedded in path names.
    const argv = execStart(unit);
    expect(argv[0]).toBe('/usr/local/it "ner/bin/node');
    expect(argv[1]).toBe('/opt/bo"b \\path/bin/bob');
    expect(argv[3]).toBe("pulse");
  });

  it("renderSystemdUnit throws when an ExecStart arg contains line breaks (bob#222)", () => {
    const badPath = "/usr/local/bin/node\nbad";
    expect(() =>
      renderSystemdUnit({
        name: "pulse",
        bobBin: '/opt/bo"b \\path/bin/bob',
        interpreter: badPath,
        home: HOME,
      }),
    ).toThrow(/refusing ExecStart argument with line breaks/);
  });
});

describe("the unit does not depend on the service manager's PATH (bob#218)", () => {
  // No `interpreter` given: the renderer resolves one with the injected deps (an
  // installer whose execPath is not named node; a PATH holding one trusted stub
  // node), never the host's.
  it("launchd: the default interpreter is the resolved absolute path", () => {
    const { dir, node } = stubNodeDir("bob-render-default-");
    const deps = { ...TRUST, execPath: "/opt/bun/bin/bun", pathEnv: dir };
    const xml = renderPlist({ name: "pulse", bobBin: "/usr/local/bin/bob", home: HOME, ...deps });
    expect(resolveNodeExecutable(deps)).toBe(node);
    expect(node.startsWith("/")).toBe(true);
    expect(xml).toContain(`    <string>${node}</string>\n    <string>/usr/local/bin/bob</string>`);
  });

  it("systemd: the default interpreter is the resolved absolute path", () => {
    const { dir, node } = stubNodeDir("bob-render-default-");
    const deps = { ...TRUST, execPath: "/opt/bun/bin/bun", pathEnv: dir };
    const unit = renderSystemdUnit({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      home: HOME,
      ...deps,
    });
    expect(resolveNodeExecutable(deps)).toBe(node);
    expect(unit).toContain(`ExecStart="${node}" "/usr/local/bin/bob" "run" "pulse"`);
  });
});

describe("resolveNodeExecutable — the unit runs bob under node (bob#218)", () => {
  it("returns the installer's own interpreter when it IS node", () => {
    expect(resolveNodeExecutable({ ...TRUST, execPath: "/usr/local/bin/node", pathEnv: "" })).toBe(
      "/usr/local/bin/node",
    );
  });

  it("finds node on the installer's PATH when the installer is not node", () => {
    const dir = mkdtempSync(join(tmpdir(), "bob-node-path-"));
    writeFileSync(join(dir, "node"), "#!/bin/sh\n");
    chmodSync(join(dir, "node"), 0o755);
    try {
      expect(resolveNodeExecutable({ ...TRUST, execPath: "/opt/bun/bin/bun", pathEnv: dir })).toBe(
        join(dir, "node"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a RELATIVE PATH entry: the unit never depends on the installer's working directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "bob-node-rel-"));
    writeFileSync(join(dir, "node"), "#!/bin/sh\n");
    chmodSync(join(dir, "node"), 0o755);
    try {
      const rel = relative(process.cwd(), dir); // a RELATIVE PATH entry
      expect(rel.startsWith("/")).toBe(false); // premise: it IS relative
      // premise: the same directory, named absolutely, IS chosen
      expect(resolveNodeExecutable({ ...TRUST, execPath: "/opt/bun/bin/bun", pathEnv: dir })).toBe(
        join(dir, "node"),
      );
      expect(() =>
        resolveNodeExecutable({ ...TRUST, execPath: "/opt/bun/bin/bun", pathEnv: rel }),
      ).toThrow(/no Node executable found/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips a DIRECTORY named node in favour of a real node file later on PATH", () => {
    const dirOnly = mkdtempSync(join(tmpdir(), "bob-node-isdir-"));
    const fileDir = mkdtempSync(join(tmpdir(), "bob-node-isfile-"));
    mkdirSync(join(dirOnly, "node")); // a DIRECTORY named node
    writeFileSync(join(fileDir, "node"), "#!/bin/sh\n");
    chmodSync(join(fileDir, "node"), 0o755);
    try {
      const delimiter = process.platform === "win32" ? ";" : ":";
      const resolved = resolveNodeExecutable({
        ...TRUST,
        execPath: "/opt/bun/bin/bun",
        pathEnv: `${dirOnly}${delimiter}${fileDir}`,
      });
      // The directory is skipped; the real file later on PATH is chosen.
      expect(resolved).toBe(join(fileDir, "node"));
    } finally {
      rmSync(dirOnly, { recursive: true, force: true });
      rmSync(fileDir, { recursive: true, force: true });
    }
  });

  it("refuses with the engines floor and the PATH remedy when no node is found", () => {
    const empty = mkdtempSync(join(tmpdir(), "bob-no-node-"));
    try {
      expect(() =>
        resolveNodeExecutable({ ...TRUST, execPath: "/opt/bun/bin/bun", pathEnv: empty }),
      ).toThrow(/22\.19\.0/);
      expect(() =>
        resolveNodeExecutable({ ...TRUST, execPath: "/opt/bun/bin/bun", pathEnv: empty }),
      ).toThrow(/on PATH/);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("resolveNodeExecutable — a PATH symlink over a versioned target (bob#228)", () => {
  // A real, executable file standing in for the running interpreter (the
  // versioned Homebrew Cellar target on macOS).
  function versionedNode(): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), "bob-node-versioned-"));
    const file = join(dir, "node");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
    return { dir, file };
  }

  it("writes a PATH symlink that resolves to the running interpreter, not the versioned target", () => {
    const versioned = versionedNode();
    const stableDir = mkdtempSync(join(tmpdir(), "bob-node-stable-"));
    const stable = join(stableDir, "node");
    symlinkSync(versioned.file, stable); // /opt/homebrew/bin/node -> .../Cellar/node/<v>/bin/node
    try {
      const resolved = resolveNodeExecutable({
        ...TRUST,
        execPath: versioned.file,
        pathEnv: stableDir,
      });
      expect(resolved).toBe(stable);
      expect(resolved).not.toBe(versioned.file);
    } finally {
      rmSync(versioned.dir, { recursive: true, force: true });
      rmSync(stableDir, { recursive: true, force: true });
    }
  });

  it("falls back to the running interpreter when no PATH node resolves to it", () => {
    const versioned = versionedNode();
    const emptyDir = mkdtempSync(join(tmpdir(), "bob-node-empty-"));
    try {
      const resolved = resolveNodeExecutable({
        ...TRUST,
        execPath: versioned.file,
        pathEnv: emptyDir,
      });
      expect(resolved).toBe(versioned.file);
    } finally {
      rmSync(versioned.dir, { recursive: true, force: true });
      rmSync(emptyDir, { recursive: true, force: true });
    }
  });

  it("does NOT choose a PATH node that is a symlink to a DIFFERENT binary", () => {
    const versioned = versionedNode();
    const otherDir = mkdtempSync(join(tmpdir(), "bob-node-other-"));
    const other = join(otherDir, "node");
    writeFileSync(other, "#!/bin/sh\n");
    chmodSync(other, 0o755);
    const stableDir = mkdtempSync(join(tmpdir(), "bob-node-elsewhere-"));
    const elsewhere = join(stableDir, "node");
    symlinkSync(other, elsewhere); // points at a DIFFERENT binary
    try {
      const resolved = resolveNodeExecutable({
        ...TRUST,
        execPath: versioned.file,
        pathEnv: stableDir,
      });
      // The non-matching symlink is not chosen; the fallback is execPath.
      expect(resolved).not.toBe(elsewhere);
      expect(resolved).toBe(versioned.file);
    } finally {
      rmSync(versioned.dir, { recursive: true, force: true });
      rmSync(otherDir, { recursive: true, force: true });
      rmSync(stableDir, { recursive: true, force: true });
    }
  });
});

// The trust screen: a PATH `node` is a candidate only when it is reached through
// an ABSOLUTE PATH entry and every directory on the way to its file, symlink
// targets included, is owned by the installer or root; a directory holding a
// symlink or the final name of the path or of a link target is writable by no
// one else (write by the injected administrators group excepted), and any
// other directory is group- or other-writable only with the sticky bit or,
// besides its owner, writable only by the injected administrators group (see
// resolveNodeExecutable). The directories these tests create get explicit
// modes; inherited ancestors (the temp root and above) keep the host's. The
// running uid is the installer.
describe("resolveNodeExecutable — a PATH node is a candidate only through a trusted, absolute entry (bob#233)", () => {
  const delimiter = process.platform === "win32" ? ";" : ":";
  const BUN = "/opt/bun/bin/bun"; // an installer whose execPath is not named node
  const NO_NODE = /no Node executable found/;
  // The refusal's remedy: the trust rule's requirements, stated exactly.
  const REMEDY =
    "(to be trusted, every directory on the way must be owned by you or root; the directory holding node and every directory holding a symlink or the entry a symlink points to must not be writable by group or others, and any other directory may be only if it has the sticky bit; on macOS, write access for the admin group, but not for others, is allowed)";
  const scratch: string[] = [];
  afterAll(() => {
    for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
  });

  // A fresh temp directory owned by the running uid, set to `mode` (default 0700).
  function tempDir(prefix: string, mode = 0o700): string {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    scratch.push(dir);
    chmodSync(dir, mode);
    return dir;
  }
  // Nested directories under `parent`, each 0755 whatever the umask.
  function subdirs(parent: string, ...names: string[]): string {
    let dir = parent;
    for (const name of names) {
      dir = join(dir, name);
      mkdirSync(dir);
      chmodSync(dir, 0o755);
    }
    return dir;
  }
  // Make `dir` 1777 (world-writable + sticky, like /tmp). bun's fs.chmodSync
  // drops the sticky bit, so this runs chmod(1) and asserts the bit is set.
  function makeSticky(dir: string): void {
    const r = spawnSync("/bin/chmod", ["1777", dir], { encoding: "utf8", timeout: 10_000 });
    expect(r.status).toBe(0);
    expect(statSync(dir).mode & 0o7777).toBe(0o1777);
  }
  // An executable regular file named node in `dir`.
  function nodeFile(dir: string): string {
    const file = join(dir, "node");
    writeFileSync(file, "#!/bin/sh\n");
    chmodSync(file, 0o755);
    return file;
  }
  // A symlink named node in `dir`, pointing at `target`.
  function nodeLink(dir: string, target: string): string {
    const link = join(dir, "node");
    symlinkSync(target, link);
    return link;
  }

  describe("directory trust (finding 1)", () => {
    it("a 0777 directory whose node symlinks to the running interpreter is not chosen: alone on PATH the fallback applies; a trusted matching symlink later on PATH wins", () => {
      const versioned = nodeFile(tempDir("bob-trust-versioned-"));
      const open = tempDir("bob-trust-0777-", 0o777);
      nodeLink(open, versioned);
      expect(resolveNodeExecutable({ ...TRUST, execPath: versioned, pathEnv: open })).toBe(
        versioned,
      );
      // A trusted matching symlink LATER on PATH is still chosen: the untrusted
      // entry is skipped, not fatal.
      const closed = tempDir("bob-trust-0700-");
      const stable = nodeLink(closed, versioned);
      expect(
        resolveNodeExecutable({
          ...TRUST,
          execPath: versioned,
          pathEnv: `${open}${delimiter}${closed}`,
        }),
      ).toBe(stable);
    });

    it("a group-writable directory is not chosen when its group is not the administrators group", () => {
      const dir = tempDir("bob-trust-0775-", 0o775);
      nodeFile(dir);
      expect(() =>
        resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: dir, adminGid: null }),
      ).toThrow(NO_NODE);
    });

    it("group write by the administrators group is accepted (an admin-group-shaped fixture with an injected gid); other-write never is", () => {
      const dir = tempDir("bob-trust-admin-", 0o775);
      const node = nodeFile(dir);
      const gid = statSync(dir).gid;
      expect(resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: dir, adminGid: gid })).toBe(
        node,
      );
      const open = tempDir("bob-trust-admin-0777-", 0o777);
      nodeFile(open);
      expect(() =>
        resolveNodeExecutable({
          ...TRUST,
          execPath: BUN,
          pathEnv: open,
          adminGid: statSync(open).gid,
        }),
      ).toThrow(NO_NODE);
    });

    it("a sticky, world-writable directory holding node is not chosen (the sticky bit excuses only an ancestor)", () => {
      const dir = tempDir("bob-trust-sticky-holder-");
      makeSticky(dir);
      nodeFile(dir);
      expect(() =>
        resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: dir, adminGid: null }),
      ).toThrow(NO_NODE);
    });

    it.skipIf(process.getuid?.() === 0)(
      "a directory owned by neither the installer nor root is not chosen",
      () => {
        const dir = tempDir("bob-trust-owner-");
        const node = nodeFile(dir);
        // premise: the installer that owns it does choose it
        expect(
          resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: dir, getUid: () => ME }),
        ).toBe(node);
        expect(() =>
          resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: dir, getUid: () => ME + 1 }),
        ).toThrow(NO_NODE);
      },
    );

    it("an ancestor writable by others rejects the candidate unless it has the sticky bit", () => {
      const outer = tempDir("bob-trust-ancestor-", 0o777);
      const bin = subdirs(outer, "bin");
      chmodSync(bin, 0o700);
      const node = nodeFile(bin);
      expect(() =>
        resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: bin, adminGid: null }),
      ).toThrow(NO_NODE);
      makeSticky(outer); // now like /tmp
      expect(resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: bin, adminGid: null })).toBe(
        node,
      );
    });

    it("a symlink is judged by where it leads: a node link or a PATH directory link into a 0777 directory is not chosen", () => {
      const open = tempDir("bob-trust-target-", 0o777);
      const target = nodeFile(open);
      // A trusted directory whose node symlinks INTO the untrusted one.
      const holder = tempDir("bob-trust-linkholder-");
      nodeLink(holder, target);
      expect(() => resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: holder })).toThrow(
        NO_NODE,
      );
      // A PATH entry that is itself a symlink to the untrusted directory.
      const parent = tempDir("bob-trust-dirlink-");
      const linked = join(parent, "bin");
      symlinkSync(open, linked);
      expect(() => resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: linked })).toThrow(
        NO_NODE,
      );
      // premise: a PATH directory link into a TRUSTED directory is chosen (the
      // directory is nested in a 0700 parent, since the entry a link lands on
      // must sit in a holder-grade directory, which a sticky /tmp is not).
      const good = subdirs(tempDir("bob-trust-gooddir-"), "good");
      nodeFile(good);
      const goodLink = join(parent, "good");
      symlinkSync(good, goodLink);
      expect(resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: goodLink })).toBe(
        join(goodLink, "node"),
      );
    });

    // Every symlink met while resolving the path, a PATH directory link
    // included, must sit in a HOLDER-grade directory, and so must the entry each
    // link lands on. A sticky, world-writable directory (like /tmp) protects
    // entries its users do not own, but a link there could be retargeted by its
    // owner after the unit is written.
    describe("every symlink on the resolution path meets the holder rule", () => {
      // A 0755 directory holding a node symlink to `versioned`, nested in a 0700
      // parent, so only the link under test decides the outcome.
      function trustedNodeHome(versioned: string): string {
        const home = subdirs(tempDir("bob-sym-target-"), "bin");
        nodeLink(home, versioned);
        return home;
      }

      it("a PATH entry that is a directory symlink in a sticky, world-writable directory is refused; as the only PATH entry, the fallback applies", () => {
        const versioned = nodeFile(tempDir("bob-sym-versioned-"));
        const target = trustedNodeHome(versioned);
        const sticky = tempDir("bob-sym-sticky-");
        makeSticky(sticky);
        const link = join(sticky, "bin");
        symlinkSync(target, link);
        // An installer named node does not take the matching link; with no other
        // PATH entry, it gets its own execPath.
        expect(resolveNodeExecutable({ ...TRUST, execPath: versioned, pathEnv: link })).toBe(
          versioned,
        );
        // An installer not named node refuses, naming the rejected path.
        expect(() => resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: link })).toThrow(
          `Skipped as untrusted: ${join(link, "node")}`,
        );
      });

      it("positive control: the same directory symlink in a trusted (0700) holder is chosen", () => {
        const versioned = nodeFile(tempDir("bob-sym-versioned-"));
        const target = trustedNodeHome(versioned);
        const link = join(tempDir("bob-sym-holder-"), "bin");
        symlinkSync(target, link);
        expect(resolveNodeExecutable({ ...TRUST, execPath: versioned, pathEnv: link })).toBe(
          join(link, "node"),
        );
        expect(resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: link })).toBe(
          join(link, "node"),
        );
      });

      it("a symlink whose target lands on an entry in a sticky, world-writable directory is refused", () => {
        const versioned = nodeFile(tempDir("bob-sym-versioned-"));
        const sticky = tempDir("bob-sym-sticky-target-");
        makeSticky(sticky);
        // The installer's own 0755 directory, holding node, directly in the sticky one.
        const landing = subdirs(sticky, "real");
        nodeLink(landing, versioned);
        // premise: named directly (no link), it is chosen: the sticky directory
        // is then only an ancestor of the PATH entry.
        expect(resolveNodeExecutable({ ...TRUST, execPath: versioned, pathEnv: landing })).toBe(
          join(landing, "node"),
        );
        const link = join(tempDir("bob-sym-holder-"), "bin");
        symlinkSync(landing, link);
        expect(resolveNodeExecutable({ ...TRUST, execPath: versioned, pathEnv: link })).toBe(
          versioned,
        );
      });
    });

    it("a Homebrew-shaped relative link (bin/node -> ../Cellar/node/<v>/bin/node) in trusted directories is chosen", () => {
      const prefix = tempDir("bob-trust-prefix-");
      const versioned = nodeFile(subdirs(prefix, "Cellar", "node", "1.0.0", "bin"));
      const stable = join(subdirs(prefix, "bin"), "node");
      symlinkSync("../Cellar/node/1.0.0/bin/node", stable);
      expect(
        resolveNodeExecutable({ ...TRUST, execPath: versioned, pathEnv: join(prefix, "bin") }),
      ).toBe(stable);
    });

    it("a failed stat makes the candidate untrusted: as the only PATH entry, it is skipped and the fallback applies", () => {
      const versioned = nodeFile(tempDir("bob-trust-statv-"));
      const dir = tempDir("bob-trust-statfail-");
      const stable = nodeLink(dir, versioned);
      const failing = realpathSync(dir);
      let fired = 0;
      const statPath = (path: string) => {
        if (path === failing) {
          fired += 1;
          throw new Error("EACCES (injected)");
        }
        return statSync(path);
      };
      // premise: without the failure the link is chosen
      expect(resolveNodeExecutable({ ...TRUST, execPath: versioned, pathEnv: dir })).toBe(stable);
      expect(resolveNodeExecutable({ ...TRUST, execPath: versioned, pathEnv: dir, statPath })).toBe(
        versioned,
      );
      expect(fired).toBeGreaterThan(0); // the injected failure really fired
      expect(() =>
        resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: dir, statPath }),
      ).toThrow(NO_NODE);
    });

    it("a symlink cycle is untrusted (the walk is bounded)", () => {
      const dir = tempDir("bob-trust-loop-");
      symlinkSync(join(dir, "loop"), join(dir, "node"));
      symlinkSync(join(dir, "node"), join(dir, "loop"));
      expect(() =>
        resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: dir, isExecutable: () => true }),
      ).toThrow(NO_NODE);
    });
  });

  describe("relative PATH entries (finding 2)", () => {
    it("`bin` and `.` are never chosen, even when they hold a matching node; empty segments are skipped", () => {
      const versioned = nodeFile(tempDir("bob-rel-versioned-"));
      const cwd = tempDir("bob-rel-cwd-");
      nodeLink(cwd, versioned); // ./node -> the running interpreter
      const bin = subdirs(cwd, "bin");
      nodeLink(bin, versioned); // bin/node -> the running interpreter
      const abs = tempDir("bob-rel-abs-");
      const absNode = nodeFile(abs);
      // premise: the same directory named ABSOLUTELY is chosen
      expect(resolveNodeExecutable({ ...TRUST, execPath: versioned, pathEnv: bin })).toBe(
        join(bin, "node"),
      );
      const previous = process.cwd();
      process.chdir(cwd);
      try {
        const relativeOnly = `bin${delimiter}.`;
        expect(
          resolveNodeExecutable({ ...TRUST, execPath: versioned, pathEnv: relativeOnly }),
        ).toBe(versioned);
        expect(() =>
          resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: relativeOnly }),
        ).toThrow(NO_NODE);
        expect(
          resolveNodeExecutable({
            ...TRUST,
            execPath: BUN,
            pathEnv: `${relativeOnly}${delimiter}${abs}`,
          }),
        ).toBe(absNode);
        expect(
          resolveNodeExecutable({
            ...TRUST,
            execPath: BUN,
            pathEnv: `${delimiter}${delimiter}${abs}`,
          }),
        ).toBe(absNode);
      } finally {
        process.chdir(previous);
      }
    });
  });

  // The hosted CI runner's layout: the only node on PATH sits in a
  // world-writable directory (as /usr/local/bin is there). The trust rule
  // refuses it, and the refusal must say what it skipped and why.
  describe("a PATH whose only node sits under a world-writable directory (the hosted runner)", () => {
    it("is refused with the actionable message by the resolver, both renderers and installService", async () => {
      const binary = nodeFile(tempDir("bob-ci-binary-")); // the binary itself, trusted
      const open = tempDir("bob-ci-usr-local-bin-", 0o777); // like the runner's /usr/local/bin
      const link = nodeLink(open, binary); // a node symlink ...
      const openToo = tempDir("bob-ci-other-bin-", 0o777);
      const file = nodeFile(openToo); // ... and a node file, each in a world-writable directory
      const deps = { ...TRUST, execPath: BUN, pathEnv: `${open}${delimiter}${openToo}` };
      // premise: the same link in a 0700 directory IS chosen
      const closed = tempDir("bob-ci-trusted-");
      const trustedLink = nodeLink(closed, binary);
      expect(resolveNodeExecutable({ ...deps, pathEnv: closed })).toBe(trustedLink);

      let message = "";
      try {
        resolveNodeExecutable(deps);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain("bob install-service: no Node executable found");
      expect(message).toContain(">=22.19.0");
      expect(message).toContain("put it on PATH");
      expect(message).toContain(`Skipped as untrusted: ${link}, ${file}`);
      expect(message).toContain(REMEDY);

      const opts = { name: "pulse", bobBin: BOB_BIN, home: HOME, ...deps };
      expect(() => renderPlist(opts)).toThrow(message);
      expect(() => renderSystemdUnit(opts)).toThrow(message);
      const written: Array<{ path: string; contents: string }> = [];
      await expect(
        installService({
          ...opts,
          platform: "systemd",
          writeFile: (path, contents) => written.push({ path, contents }),
          runSystemctl: async () => ({ code: 0, stderr: "" }),
        }),
      ).rejects.toThrow(message);
      expect(written).toHaveLength(0);
    });
  });

  describe("the branch for an installer not named node (finding 3)", () => {
    it("a group-writable (0775) holder is refused with a remedy that names group write", () => {
      // Like an nvm, fnm or ~/.local bin created under umask 002.
      const dir = tempDir("bob-nn-group-bin-", 0o775);
      const node = nodeFile(dir);
      expect(statSync(dir).mode & 0o777).toBe(0o775); // premise: group-writable, not other-writable
      let message = "";
      try {
        resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: dir });
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toContain(`Skipped as untrusted: ${node}`);
      expect(message).toContain(REMEDY);
    });

    it("skips an untrusted first match for a trusted later one, and refuses when only untrusted or relative entries hold node", () => {
      const open = tempDir("bob-nn-0777-", 0o777);
      nodeFile(open);
      const trusted = tempDir("bob-nn-trusted-");
      const good = nodeFile(trusted);
      expect(
        resolveNodeExecutable({
          ...TRUST,
          execPath: BUN,
          pathEnv: `${open}${delimiter}${trusted}`,
        }),
      ).toBe(good);
      expect(() => resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: open })).toThrow(
        NO_NODE,
      );
      // The refusal names what it skipped and why, so the remedy is actionable.
      expect(() => resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: open })).toThrow(
        `Skipped as untrusted: ${join(open, "node")}`,
      );
      // With nothing skipped, the refusal does not claim anything was.
      let bare = "";
      try {
        resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: "" });
      } catch (e) {
        bare = (e as Error).message;
      }
      expect(bare).toMatch(NO_NODE);
      expect(bare).not.toContain("Skipped as untrusted");
      const rel = relative(process.cwd(), trusted);
      expect(() => resolveNodeExecutable({ ...TRUST, execPath: BUN, pathEnv: rel })).toThrow(
        NO_NODE,
      );
    });

    it("installService refuses and writes NOTHING when PATH holds only an untrusted node", async () => {
      const open = tempDir("bob-nn-install-", 0o777);
      nodeFile(open);
      const written: Array<{ path: string; contents: string }> = [];
      const attempt = installService({
        name: "pulse",
        bobBin: BOB_BIN,
        home: HOME,
        platform: "systemd",
        ...TRUST,
        execPath: BUN,
        pathEnv: open,
        writeFile: (path, contents) => written.push({ path, contents }),
        runSystemctl: async () => ({ code: 0, stderr: "" }),
      });
      await expect(attempt).rejects.toThrow(/22\.19\.0/);
      expect(written).toHaveLength(0);
    });
  });
});

describe("installService prefers a trusted PATH symlink over a direct match (bob#228)", () => {
  it("writes the symlink path in BOTH units even when a direct match comes FIRST on PATH", async () => {
    const versionedDir = mkdtempSync(join(tmpdir(), "bob-node-versioned-"));
    const stableDir = mkdtempSync(join(tmpdir(), "bob-node-stable-"));
    const versioned = join(versionedDir, "node");
    writeFileSync(versioned, "#!/bin/sh\n");
    chmodSync(versioned, 0o755);
    const stable = join(stableDir, "node");
    symlinkSync(versioned, stable);
    const delimiter = process.platform === "win32" ? ";" : ":";
    // The versioned Cellar directory comes BEFORE the symlink on PATH.
    const pathEnv = `${versionedDir}${delimiter}${stableDir}`;
    try {
      const launchdWritten: Array<{ path: string; contents: string }> = [];
      const launchd = await installService({
        name: "pulse",
        bobBin: BOB_BIN,
        home: HOME,
        platform: "launchd",
        ...TRUST,
        execPath: versioned,
        pathEnv,
        writeFile: (path, contents) => launchdWritten.push({ path, contents }),
      });
      expect(launchd.interpreter).toBe(stable);
      expect(launchdWritten[0].contents).toContain(stable);
      expect(launchdWritten[0].contents).not.toContain(versioned);

      const systemdWritten: Array<{ path: string; contents: string }> = [];
      const systemd = await installService({
        name: "pulse",
        bobBin: BOB_BIN,
        home: HOME,
        platform: "systemd",
        ...TRUST,
        execPath: versioned,
        pathEnv,
        writeFile: (path, contents) => systemdWritten.push({ path, contents }),
        runSystemctl: async () => ({ code: 0, stderr: "" }),
      });
      expect(systemd.interpreter).toBe(stable);
      expect(systemdWritten[0].contents).toContain(
        `ExecStart="${stable}" "${BOB_BIN}" "run" "pulse"`,
      );
      expect(systemdWritten[0].contents).not.toContain(versioned);
    } finally {
      rmSync(versionedDir, { recursive: true, force: true });
      rmSync(stableDir, { recursive: true, force: true });
    }
  });
});

describe("installService resolves the interpreter at install time (bob#218)", () => {
  it("a bun-launched install writes the Node path, not bun", async () => {
    const { dir, node } = stubNodeDir("bob-install-bun-");
    const written: Array<{ path: string; contents: string }> = [];
    const res = await installService({
      name: "pulse",
      bobBin: BOB_BIN,
      home: HOME,
      platform: "systemd",
      ...TRUST,
      execPath: process.execPath,
      pathEnv: dir,
      writeFile: (path, contents) => written.push({ path, contents }),
      runSystemctl: async () => ({ code: 0, stderr: "" }),
    });
    // process.execPath is the test runner (bun); the unit must still be node.
    expect(res.interpreter).toBe(node);
    expect(basename(res.interpreter)).not.toBe(basename(process.execPath));
    expect(written[0].contents).toContain(
      `ExecStart="${res.interpreter}" "${BOB_BIN}" "run" "pulse"`,
    );
  });

  it("a non-node installer resolves node from its PATH", async () => {
    const binDir = mkdtempSync(join(tmpdir(), "bob-install-bin-"));
    const nodePath = join(binDir, "node");
    writeFileSync(nodePath, "#!/bin/sh\n");
    chmodSync(nodePath, 0o755);
    const written: Array<{ path: string; contents: string }> = [];
    try {
      const res = await installService({
        name: "pulse",
        bobBin: BOB_BIN,
        home: HOME,
        platform: "systemd",
        ...TRUST,
        execPath: "/opt/bun/bin/bun",
        pathEnv: binDir,
        writeFile: (path, contents) => written.push({ path, contents }),
        runSystemctl: async () => ({ code: 0, stderr: "" }),
      });
      expect(res.interpreter).toBe(nodePath);
      expect(written).toHaveLength(1);
      expect(written[0].contents).toContain(`ExecStart="${nodePath}" "${BOB_BIN}" "run" "pulse"`);
      expect(written[0].contents).not.toContain("/opt/bun/bin/bun");
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("refuses when no node is available, and writes NOTHING", async () => {
    const empty = mkdtempSync(join(tmpdir(), "bob-install-nonode-"));
    const written: Array<{ path: string; contents: string }> = [];
    try {
      const attempt = installService({
        name: "pulse",
        bobBin: BOB_BIN,
        home: HOME,
        platform: "systemd",
        ...TRUST,
        execPath: "/opt/bun/bin/bun",
        pathEnv: empty,
        writeFile: (path, contents) => written.push({ path, contents }),
        runSystemctl: async () => ({ code: 0, stderr: "" }),
      });
      await expect(attempt).rejects.toThrow(/22\.19\.0/);
      expect(written).toHaveLength(0);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// The acceptance from bob#218: run the unit's OWN command line with a PATH that
// does not contain the interpreter, and get a working `bob --help` out of it.
describe("the rendered unit runs under a minimal PATH with no interpreter on it (bob#218)", () => {
  const minimalPath = mkdtempSync(join(tmpdir(), "bob-218-nopath-"));
  afterAll(() => rmSync(minimalPath, { recursive: true, force: true }));

  // The unit's tokens up to and including the bob script: an absolute
  // interpreter (when present) followed by bobBin. The unit appends the
  // subcommand; the test runs `--help` so no agent is needed.
  function interpreterAndBob(tokens: string[]): string[] {
    const i = tokens.indexOf(BOB_BIN);
    if (i < 0) throw new Error(`the bob script is not in the unit: ${tokens.join(" ")}`);
    return tokens.slice(0, i + 1);
  }

  function programArguments(plist: string): string[] {
    const array = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
    if (!array) throw new Error("no ProgramArguments array in the plist");
    return [...array[1].matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1]);
  }

  function helpUnderMinimalPath(command: string[]): { code: number | null; out: string } {
    const r = spawnSync(command[0], [...command.slice(1), "--help"], {
      env: { HOME, PATH: minimalPath },
      encoding: "utf8",
      timeout: 20_000,
    });
    return { code: r.status, out: r.stdout ?? "" };
  }

  it("the minimal PATH really has no node on it (so the test can see the defect)", () => {
    const r = spawnSync("node", ["--version"], {
      env: { HOME, PATH: minimalPath },
      encoding: "utf8",
    });
    expect(r.error).toBeDefined(); // ENOENT — node is not resolvable on this PATH
  });

  // The installer is the real-node fixture (named node) with an EMPTY PATH, so
  // the resolution returns that interpreter: the resolution reads neither the
  // host's PATH nor its trust (only the fixture lookup above reads the PATH).
  itWithRealNode(
    "launchd: the rendered command runs under the resolved Node and gets bob --help to exit 0",
    () => {
      const plist = renderPlist({
        name: "pulse",
        bobBin: BOB_BIN,
        home: HOME,
        ...TRUST,
        execPath: realNode(),
        pathEnv: "",
      });
      const head = interpreterAndBob(programArguments(plist));
      expect(head[0]).toBe(realNode());
      expect(basename(head[0])).toBe("node"); // NODE, not the test runner (bun)
      const res = helpUnderMinimalPath(head);
      expect(res.code).toBe(0);
      expect(res.out).toContain("Usage: bob");
    },
    30_000,
  );

  itWithRealNode(
    "systemd: the rendered command runs under the resolved Node and gets bob --help to exit 0",
    () => {
      const unit = renderSystemdUnit({
        name: "pulse",
        bobBin: BOB_BIN,
        home: HOME,
        ...TRUST,
        execPath: realNode(),
        pathEnv: "",
      });
      const head = interpreterAndBob(execStart(unit));
      expect(head[0]).toBe(realNode());
      expect(basename(head[0])).toBe("node"); // NODE, not the test runner (bun)
      const res = helpUnderMinimalPath(head);
      expect(res.code).toBe(0);
      expect(res.out).toContain("Usage: bob");
    },
    30_000,
  );
});

// The unit writes its command as `ExecStart=` (systemd) or an array of
// <string> entries (launchd); read whichever the host platform produced.
function unitCommand(unitText: string): string {
  if (process.platform === "darwin") {
    const array = unitText.match(/<array>([\s\S]*?)<\/array>/)?.[1] ?? "";
    return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1]).join(" ");
  }
  const line = unitText.split("\n").find((l) => l.startsWith("ExecStart="));
  const raw = (line ?? "").slice("ExecStart=".length);
  // Strip systemd double-quote wrapping and return space-joined args.
  const tokens: string[] = [];
  let idx = 0;
  while (idx < raw.length) {
    if (raw[idx] === " ") {
      idx++;
      continue;
    }
    if (raw[idx] === '"') {
      idx++;
      let t = "";
      while (idx < raw.length && raw[idx] !== '"') {
        if (raw[idx] === "\\" && idx + 1 < raw.length) {
          t += raw[idx + 1];
          idx += 2;
        } else {
          t += raw[idx];
          idx++;
        }
      }
      idx++;
      tokens.push(t);
    } else {
      let t = "";
      while (idx < raw.length && raw[idx] !== " ") {
        t += raw[idx];
        idx++;
      }
      tokens.push(t);
    }
  }
  return tokens.join(" ");
}
describe("the printed install-service command is the unit's command (bob#218)", () => {
  it("renderers and installService build it from ONE argument list", async () => {
    const argv = serviceCommandArgs({
      interpreter: INTERPRETER,
      bobBin: "/usr/local/bin/bob",
      name: "pulse",
      model: "claude-fast",
    });
    expect(argv).toEqual([
      INTERPRETER,
      "/usr/local/bin/bob",
      "run",
      "pulse",
      "--model",
      "claude-fast",
    ]);
    const unit = renderSystemdUnit({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      interpreter: INTERPRETER,
      model: "claude-fast",
      home: HOME,
    });
    const q = (a: string) => `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    expect(unit).toContain(
      `ExecStart=${q(argv[0])} ${q(argv[1])} ${q(argv[2])} ${q(argv[3])} ${q(argv[4])} ${q(argv[5])}`,
    );

    const written: Array<{ path: string; contents: string }> = [];
    const res = await installService({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      interpreter: INTERPRETER,
      model: "claude-fast",
      home: HOME,
      platform: "systemd",
      writeFile: (path, contents) => written.push({ path, contents }),
      runSystemctl: async () => ({ code: 0, stderr: "" }),
    });
    expect(res.argv).toEqual(argv);
    expect(written[0].contents).toContain(
      `ExecStart=${q(argv[0])} ${q(argv[1])} ${q(argv[2])} ${q(argv[3])} ${q(argv[4])} ${q(argv[5])}`,
    );
  });

  it("the CLI prints exactly the command the unit runs, including --model", () => {
    const home = mkdtempSync(join(tmpdir(), "bob-print-home-"));
    const binDir = mkdtempSync(join(tmpdir(), "bob-print-bin-"));
    // A stub systemctl so the install's daemon-reload succeeds without a bus.
    writeFileSync(join(binDir, "systemctl"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "systemctl"), 0o755);
    // A stub node: the CLI runs under bun (not named node) and its PATH is
    // ONLY binDir (0700, owned by this uid), so it resolves this trusted stub and
    // never the host's node.
    const stubNode = join(binDir, "node");
    writeFileSync(stubNode, "#!/bin/sh\n");
    chmodSync(stubNode, 0o755);
    try {
      const out = spawnNode(
        [CLI, "install-service", "pulse", "--bob-bin", BOB_BIN, "--model", "claude-fast"],
        { env: { ...process.env, HOME: home, PATH: binDir } },
      );
      const printed = out
        .split("\n")
        .find((l) => l.includes("runs:"))
        ?.split("runs:")[1]
        ?.trim();
      expect(printed).toContain("--model claude-fast");
      expect(printed?.split(" ")[0]).toBe(stubNode);
      // The unit the CLI just wrote carries the same command verbatim.
      const unitText = readFileSync(servicePath("pulse", { home }), "utf8");
      expect(printed).toBe(unitCommand(unitText));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 30_000);
});
