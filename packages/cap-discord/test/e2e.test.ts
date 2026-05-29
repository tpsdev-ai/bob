import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { CONFIG_ENV_VAR } from "../src/config.js";

// The load-bearing proof (mirrors the cap-fixture e2e): a REAL pi AgentSession
// built with the discord extension source surfaces discord_reply/react/fetch in
// session.getAllTools(). No live gateway, no real token — the extension's
// connect failure on an invalid token is non-fatal, so tools still register.

const extensionPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "src", "index.ts");

describe("discord capability — end to end with a real pi session", () => {
  it("composes discord_reply/react/fetch into the session", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "cap-discord-cwd-"));
    const agentDir = mkdtempSync(join(tmpdir(), "cap-discord-pi-"));
    const tokenFile = join(cwd, "bot.token");
    // An intentionally invalid token (format-invalid → discord.js rejects fast,
    // ~170ms, before any WS). The factory logs + continues, tools still surface.
    writeFileSync(tokenFile, "invalid.token.value\n", "utf8");

    const prevEnv = process.env[CONFIG_ENV_VAR];
    process.env[CONFIG_ENV_VAR] = JSON.stringify({
      tokenFile,
      channelIds: ["123456789012345678"],
    });

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
      rmSync(cwd, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    }
  }, 30000);
});
