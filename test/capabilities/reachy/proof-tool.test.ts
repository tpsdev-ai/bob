// bob#356 round 1: the separate-user proofs run ONE installed command,
// sidecar/reachy-voice/proof.py, through an exact sudoers rule. Its subcommands
// are bounded; these tests run them as THIS user (no sudo) so the bounds hold
// on every host, and check that the key-read proof's credential list is DERIVED
// from bob's own resolution of the agent, never supplied.
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initAgent } from "../../../src/shell/init.js";
import { deriveActiveCredentials } from "./isolation-credentials.js";

const PROOF = join(import.meta.dirname, "..", "..", "..", "sidecar", "reachy-voice", "proof.py");
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});
const proof = (...args: string[]) =>
  spawnSync("python3", ["-I", PROOF, ...args], { encoding: "utf8" });

describe("bob#356 — proof.py, the one command the sudoers rule names", () => {
  it("`open` reports openability per path and never reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "rvp-"));
    scratch.push(dir);
    const readable = join(dir, "readable");
    const closed = join(dir, "closed");
    writeFileSync(readable, "CONTENT-MUST-NOT-APPEAR");
    writeFileSync(closed, "x");
    chmodSync(closed, 0o000);
    const r = proof("open", readable, closed, join(dir, "absent"));
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out[readable]).toBe("OPENED");
    expect(out[join(dir, "absent")]).toBe("ENOENT");
    if (process.getuid?.() !== 0) expect(out[closed]).toBe("EACCES");
    expect(r.stdout).not.toContain("CONTENT-MUST-NOT-APPEAR");
  });

  it("`connect` reports CONNECTED, or the errno of a refused socket", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rvp-"));
    scratch.push(dir);
    const sock = join(dir, "s.sock");
    const server = createServer((s) => s.destroy());
    await new Promise<void>((r) => server.listen(sock, () => r()));
    try {
      // spawnSync blocks the loop; the kernel completes the connect from the backlog
      expect(JSON.parse(proof("connect", sock).stdout)).toEqual({ connect: "CONNECTED" });
      chmodSync(sock, 0o000);
      if (process.getuid?.() !== 0) {
        expect(JSON.parse(proof("connect", sock).stdout).connect).toMatch(/^(EACCES|EPERM)$/);
      }
      expect(JSON.parse(proof("connect", join(dir, "none")).stdout)).toEqual({
        connect: "ENOENT",
      });
    } finally {
      server.close();
    }
  });

  it("`probe`, `sidecar` and `clean` refuse any path outside a proof's /private/tmp/rv- scratch", () => {
    const spec = JSON.stringify({ exec: "/usr/bin/true" });
    for (const args of [
      ["probe", "confined", "/tmp/x", "/tmp/y", "/tmp/z.sock", spec],
      ["probe", "open", "/usr/local/var/bob/reachy-voice", "/x", "/y", spec],
      ["sidecar", "/tmp/x", "/tmp/y", "/tmp/z.sock", "0".repeat(64), "0660"],
      ["clean", "/usr/local/var/bob/reachy-voice/work"],
    ]) {
      const r = proof(...args);
      expect(r.status, args.join(" ")).not.toBe(0);
      expect(r.stderr).toContain("is not under /private/tmp/rv-");
    }
  });

  // The scratch prefix is macOS's /private/tmp (the seatbelt proofs are macOS-only).
  it.skipIf(process.platform !== "darwin")(
    "`sidecar` accepts only the deployed or the private socket mode",
    () => {
      const dir = mkdtempSync("/private/tmp/rv-");
      scratch.push(dir);
      const r = proof("sidecar", dir, join(dir, "w"), join(dir, "s.sock"), "0".repeat(64), "0666");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("socket mode is 0600 or 0660");
    },
  );

  it("an unknown subcommand or argument count is refused", () => {
    expect(proof("cat", "/etc/hosts").status).not.toBe(0);
    expect(proof("open").status).not.toBe(0);
    expect(proof("connect", "a", "b").status).not.toBe(0);
  });
});

describe("bob#356 — the key-read proof's credentials are DERIVED, not supplied", () => {
  it("derives the agent's key file and provider stores from its bob.yaml, plus bob's admin-pass path", () => {
    const root = mkdtempSync(join(tmpdir(), "rvp-agent-"));
    scratch.push(root);
    const keys = join(root, ".flair", "keys");
    const { agentDir } = initAgent({
      name: "voicebot",
      role: "custom",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      contextWindow: 200_000,
      agentsRoot: join(root, "agents"),
      flairKeysDir: keys,
      skipFlair: true,
    });
    const yaml = readFileSync(join(agentDir, "bob.yaml"), "utf8");
    // the agent's Flair key, named by its own bob.yaml
    const keyPath = join(root, "voicebot.key");
    writeFileSync(keyPath, "fixture-not-a-real-key");
    chmodSync(keyPath, 0o600);
    writeFileSync(
      join(agentDir, "bob.yaml"),
      `${yaml.replace(/^capabilities:.*$/m, "capabilities:\n  - flair")}\nflair:\n  url: http://127.0.0.1:9\n  agentId: voicebot\n  keyFile: ${keyPath}\n`,
    );
    const adminPass = join(root, "admin-pass");
    const creds = deriveActiveCredentials({
      name: "voicebot",
      agentsRoot: join(root, "agents"),
      adminPass,
    });
    expect(creds.derived).toContain(keyPath);
    expect(creds.derived).toContain(join(agentDir, ".pi-agent", "auth.json"));
    expect(creds.derived).toContain(adminPass);
    expect(creds.agentKeys).toEqual([keyPath]);
    expect(creds.present).toContain(keyPath);
    expect(creds.present).not.toContain(adminPass); // absent on disk: reported, not invented
  });
});
