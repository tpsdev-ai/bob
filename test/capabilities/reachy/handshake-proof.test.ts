// Refs #360 — the release-host handshake proof, unit-tested against scratch
// listeners started here. On the release host the proof runs against the
// DEPLOYED socket named in the agent's `bob.yaml`; here the listener is a fake
// on the far side of the wire, and bob's real client is on ours. Each failure
// is asserted by its NAMED reason.
import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** A strict `reachy-voice/1` health line naming `version`. */
const health = (version: string, generation: number): string =>
  `${JSON.stringify({
    type: "health",
    protocol: VOICE_PROTOCOL,
    version,
    profile: "voice",
    generation,
    wakeName: "jarvis",
    mode: "off",
    trainedPhrase: null,
    modelHash: null,
    muted: false,
    ok: true,
  })}\n`;

/** Answer each `configure` with a health line naming `version`. */
function answering(version: string): (socket: Socket) => void {
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
        const command = JSON.parse(line) as { command?: string; args?: { generation?: number } };
        if (command.command === "configure")
          socket.write(health(version, command.args?.generation ?? 1));
      }
    });
  };
}

const VERSION = "0.1.0";
const FAST = { timeoutMs: 300, connectMs: 1_000 };

describe("Refs #360 — the release-host reachy-voice/1 handshake proof", () => {
  it("passes when the listener completes the handshake and reports the configured version", async () => {
    const path = await listener(answering(VERSION));
    expect(await probeVoiceHandshake(path, VERSION, FAST)).toEqual({ ok: true, version: VERSION });
  });

  it("no-listener: a missing socket path fails no-listener", async () => {
    const path = join(scratchDir(), "voice.sock");
    const result = await probeVoiceHandshake(path, VERSION, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-listener");
  });

  it("no-listener: a dead socket path (a plain file where the socket should be) fails no-listener", async () => {
    const path = join(scratchDir(), "voice.sock");
    writeFileSync(path, "not a socket\n");
    const result = await probeVoiceHandshake(path, VERSION, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no-listener");
  });

  it("handshake-timeout: a wedged listener (accepts, never answers) fails handshake-timeout", async () => {
    const path = await listener(() => {}); // accepts and holds; never answers
    const result = await probeVoiceHandshake(path, VERSION, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("handshake-timeout");
  });

  it("version-mismatch: a completed handshake reporting another version fails version-mismatch", async () => {
    const path = await listener(answering("9.9.9"));
    const result = await probeVoiceHandshake(path, VERSION, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("version-mismatch");
    expect(result.version).toBe("9.9.9");
  });

  it("busy: a listener already serving its one connection fails busy (its further connect is refused)", async () => {
    let path = "";
    path = await listener(() => {
      // The single session: this connection is held unanswered, and its path is
      // unlinked so a further connect is refused — the deployed sidecar's
      // saturated `listen(1)` queue, reproduced in one process.
      unlinkSync(path);
    });
    const result = await probeVoiceHandshake(path, VERSION, FAST);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("busy");
  });
});
