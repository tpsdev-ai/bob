import { describe, expect, it } from "bun:test";
import {
  down,
  installService,
  type LaunchctlRunner,
  plistPath,
  renderPlist,
  restart,
  serviceLabel,
  up,
} from "../src/service.js";

const HOME = "/Users/test";

// Capture launchctl invocations without running real launchctl.
function captureLaunchctl(): { runner: LaunchctlRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: LaunchctlRunner = async (args) => {
    calls.push(args);
    return { code: 0, stderr: "" };
  };
  return { runner, calls };
}

describe("renderPlist", () => {
  it("references the PERSISTENT entrypoint (bob serve <name>)", () => {
    const xml = renderPlist({ name: "pulse", bobBin: "/usr/local/bin/bob", home: HOME });
    expect(xml).toContain("<string>/usr/local/bin/bob</string>");
    expect(xml).toContain("<string>serve</string>");
    expect(xml).toContain("<string>pulse</string>");
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

describe("installService", () => {
  it("writes the plist to the LaunchAgents path via the injected writer", () => {
    const written: Array<{ path: string; contents: string }> = [];
    const res = installService({
      name: "pulse",
      bobBin: "/usr/local/bin/bob",
      home: HOME,
      writeFile: (path, contents) => written.push({ path, contents }),
    });
    expect(res.plistPath).toBe(`${HOME}/Library/LaunchAgents/ai.tpsdev.bob.pulse.plist`);
    expect(written).toHaveLength(1);
    expect(written[0].path).toBe(res.plistPath);
    expect(written[0].contents).toContain("ai.tpsdev.bob.pulse");
    expect(written[0].contents.toLowerCase()).not.toContain("token");
  });
});

describe("lifecycle — up / down / restart invoke the right launchctl ops", () => {
  it("up → bootstrap gui/<uid> <plist>", async () => {
    const { runner, calls } = captureLaunchctl();
    await up({ name: "pulse", home: HOME, runLaunchctl: runner, getUid: () => 501 });
    expect(calls).toEqual([
      ["bootstrap", "gui/501", `${HOME}/Library/LaunchAgents/ai.tpsdev.bob.pulse.plist`],
    ]);
  });

  it("down → bootout gui/<uid> <plist>", async () => {
    const { runner, calls } = captureLaunchctl();
    await down({ name: "pulse", home: HOME, runLaunchctl: runner, getUid: () => 501 });
    expect(calls).toEqual([
      ["bootout", "gui/501", `${HOME}/Library/LaunchAgents/ai.tpsdev.bob.pulse.plist`],
    ]);
  });

  it("restart → kickstart -k gui/<uid>/<label> (graceful: SIGTERM then relaunch)", async () => {
    const { runner, calls } = captureLaunchctl();
    await restart({ name: "pulse", runLaunchctl: runner, getUid: () => 501 });
    expect(calls).toEqual([["kickstart", "-k", "gui/501/ai.tpsdev.bob.pulse"]]);
  });

  it("surfaces a launchctl failure with the args (no secrets in these commands)", async () => {
    const runner: LaunchctlRunner = async () => ({
      code: 5,
      stderr: "Bootstrap failed: 5: Input/output error",
    });
    await expect(up({ name: "pulse", runLaunchctl: runner, getUid: () => 501 })).rejects.toThrow(
      /launchctl bootstrap .* failed \(exit 5\)/,
    );
  });
});
