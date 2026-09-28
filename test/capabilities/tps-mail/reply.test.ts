// bob#200 §5 / Sherlock F7-F8 / Kern 3, 8: the reply transport, driven through
// a FAKE `tps` script (never the real CLI, never real mail): fixed argv, the
// body on stdin, TPS_AGENT_ID from the agent's identity, the exit code
// authoritative, and the reply capped.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capReply,
  replyArgv,
  tpsCliReplySender,
} from "../../../src/capabilities/tps-mail/reply.js";

let dir: string;
let keysDir: string;

// A fake tps: records argv (one per line), the environment it cares about, and
// stdin; exits with $FAKE_TPS_EXIT.
function fakeTps(exitCode = 0): string {
  const bin = join(dir, "tps");
  writeFileSync(
    bin,
    [
      "#!/bin/sh",
      `for a in "$@"; do printf "%s\\n" "$a"; done > ${join(dir, "argv")}`,
      `printf "%s" "$TPS_AGENT_ID" > ${join(dir, "agent")}`,
      `printf "%s" "\${TPS_INBOUND_CHAIN_JSON-unset}" > ${join(dir, "chain")}`,
      `cat > ${join(dir, "stdin")}`,
      `echo "boom on stderr" >&2`,
      `exit ${exitCode}`,
      "",
    ].join("\n"),
  );
  chmodSync(bin, 0o755);
  return bin;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bob-reply-"));
  keysDir = join(dir, "keys");
  mkdirSync(keysDir);
  writeFileSync(join(keysDir, "testbot.key"), "test key placeholder");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const REQ = { to: "flint", inReplyTo: "msg-1", body: "--help\nSMOKE-OK; rm -rf /" };

describe("tpsCliReplySender", () => {
  it("runs a FIXED argv with the body on stdin — never in argv", async () => {
    const send = tpsCliReplySender({ identity: "testbot", tpsBin: fakeTps(), keysDir });
    expect(await send(REQ)).toEqual({ ok: true });
    const argv = readFileSync(join(dir, "argv"), "utf8").trimEnd().split("\n");
    expect(argv).toEqual(replyArgv("flint", "msg-1"));
    expect(argv).toEqual(["mail", "send", "flint", "--stdin", "--reply-to", "msg-1"]);
    expect(argv.join(" ")).not.toContain("SMOKE-OK");
    expect(readFileSync(join(dir, "stdin"), "utf8")).toBe(REQ.body);
  });

  it("signs as the agent: TPS_AGENT_ID is the identity, and an ambient chain is dropped", async () => {
    const send = tpsCliReplySender({
      identity: "testbot",
      tpsBin: fakeTps(),
      keysDir,
      env: { ...process.env, TPS_AGENT_ID: "flint", TPS_INBOUND_CHAIN_JSON: "[]" },
    });
    expect((await send(REQ)).ok).toBe(true);
    expect(readFileSync(join(dir, "agent"), "utf8")).toBe("testbot");
    expect(readFileSync(join(dir, "chain"), "utf8")).toBe("unset");
  });

  it("a non-zero exit is a counted failure carrying the CLI's stderr", async () => {
    const send = tpsCliReplySender({ identity: "testbot", tpsBin: fakeTps(1), keysDir });
    const r = await send(REQ);
    expect(r).toMatchObject({ ok: false, reason: "exit" });
    if (!r.ok) expect(r.detail).toContain("boom on stderr");
  });

  it("a missing CLI is a counted failure, not a crash", async () => {
    const send = tpsCliReplySender({ identity: "testbot", tpsBin: join(dir, "no-tps"), keysDir });
    expect(await send(REQ)).toMatchObject({ ok: false, reason: "cli-missing" });
  });

  it("refuses to hand over a reply the CLI would send UNSIGNED (no key for the identity)", async () => {
    const tps = fakeTps();
    const send = tpsCliReplySender({ identity: "otherbot", tpsBin: tps, keysDir });
    expect(await send(REQ)).toMatchObject({ ok: false, reason: "no-signing-key" });
    expect(() => readFileSync(join(dir, "argv"))).toThrow(); // never ran
  });

  it("kills a CLI that does not exit in time", async () => {
    const bin = join(dir, "tps");
    writeFileSync(bin, "#!/bin/sh\nexec sleep 30\n");
    chmodSync(bin, 0o755);
    const send = tpsCliReplySender({ identity: "testbot", tpsBin: bin, keysDir, timeoutMs: 200 });
    expect(await send(REQ)).toMatchObject({ ok: false, reason: "timeout" });
  });
});

describe("capReply — like the Discord mirror", () => {
  it("leaves a short reply alone and cuts a long one to the cap, marked", () => {
    expect(capReply("short", 10)).toBe("short");
    const capped = capReply("x".repeat(50), 10);
    expect(capped).toBe(`${"x".repeat(9)}…`);
    expect(capped.length).toBe(10);
  });
});
