import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { CONFIG_ENV_VAR } from "../../../src/capabilities/discord/config.js";

// The load-bearing proof (mirrors the fixture capability's e2e): a REAL pi AgentSession
// built with the discord extension source surfaces discord_reply/react/fetch in
// session.getAllTools(). No live gateway, no real token. This runs in RUN mode
// (BOB_PERSISTENT unset), so the extension opens NO gateway at all — the
// outbound REST tools register regardless. (Persistent mode would additionally
// attempt the gateway connect, which is non-fatal on a bad token.)

// Resolved through the package's own `exports` map — the same mechanism the
// blessed catalog uses at session setup, so this test fails if the published
// exports map stops pointing at a built extension.
const extensionPath = fileURLToPath(import.meta.resolve("@tpsdev-ai/bob/capabilities/discord"));

describe("discord capability — end to end with a real pi session", () => {
  it("composes discord_reply/react/fetch into the session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cap-discord-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "cap-discord-pi-"));
    const tokenFile = join(cwd, "bot.token");
    // An intentionally invalid token (format-invalid → discord.js rejects fast,
    // ~170ms, before any WS). The factory logs + continues, tools still surface.
    writeFileSync(tokenFile, "invalid.token.value\n", "utf8");

    const prevEnv = process.env[CONFIG_ENV_VAR];
    const prevPersist = process.env.BOB_PERSISTENT;
    process.env[CONFIG_ENV_VAR] = JSON.stringify({
      tokenFile,
      channelIds: ["123456789012345678"],
    });
    // RUN mode — no gateway. Outbound REST tools must still register.
    process.env.BOB_PERSISTENT = "";

    try {
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        additionalExtensionPaths: [extensionPath],
      });
      await loader.reload();
      expect(loader.getExtensions().errors ?? []).toEqual([]);

      const { session } = await createAgentSession({
        cwd,
        agentDir,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory(cwd),
      });
      try {
        const toolNames = session.getAllTools().map((t) => t.name);
        expect(toolNames).toContain("discord_reply");
        expect(toolNames).toContain("discord_react");
        expect(toolNames).toContain("discord_fetch");
      } finally {
        session.dispose();
      }
    } finally {
      if (prevEnv === undefined) delete process.env[CONFIG_ENV_VAR];
      else process.env[CONFIG_ENV_VAR] = prevEnv;
      if (prevPersist === undefined) delete process.env.BOB_PERSISTENT;
      else process.env.BOB_PERSISTENT = prevPersist;
      rmSync(cwd, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 30000);
});
