import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectPlatform,
  down,
  installService,
  type LaunchctlRunner,
  plistPath,
  renderPlist,
  renderSystemdUnit,
  restart,
  serviceLabel,
  servicePath,
  systemdUnitName,
  systemdUnitPath,
  up,
} from "../../src/shell/service.js";

const HOME = "/Users/test";
// A fixed interpreter for render assertions (the real default is process.execPath).
const INTERPRETER = "/opt/node/bin/node";
// The repo's bin/bob — the acceptance test runs the unit's OWN command line.
const BOB_BIN = fileURLToPath(new URL("../../bin/bob", import.meta.url));

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
  it("launchd: the default interpreter is the installing process's own (absolute) interpreter", () => {
    const xml = renderPlist({ name: "pulse", bobBin: "/usr/local/bin/bob", home: HOME });
    expect(xml).toContain(
      `    <string>${process.execPath}</string>\n    <string>/usr/local/bin/bob</string>`,
    );
  });

  it("systemd: the default interpreter is the installing process's own (absolute) interpreter", () => {
    const unit = renderSystemdUnit({ name: "pulse", bobBin: "/usr/local/bin/bob", home: HOME });
    expect(unit).toContain(`ExecStart=${process.execPath} /usr/local/bin/bob run pulse`);
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

  it("launchd: the rendered command gets bob --help to exit 0", () => {
    const plist = renderPlist({ name: "pulse", bobBin: BOB_BIN, home: HOME });
    const res = helpUnderMinimalPath(interpreterAndBob(programArguments(plist)));
    expect(res.code).toBe(0);
    expect(res.out).toContain("Usage: bob");
  });

  it("systemd: the rendered command gets bob --help to exit 0", () => {
    const unit = renderSystemdUnit({ name: "pulse", bobBin: BOB_BIN, home: HOME });
    const res = helpUnderMinimalPath(interpreterAndBob(execStart(unit)));
    expect(res.code).toBe(0);
    expect(res.out).toContain("Usage: bob");
  });
});
