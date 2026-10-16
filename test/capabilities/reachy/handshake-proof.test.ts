// Refs #360 — the release-host handshake proof, unit-tested against scratch
// listeners started here. On the release host the proof runs against the
// DEPLOYED socket named in the agent's `bob.yaml`; here the listener is a fake
// on the far side of the wire, and bob's real client and decoder are on ours.
// The probe judges the reply by bob's OWN rules, so a reply bob would refuse
// never passes. Each failure is asserted by its NAMED reason. The real Python
// sidecar on the same wire, with a live session, is exercised in
// voice-sidecar.test.ts.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandshakeExpectation } from "../../../src/capabilities/reachy/wire.js";
import { VOICE_PROTOCOL } from "../../../src/capabilities/reachy/wire.js";
import { probeVoiceHandshake } from "./handshake-proof.js";

const dirs: string[] = [];
const servers: Server[] = [];
const held: Socket[] = [];
afterAll(() => {
  for (const socket of held) socket.destroy();
  for (const server of servers) server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "rvhp-"));
  dirs.push(dir);
  return dir;
}

/** Start a listener on a fresh scratch socket path; `onConnect` drives it. */
async function listener(onConnect: (socket: Socket) => void): Promise<string> {
  const path = join(scratchDir(), "voice.sock");
  const server = createServer((socket) => {
    held.push(socket);
    onConnect(socket);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(path, () => resolve()));
  return path;
}

const VERSION = "0.1.0";
/** What bob would push and expect back on a `voice` link with the default wake
 *  name and generation 1. */
const EXPECT: HandshakeExpectation = {
  version: VERSION,
  profile: "voice",
  wakeName: "jarvis",
  generation: 1,
};

/** A strict `reachy-voice/1` health line, with any field overridden. */
const health = (over: Record<string, unknown> = {}): string =>
  `${JSON.stringify({
    type: "health",
    protocol: VOICE_PROTOCOL,
    version: VERSION,
    profile: "voice",
    generation: 1,
    wakeName: "jarvis",
    mode: "off",
    trainedPhrase: null,
    modelHash: null,
    muted: false,
    ok: true,
    ...over,
  })}\n`;

/** Answer each `configure` with a health line, with `over` applied. */
function answering(over: Record<string, unknown> = {}): (socket: Socket) => void {
  return (socket) => {
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl < 0) break;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        const command = JSON.parse(line) as { command?: string };
        if (command.command === "configure") socket.write(health(over));
      }
    });
  };
}

const FAST = { timeoutMs: 300, connectMs: 1_000 };

describe("Refs #360 — the release-host reachy-voice/1 handshake proof", () => {
  it("passes when the listener completes the handshake with bob's own fields", async () => {
    const path = await listener(answering());
    expect(await probeVoiceHandshake(path, EXPECT, FAST)).toEqual({ ok: true, version: VERSION });
  });

  it("no-listener: a missing socket path fails no-listener", async () => {
    const path = join(scratchDir(), "voice.sock");
    const result = await probeVoiceHandshake(path, EXPECT, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-listener");
  });

  it("no-listener: a dead socket path (a plain file where the socket should be) fails no-listener", async () => {
    const path = join(scratchDir(), "voice.sock");
    writeFileSync(path, "not a socket\n");
    const result = await probeVoiceHandshake(path, EXPECT, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-listener");
  });

  it("handshake-timeout: a wedged listener (accepts, never answers) fails handshake-timeout", async () => {
    const path = await listener(() => {}); // accepts and holds; never answers
    const result = await probeVoiceHandshake(path, EXPECT, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("handshake-timeout");
  });

  it("handshake-timeout: the one limit covers configure and reply — a reply past the limit fails, and the probe gives up within the limit", async () => {
    const path = await listener((socket) => {
      socket.once("data", () => {
        setTimeout(() => socket.write(health()), 600);
      });
    });
    const started = Date.now();
    const result = await probeVoiceHandshake(path, EXPECT, { timeoutMs: 300, connectMs: 1_000 });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("handshake-timeout");
    expect(elapsed).toBeLessThan(600); // bounded by the limit, not by the reply
  });

  it("handshake-rejected: a first line that is not a health line is refused", async () => {
    const path = await listener((socket) => {
      socket.write(
        `${JSON.stringify({ type: "transcript", text: "hi", ts: "t", wakeHeard: false })}\n`,
      );
    });
    const result = await probeVoiceHandshake(path, EXPECT, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("handshake-rejected");
  });

  it("handshake-rejected: a health line reporting ok:false is refused", async () => {
    const path = await listener(answering({ ok: false }));
    const result = await probeVoiceHandshake(path, EXPECT, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("handshake-rejected");
    expect(result.detail).toContain("ok");
  });

  it("handshake-rejected: a health line naming another version is refused", async () => {
    const path = await listener(answering({ version: "9.9.9" }));
    const result = await probeVoiceHandshake(path, EXPECT, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("handshake-rejected");
    expect(result.version).toBe("9.9.9");
    expect(result.detail).toContain("version");
  });

  it("handshake-rejected: a health line naming another profile is refused", async () => {
    const path = await listener(answering({ profile: "reachy" }));
    const result = await probeVoiceHandshake(path, EXPECT, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("handshake-rejected");
    expect(result.detail).toContain("profile");
  });

  it("handshake-rejected: a health line naming another wake name is refused", async () => {
    const path = await listener(answering({ wakeName: "rocky" }));
    const result = await probeVoiceHandshake(path, EXPECT, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("handshake-rejected");
    expect(result.detail).toContain("wakeName");
  });

  it("handshake-rejected: a health line reporting another generation is refused", async () => {
    const path = await listener(answering({ generation: 2 }));
    const result = await probeVoiceHandshake(path, EXPECT, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("handshake-rejected");
    expect(result.detail).toContain("generation");
  });

  it("handshake-rejected: a health line with an inconsistent artifact pair is refused", async () => {
    const path = await listener(
      answering({ mode: "off", trainedPhrase: "jarvis", modelHash: null }),
    );
    const result = await probeVoiceHandshake(path, EXPECT, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("handshake-rejected");
    expect(result.detail).toContain("trainedPhrase/modelHash pair");
  });
});
