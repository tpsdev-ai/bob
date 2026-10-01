import assert from "node:assert/strict";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { initAgent } from "../../src/shell/init.js";
import { startPersistent } from "../../src/shell/persistent.js";
import { resolveRunConfig } from "../../src/shell/run.js";
import { runInteractiveSession } from "../../src/shell/session.js";

const name = process.argv[2];
const agentsRoot = process.argv[3];
assert(name === "persistent" || name === "interactive");
assert(agentsRoot);

const { agentDir } = initAgent({
  name: "testbot",
  role: "coder",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  contextWindow: 200_000,
  agentsRoot,
  skipFlair: true,
  capabilities: [],
  toolAllow: ["read"],
});
const sessionDir = join(agentDir, ".pi-agent", "sessions");

function writeExchange(manager: SessionManager, text: string): void {
  manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "acknowledged" }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
}

function hasUserMessage(manager: SessionManager, text: string): boolean {
  return manager
    .getEntries()
    .some(
      (entry) =>
        entry.type === "message" && entry.message.role === "user" && entry.message.content === text,
    );
}

let file: string | undefined;
if (name === "persistent") {
  const handle = await startPersistent({
    name: "testbot",
    agentsRoot,
    installSignalHandlers: false,
    log: () => {},
  });
  try {
    const manager = (handle.session as typeof handle.session & { sessionManager: SessionManager })
      .sessionManager;
    writeExchange(manager, "persistent transcript");
    file = manager.getSessionFile();
    assert.equal(manager.getSessionDir(), sessionDir);
    const resumed = SessionManager.continueRecent(manager.getCwd(), sessionDir);
    assert.equal(resumed.getSessionFile(), file);
    assert(hasUserMessage(resumed, "persistent transcript"));
  } finally {
    await handle.shutdown();
  }
} else {
  const { config, policy } = resolveRunConfig({ name: "testbot", agentsRoot });
  await runInteractiveSession({
    config,
    policy,
    modeFactory: (runtime) => ({
      run: async () => {
        try {
          const manager = runtime.session.sessionManager;
          writeExchange(manager, "interactive transcript");
          file = manager.getSessionFile();
          assert.equal(manager.getSessionDir(), sessionDir);
        } finally {
          await runtime.dispose();
        }
      },
    }),
  });
  await runInteractiveSession({
    config,
    policy,
    modeFactory: (runtime) => ({
      run: async () => {
        try {
          const choices = await SessionManager.list(
            config.cwd,
            runtime.session.sessionManager.getSessionDir(),
          );
          assert(choices.some((choice) => choice.path === file));
          assert(file);
          assert.deepEqual(await runtime.switchSession(file), { cancelled: false });
          assert.equal(runtime.session.sessionManager.getSessionFile(), file);
          assert(hasUserMessage(runtime.session.sessionManager, "interactive transcript"));
        } finally {
          await runtime.dispose();
        }
      },
    }),
  });
}

assert(file);
process.stdout.write(JSON.stringify({ file, sessionDir }));
