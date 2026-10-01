// bob#254 — the Flair session bootstrap: the shell-side loader and every
// entry path that builds a system prompt.
//
// The unit tests drive loadFlairBootstrapContext through its seams. The entry
// tests stand up a REAL local HTTP stub as Flair and run the actual paths:
// `bob run` one-shot, the mail turn, the interactive launch, and the persistent
// runtime — so the real HTTP + Ed25519 signing path runs, not a fake client.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeMailTurnInput } from "../../src/capabilities/tps-mail/prompt.js";
import type { ConfigViewInput } from "../../src/shell/data-class.js";
import {
  DEFAULT_FLAIR_BOOTSTRAP_TOKENS,
  FLAIR_BOOTSTRAP_HEADING,
  flairBootstrapTarget,
  loadFlairBootstrapContext,
} from "../../src/shell/flair-bootstrap.js";
import { startPersistent } from "../../src/shell/persistent.js";
import {
  type RunSession,
  type RunSessionConfig,
  runAgent,
  runLaunch,
  runMailTurnLaunch,
} from "../../src/shell/run.js";

const SKILLS_CONTEXT = "## Identity\nrole: reviewer\n\n## Active Skills\n- skill-x (source: org)";

// A real PEM PKCS8 Ed25519 key, written to a temp file so the client's key
// parser runs for real.
function writeKeyFile(dir: string): string {
  const path = join(dir, "testbot.key");
  const pem = generateKeyPairSync("ed25519").privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;
  writeFileSync(path, pem);
  return path;
}

interface Stub {
  url: string;
  calls: Array<{ method: string; path: string; auth: string; body: string }>;
  close(): Promise<void>;
}

async function startStub(
  respond: (req: { method: string; path: string; body: string }) => {
    status: number;
    body: string;
  },
): Promise<Stub> {
  const calls: Stub["calls"] = [];
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const method = req.method ?? "";
      const path = req.url ?? "";
      const auth = String(req.headers.authorization ?? "");
      calls.push({ method, path, auth, body: raw });
      const r = respond({ method, path, body: raw });
      res.writeHead(r.status, { "content-type": "application/json" });
      res.end(r.body);
    });
  });
  await new Promise<void>((resolve) => srv.listen(0, "127.0.0.1", () => resolve()));
  const port = (srv.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((resolve) => srv.close(() => resolve())),
  };
}

// A session that settles one clean assistant message (the compaction contract's
// "final"), matching pi's message_end shape.
function scriptedSession(): RunSession {
  const listeners: Array<(e: unknown) => void> = [];
  return {
    subscribe(l) {
      listeners.push(l as (e: unknown) => void);
      return () => {};
    },
    async prompt() {
      for (const l of listeners) {
        l({
          type: "message_end",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "ok" }],
            stopReason: "stop",
          },
        });
      }
    },
    dispose() {},
  };
}

function scaffold(
  root: string,
  name: string,
  opts: { url: string; keyFile: string; tokens?: number },
): void {
  const dir = join(root, name);
  mkdirSync(join(dir, "work"), { recursive: true });
  mkdirSync(join(dir, ".pi-agent"), { recursive: true });
  writeFileSync(join(dir, "soul.md"), "You are Testbot.");
  writeFileSync(
    join(dir, "bob.yaml"),
    [
      "agent:",
      `  id: ${name}`,
      "  name: Testbot",
      "  role: reviewer",
      "",
      "provider:",
      "  name: anthropic",
      "  model: claude-sonnet-4-6",
      "",
      "tools:",
      "  allow:",
      "    - read",
      "",
      "capabilities:",
      "  - flair",
      "",
      "flair:",
      `  url: ${opts.url}`,
      `  agentId: ${name}`,
      `  keyFile: ${opts.keyFile}`,
      ...(opts.tokens !== undefined ? [`  bootstrap_tokens: ${opts.tokens}`] : []),
      "",
    ].join("\n"),
  );
}

describe("loadFlairBootstrapContext (unit, via seams)", () => {
  const target = { url: "http://127.0.0.1:9926", agentId: "pulse", keyFile: "/k", maxTokens: 1000 };
  const gate: Pick<
    ConfigViewInput,
    "extensionSources" | "capabilityBySource" | "tools" | "excludeTools"
  > = {
    extensionSources: ["/cap/flair"],
    capabilityBySource: { "/cap/flair": "flair" },
    tools: [],
  };
  const pem = () =>
    generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  it("appends a headed block carrying the Active Skills section on success", async () => {
    const text = await loadFlairBootstrapContext({
      target,
      gate,
      seams: {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ context: SKILLS_CONTEXT }),
        }),
        readFile: () => Buffer.from(pem()),
      },
    });
    expect(text.startsWith(FLAIR_BOOTSTRAP_HEADING)).toBe(true);
    expect(text).toContain("## Active Skills");
    expect(text).toContain("skill-x");
  });

  it("returns nothing for a blank context (a load with no content is not a failure)", async () => {
    const text = await loadFlairBootstrapContext({
      target,
      gate,
      seams: {
        fetchImpl: async () => ({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ context: "  " }),
        }),
        readFile: () => Buffer.from(pem()),
      },
    });
    expect(text).toBe("");
  });

  it("on a non-2xx returns a one-line 'could not load' note, with the status and no invented context", async () => {
    const logs: string[] = [];
    const text = await loadFlairBootstrapContext({
      target,
      gate,
      log: (m) => logs.push(m),
      seams: {
        fetchImpl: async () => ({ ok: false, status: 503, text: async () => "boom secret" }),
        readFile: () => Buffer.from(pem()),
      },
    });
    expect(text).toContain("could not be loaded");
    expect(text).toContain("HTTP 503");
    expect(text).not.toContain("Active Skills");
    expect(text).not.toContain("boom");
    expect(logs.join("\n")).toContain("HTTP 503");
  });

  it("on an unreachable Flair returns the note saying so, and logs", async () => {
    const logs: string[] = [];
    const text = await loadFlairBootstrapContext({
      target,
      gate,
      log: (m) => logs.push(m),
      seams: {
        fetchImpl: async () => {
          throw new Error("ECONNREFUSED");
        },
        readFile: () => Buffer.from(pem()),
      },
    });
    expect(text).toContain("could not be loaded");
    expect(text).toContain("unreachable");
    expect(logs.join("\n")).toContain("unreachable");
  });

  it("on a malformed body returns the note, naming no context", async () => {
    const text = await loadFlairBootstrapContext({
      target,
      gate,
      seams: {
        fetchImpl: async () => ({ ok: true, status: 200, text: async () => "not json" }),
        readFile: () => Buffer.from(pem()),
      },
    });
    expect(text).toContain("could not be loaded");
    expect(text).toContain("carried no context");
  });

  it("a session that holds web appends nothing (the data-class gate refuses it) and logs", async () => {
    const logs: string[] = [];
    let fetched = false;
    const text = await loadFlairBootstrapContext({
      target,
      gate: { extensionSources: [], tools: ["web_fetch"] },
      log: (m) => logs.push(m),
      seams: {
        fetchImpl: async () => {
          fetched = true;
          return { ok: true, status: 200, text: async () => "{}" };
        },
        readFile: () => Buffer.from(pem()),
      },
    });
    expect(text).toBe("");
    expect(fetched).toBe(false);
    expect(logs.join("\n")).toContain("holds web");
  });
});

describe("flairBootstrapTarget", () => {
  it("defaults the budget and reads flair.bootstrap_tokens", () => {
    const base = { name: "flair", config: { url: "u", agentId: "a", keyFile: "k" } };
    expect(flairBootstrapTarget([base])?.maxTokens).toBe(DEFAULT_FLAIR_BOOTSTRAP_TOKENS);
    expect(
      flairBootstrapTarget([
        { name: "flair", config: { url: "u", agentId: "a", keyFile: "k", bootstrap_tokens: 1234 } },
      ])?.maxTokens,
    ).toBe(1234);
  });

  it("is undefined when the agent does not configure flair", () => {
    expect(flairBootstrapTarget([{ name: "discord", config: {} }])).toBeUndefined();
  });
});

describe("entry paths carry the Flair bootstrap", () => {
  let root: string;
  let keyFile: string;
  const stubs: Stub[] = [];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-flairboot-"));
    keyFile = writeKeyFile(root);
  });
  afterEach(async () => {
    for (const s of stubs.splice(0)) await s.close();
    rmSync(root, { recursive: true, force: true });
  });

  const okStub = async () =>
    await startStub(() => ({
      status: 200,
      body: JSON.stringify({ context: SKILLS_CONTEXT, tokenEstimate: 7 }),
    }));

  it("`bob run` one-shot: the factory's config carries the block, soul unchanged", async () => {
    const stub = await okStub();
    stubs.push(stub);
    scaffold(root, "testbot", { url: stub.url, keyFile });
    let config: RunSessionConfig | undefined;
    await runAgent({
      name: "testbot",
      prompt: "what skills do you have?",
      agentsRoot: root,
      sessionFactory: async (c) => {
        config = c;
        return scriptedSession();
      },
    });
    expect(config?.appendSystemPrompt).toBe("You are Testbot.");
    expect(config?.flairBootstrap).toContain(FLAIR_BOOTSTRAP_HEADING);
    expect(config?.flairBootstrap).toContain("## Active Skills");
    expect(config?.flairBootstrap).toContain("skill-x");
    expect(stub.calls.some((c) => c.method === "POST" && c.path === "/BootstrapMemories")).toBe(
      true,
    );
  });

  it("the mail turn (runMailTurnLaunch) carries it too", async () => {
    const stub = await okStub();
    stubs.push(stub);
    scaffold(root, "testbot", { url: stub.url, keyFile });
    const input = serializeMailTurnInput({ sender: "flint", messageId: "m-1", body: "hi" });
    let config: RunSessionConfig | undefined;
    await runMailTurnLaunch({
      name: "testbot",
      input,
      agentsRoot: root,
      nonce: "feedfacefeedface",
      sessionFactory: async (c) => {
        config = c;
        return scriptedSession();
      },
      write: async () => {},
    });
    expect(config?.flairBootstrap).toContain("## Active Skills");
  });

  it("the interactive launch path carries it", async () => {
    const stub = await okStub();
    stubs.push(stub);
    scaffold(root, "testbot", { url: stub.url, keyFile });
    let config: RunSessionConfig | undefined;
    await runLaunch({
      name: "testbot",
      agentsRoot: root,
      interactive: async ({ config: c }) => {
        config = c;
        return 0;
      },
    });
    expect(config?.flairBootstrap).toContain("## Active Skills");
  });

  it("the persistent runtime (warm session) carries it", async () => {
    const stub = await okStub();
    stubs.push(stub);
    scaffold(root, "testbot", { url: stub.url, keyFile });
    let config: RunSessionConfig | undefined;
    const handle = await startPersistent({
      name: "testbot",
      agentsRoot: root,
      log: () => {},
      installSignalHandlers: false,
      sessionFactory: async (c) => {
        config = c;
        return scriptedSession();
      },
    });
    expect(config?.flairBootstrap).toContain("## Active Skills");
    await handle.shutdown();
  });

  it("passes bob.yaml's flair.bootstrap_tokens as maxTokens", async () => {
    const stub = await okStub();
    stubs.push(stub);
    scaffold(root, "testbot", { url: stub.url, keyFile, tokens: 333 });
    await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot: root,
      sessionFactory: async () => scriptedSession(),
    });
    const boot = stub.calls.find((c) => c.path === "/BootstrapMemories");
    expect(JSON.parse(boot?.body ?? "{}")).toEqual({ agentId: "testbot", maxTokens: 333 });
  });

  it("a failing Flair: the session starts, and the prompt carries the 'could not load' line, no fake context", async () => {
    const stub = await startStub(() => ({ status: 500, body: "nope" }));
    stubs.push(stub);
    scaffold(root, "testbot", { url: stub.url, keyFile });
    let config: RunSessionConfig | undefined;
    await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot: root,
      sessionFactory: async (c) => {
        config = c;
        return scriptedSession();
      },
    });
    expect(config?.flairBootstrap).toContain("could not be loaded");
    expect(config?.flairBootstrap).not.toContain("Active Skills");
  });

  it("an unreachable Flair: the session starts with the note", async () => {
    const stub = await startStub(() => ({ status: 200, body: "{}" }));
    const url = stub.url;
    await stub.close(); // nothing is listening now
    scaffold(root, "testbot", { url, keyFile });
    let config: RunSessionConfig | undefined;
    await runAgent({
      name: "testbot",
      prompt: "hi",
      agentsRoot: root,
      sessionFactory: async (c) => {
        config = c;
        return scriptedSession();
      },
    });
    expect(config?.flairBootstrap).toContain("could not be loaded");
    expect(config?.flairBootstrap).toContain("unreachable");
  });
});
