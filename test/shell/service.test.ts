import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
    const xml = renderPlist({ name: "pulse", bobBin: "/usr/local/bin/bob", home: HOME });
    expect(xml).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(xml).toContain("<key>RunAtLoad</key>\n  <true/>");
  });

  it("uses a stable, unique Label per agent", () => {
    const xml = renderPlist({ name: "pulse", bobBin: "/usr/local/bin/bob", home: HOME });
    expect(serviceLabel("pulse")).toBe("ai.tpsdev.bob.pulse");
    expect(xml).toContain("<string>ai.tpsdev.bob.pulse</string>");
  });

  it("threads a model override into ProgramArguments", () => {
    const xml = renderPlist({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      model: "claude-fast",
      home: HOME,
    });
    expect(xml).toContain("<string>--model</string>");
    expect(xml).toContain("<string>claude-fast</string>");
  });

  it("NEVER embeds a token or any secret (security)", () => {
    const xml = renderPlist({ name: "pulse", bobBin: "/usr/local/bin/bob", home: HOME });
    // No env-var block at all, and nothing token-shaped.
    expect(xml).not.toContain("EnvironmentVariables");
    expect(xml).not.toContain("TOKEN");
    expect(xml.toLowerCase()).not.toContain("token");
    expect(xml.toLowerCase()).not.toContain("secret");
  });

  it("points logs + WorkingDirectory at the agent's home", () => {
    const xml = renderPlist({ name: "pulse", bobBin: "/usr/local/bin/bob", home: HOME });
    expect(xml).toContain(`<string>${HOME}/agents/pulse/work</string>`);
    expect(xml).toContain(`<string>${HOME}/agents/pulse/service.out.log</string>`);
    expect(xml).toContain(`<string>${HOME}/agents/pulse/service.err.log</string>`);
  });

  it("XML-escapes injected values (defense in depth)", () => {
    const xml = renderPlist({
      name: "pulse",
      bobBin: "/opt/bob & co/bob",
      model: 'a"<b>',
      home: HOME,
    });
    expect(xml).toContain("/opt/bob &amp; co/bob");
    expect(xml).toContain("a&quot;&lt;b&gt;");
    expect(xml).not.toContain('a"<b>');
  });

  it("rejects an invalid agent name (path/XML injection defense)", () => {
    expect(() => renderPlist({ name: "../evil", bobBin: "/bin/bob" })).toThrow(
      /invalid agent name/,
    );
    expect(() => renderPlist({ name: "a b", bobBin: "/bin/bob" })).toThrow(/invalid agent name/);
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

describe("systemd backend", () => {
  it("renderSystemdUnit runs the persistent entrypoint + Restart=always, no secret", () => {
    const unit = renderSystemdUnit({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      interpreter: INTERPRETER,
      home: HOME,
    });
    expect(unit).toContain(`ExecStart=${INTERPRETER} /usr/local/bin/bob run pulse`);
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
      `ExecStart=${INTERPRETER} /usr/local/bin/bob run pulse --model claude-fast`,
    );
    expect(() => renderSystemdUnit({ name: "../evil", bobBin: "/bin/bob" })).toThrow(
      /invalid agent name/,
    );
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
    expect(written[0].contents).toContain(`ExecStart=${INTERPRETER} /usr/local/bin/bob run pulse`);
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
});

describe("the unit does not depend on the service manager's PATH (bob#218)", () => {
  it("launchd: the default interpreter is an absolute Node path", () => {
    const xml = renderPlist({ name: "pulse", bobBin: "/usr/local/bin/bob", home: HOME });
    const interpreter = resolveNodeExecutable();
    expect(basename(interpreter)).toBe("node");
    expect(xml).toContain(
      `    <string>${interpreter}</string>\n    <string>/usr/local/bin/bob</string>`,
    );
  });

  it("systemd: the default interpreter is an absolute Node path", () => {
    const unit = renderSystemdUnit({ name: "pulse", bobBin: "/usr/local/bin/bob", home: HOME });
    const interpreter = resolveNodeExecutable();
    expect(basename(interpreter)).toBe("node");
    expect(unit).toContain(`ExecStart=${interpreter} /usr/local/bin/bob run pulse`);
  });
});

describe("resolveNodeExecutable — the unit runs bob under node (bob#218)", () => {
  it("returns the installer's own interpreter when it IS node", () => {
    expect(resolveNodeExecutable({ execPath: "/usr/local/bin/node", pathEnv: "" })).toBe(
      "/usr/local/bin/node",
    );
  });

  it("finds node on the installer's PATH when the installer is not node", () => {
    const dir = mkdtempSync(join(tmpdir(), "bob-node-path-"));
    writeFileSync(join(dir, "node"), "#!/bin/sh\n");
    chmodSync(join(dir, "node"), 0o755);
    try {
      expect(resolveNodeExecutable({ execPath: "/opt/bun/bin/bun", pathEnv: dir })).toBe(
        join(dir, "node"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("makes a RELATIVE PATH entry absolute", () => {
    const dir = mkdtempSync(join(tmpdir(), "bob-node-rel-"));
    writeFileSync(join(dir, "node"), "#!/bin/sh\n");
    chmodSync(join(dir, "node"), 0o755);
    try {
      const rel = relative(process.cwd(), dir); // a RELATIVE PATH entry
      expect(rel.startsWith("/")).toBe(false); // premise: it IS relative
      const resolved = resolveNodeExecutable({ execPath: "/opt/bun/bin/bun", pathEnv: rel });
      expect(resolved).toBe(join(dir, "node"));
      expect(resolved.startsWith("/")).toBe(true);
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
      expect(() => resolveNodeExecutable({ execPath: "/opt/bun/bin/bun", pathEnv: empty })).toThrow(
        /22\.19\.0/,
      );
      expect(() => resolveNodeExecutable({ execPath: "/opt/bun/bin/bun", pathEnv: empty })).toThrow(
        /on PATH/,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("resolveNodeExecutable — a stable path over a versioned target (bob#228)", () => {
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
      const resolved = resolveNodeExecutable({ execPath: versioned.file, pathEnv: stableDir });
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
      const resolved = resolveNodeExecutable({ execPath: versioned.file, pathEnv: emptyDir });
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
      const resolved = resolveNodeExecutable({ execPath: versioned.file, pathEnv: stableDir });
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

describe("installService prefers a stable PATH symlink over a direct match (bob#228)", () => {
  it("writes the symlink path in BOTH units even when a direct match comes FIRST on PATH", async () => {
    const versionedDir = mkdtempSync(join(tmpdir(), "bob-node-versioned-"));
    const stableDir = mkdtempSync(join(tmpdir(), "bob-node-stable-"));
    const versioned = join(versionedDir, "node");
    writeFileSync(versioned, "#!/bin/sh\n");
    chmodSync(versioned, 0o755);
    const stable = join(stableDir, "node");
    symlinkSync(versioned, stable);
    const delimiter = process.platform === "win32" ? ";" : ":";
    // The versioned Cellar directory comes BEFORE the stable symlink on PATH.
    const pathEnv = `${versionedDir}${delimiter}${stableDir}`;
    try {
      const launchdWritten: Array<{ path: string; contents: string }> = [];
      const launchd = await installService({
        name: "pulse",
        bobBin: BOB_BIN,
        home: HOME,
        platform: "launchd",
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
        execPath: versioned,
        pathEnv,
        writeFile: (path, contents) => systemdWritten.push({ path, contents }),
        runSystemctl: async () => ({ code: 0, stderr: "" }),
      });
      expect(systemd.interpreter).toBe(stable);
      expect(systemdWritten[0].contents).toContain(`ExecStart=${stable} ${BOB_BIN} run pulse`);
      expect(systemdWritten[0].contents).not.toContain(versioned);
    } finally {
      rmSync(versionedDir, { recursive: true, force: true });
      rmSync(stableDir, { recursive: true, force: true });
    }
  });
});

describe("installService resolves the interpreter at install time (bob#218)", () => {
  it("a bun-launched install writes the Node path, not bun", async () => {
    const written: Array<{ path: string; contents: string }> = [];
    const res = await installService({
      name: "pulse",
      bobBin: BOB_BIN,
      home: HOME,
      platform: "systemd",
      writeFile: (path, contents) => written.push({ path, contents }),
      runSystemctl: async () => ({ code: 0, stderr: "" }),
    });
    // process.execPath is the test runner (bun); the unit must still be node.
    expect(basename(res.interpreter)).toBe("node");
    expect(basename(res.interpreter)).not.toBe(basename(process.execPath));
    expect(written[0].contents).toContain(`ExecStart=${res.interpreter} ${BOB_BIN} run pulse`);
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
        execPath: "/opt/bun/bin/bun",
        pathEnv: binDir,
        writeFile: (path, contents) => written.push({ path, contents }),
        runSystemctl: async () => ({ code: 0, stderr: "" }),
      });
      expect(res.interpreter).toBe(nodePath);
      expect(written).toHaveLength(1);
      expect(written[0].contents).toContain(`ExecStart=${nodePath} ${BOB_BIN} run pulse`);
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

  function execStart(unit: string): string[] {
    const line = unit.split("\n").find((l) => l.startsWith("ExecStart="));
    if (!line) throw new Error("no ExecStart in the systemd unit");
    return line
      .slice("ExecStart=".length)
      .split(" ")
      .filter((t) => t.length > 0);
  }

  function helpUnderMinimalPath(command: string[]): { code: number | null; out: string } {
    const r = spawnSync(command[0], [...command.slice(1), "--help"], {
      env: { HOME, PATH: minimalPath },
      encoding: "utf8",
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

  it("launchd: the rendered command runs under the resolved Node and gets bob --help to exit 0", () => {
    const plist = renderPlist({ name: "pulse", bobBin: BOB_BIN, home: HOME });
    const head = interpreterAndBob(programArguments(plist));
    expect(basename(head[0])).toBe("node"); // NODE, not the test runner (bun)
    const res = helpUnderMinimalPath(head);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Usage: bob");
  });

  it("systemd: the rendered command runs under the resolved Node and gets bob --help to exit 0", () => {
    const unit = renderSystemdUnit({ name: "pulse", bobBin: BOB_BIN, home: HOME });
    const head = interpreterAndBob(execStart(unit));
    expect(basename(head[0])).toBe("node"); // NODE, not the test runner (bun)
    const res = helpUnderMinimalPath(head);
    expect(res.code).toBe(0);
    expect(res.out).toContain("Usage: bob");
  });
});

// The unit writes its command as `ExecStart=` (systemd) or an array of
// <string> entries (launchd); read whichever the host platform produced.
function unitCommand(unitText: string): string {
  if (process.platform === "darwin") {
    const array = unitText.match(/<array>([\s\S]*?)<\/array>/)?.[1] ?? "";
    return [...array.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1]).join(" ");
  }
  const line = unitText.split("\n").find((l) => l.startsWith("ExecStart="));
  return (line ?? "").slice("ExecStart=".length);
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
    expect(unit).toContain(`ExecStart=${argv.join(" ")}`);

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
    expect(written[0].contents).toContain(`ExecStart=${argv.join(" ")}`);
  });

  it("the CLI prints exactly the command the unit runs, including --model", () => {
    const home = mkdtempSync(join(tmpdir(), "bob-print-home-"));
    const binDir = mkdtempSync(join(tmpdir(), "bob-print-bin-"));
    // A stub systemctl so the install's daemon-reload succeeds without a bus.
    writeFileSync(join(binDir, "systemctl"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(binDir, "systemctl"), 0o755);
    try {
      const out = spawnNode(
        [CLI, "install-service", "pulse", "--bob-bin", BOB_BIN, "--model", "claude-fast"],
        { env: { ...process.env, HOME: home, PATH: `${binDir}:${process.env.PATH ?? ""}` } },
      );
      const printed = out
        .split("\n")
        .find((l) => l.includes("runs:"))
        ?.split("runs:")[1]
        ?.trim();
      expect(printed).toContain("--model claude-fast");
      // The unit the CLI just wrote carries the same command verbatim.
      const unitText = readFileSync(servicePath("pulse", { home }), "utf8");
      expect(printed).toBe(unitCommand(unitText));
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(binDir, { recursive: true, force: true });
    }
  }, 30_000);
});
