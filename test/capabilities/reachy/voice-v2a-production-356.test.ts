// bob#356 V2a — a voice turn on bob's PRODUCTION path, end to end.
//
// Real: an agent on disk (bob.yaml declaring `flair` and `reachy`), bob's config
// resolution, `startPersistent`, the persistent runtime's own session factory
// (`defaultPersistentFactory`: createPiRunSession → createBobRuntimeFactory,
// pi's durable SessionManager.create for the warm session), a keyed `bob/env`
// provider row whose key is read and deleted once, pi's AgentSession and tool
// loop, the BUILT reachy extension in both sessions, bob's Flair client, and a
// sidecar PROCESS on a real UNIX socket. The runtime is imported from the build
// too, so the extension pi loads and the runtime share bob's modules as in
// production (the speech bridge is registered in one and read in the other).
//
// Not production: the model (the provider's fetch is stubbed at its endpoint and
// answers from a script, so the test reads the exact request body a model would
// receive); the sidecar (driven-sidecar.py: the test supplies the transcript it
// sends); Flair (flair-double.ts, which verifies signatures and serves the
// bootstrap context only to the signing agent, refusing a request that names
// another agent as Flair does); and prMemory, which the persistent runtime
// never loads itself (it comes from a launcher's PR recall), so the factory seam
// seeds it on the warm config before the warm session is built. The same seam hands the
// warm config the reachy tools, as voice-session.test.ts does: no shipped role
// allows a reachy tool yet, and a voice session may only use a tool the agent's
// own policy allows.
//
// The resident session first serves a cron turn: its request carries the Flair
// bootstrap, the prior-round memory and the turn itself (the control). Then the
// sidecar sends one addressed transcript. The voice turn's model requests must
// carry none of them, offer `reachy_say` alone and use the custody-held key; the
// model's `reachy_say` must reach the sidecar as a `say` through the resident
// capability's speech bridge; no session file may appear for the voice turn; and
// the runtime's BOB_PERSISTENT must survive the voice session's build.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// The BUILT runtime (see the header): `bun run build` runs before this lane.
import { initAgent } from "../../../dist/shell/init.js";
import { defaultPersistentFactory, startPersistent } from "../../../dist/shell/persistent.js";
import { loadProviderRegistry } from "../../../dist/shell/provider-registry.js";
import type { RunSession, RunSessionConfig } from "../../../src/shell/run.js";
import { type FlairDouble, startFlairDouble } from "./flair-double.js";
import { must, TEST_SIDECAR_VERSION } from "./handshake.js";

const REPO = join(import.meta.dirname, "..", "..", "..");
const DRIVEN = join(REPO, "test", "fixtures", "reachy-stub", "driven-sidecar.py");
const BUILT = join(REPO, "dist", "capabilities", "reachy", "index.js");

const AGENT = "voiceprod";
const MODEL = "fixture/model";
const ENDPOINT = "https://keyed-fixture.example/v1";
const VARIABLE = "BOB_PROVIDER_KEYED_FIXTURE_KEY";
const SENTINEL = "sk-fixture-VOICE-356-SENTINEL-NOT-A-SECRET";
const REGISTRY_YAML = `version: 1
providers:
  - id: keyed-fixture
    aliases: [keyed-fixture-alias]
    runtime: keyed-fixture-runtime
    auth: bob/env
    endpoint: ${ENDPOINT}
    api: openai-completions
`;

// Markers: each private source carries one, so a request that holds it is caught.
const BOOTSTRAP = "BOOTSTRAP-MARKER-8812: the operator's private standing notes";
const PR_MEMORY = "PRMEMORY-MARKER-4471: the prior review round's private findings";
const RESIDENT_PROMPT = "RESIDENT-HISTORY-5521: the standup moved to Thursday";
const RESIDENT_REPLY = "RESIDENT-REPLY-7730: noted for the standup";
const TRANSCRIPT = "jarvis, what time is it";
const SPOKEN = "It is noon.";

// The process environment this file changes, restored after each test.
const ENV_KEYS = [VARIABLE, "BOB_PERSISTENT", "BOB_CAP_REACHY", "BOB_CAP_FLAIR"] as const;

let root: string;
let savedEnv: Map<string, string | undefined>;
let sidecar: ChildProcess | undefined;
let flair: FlairDouble | undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  // A SHORT prefix: the sidecar's UNIX socket lives directly in this directory,
  // and macOS limits a socket path to 104 bytes (the leak check's own TMPDIR
  // already adds a level).
  root = mkdtempSync(join(tmpdir(), "rvp356-"));
  savedEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  sidecar?.kill();
  sidecar = undefined;
  flair?.close();
  flair = undefined;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

// ── the scripted model, at the keyed provider's endpoint ────────────────────
interface ModelRequest {
  body: { messages: Array<{ role: string; content?: unknown }>; tools?: unknown[] };
  text: string;
  auth: string | null;
}

const USAGE = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
function chunk(delta: Record<string, unknown>, finish: string | null = null): string {
  const body = {
    id: "chatcmpl-356",
    object: "chat.completion.chunk",
    created: 0,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish !== null ? { usage: USAGE } : {}),
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}
const sseText = (text: string) =>
  `${chunk({ role: "assistant", content: text })}${chunk({}, "stop")}data: [DONE]\n\n`;
const sseToolCall = (name: string, args: Record<string, unknown>) =>
  `${chunk({
    role: "assistant",
    tool_calls: [
      {
        index: 0,
        id: "call_356",
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      },
    ],
  })}${chunk({}, "tool_calls")}data: [DONE]\n\n`;

/** One answer per request: after a tool result, end the turn; to the voice
 *  transcript, call `reachy_say`; to anything else, a plain reply. */
function answer(request: ModelRequest): string {
  const messages = request.body.messages;
  if (messages[messages.length - 1]?.role === "tool") return sseText("done");
  if (JSON.stringify(messages).includes(TRANSCRIPT)) {
    return sseToolCall("reachy_say", { text: SPOKEN });
  }
  return sseText(RESIDENT_REPLY);
}

/** Stub the model endpoint; every other URL (the Flair double) goes through. */
function installModel(requests: ModelRequest[]): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url !== `${ENDPOINT}/chat/completions`) return realFetch(input, init);
    const text =
      typeof init?.body === "string" ? init.body : await new Response(init?.body ?? null).text();
    const request: ModelRequest = {
      body: JSON.parse(text),
      text,
      auth: new Headers(init?.headers ?? {}).get("authorization"),
    };
    requests.push(request);
    return new Response(answer(request), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  }) as typeof globalThis.fetch;
}

// ── the sidecar process ─────────────────────────────────────────────────────
function startSidecar(socketPath: string) {
  const proc = spawn("python3", ["-I", DRIVEN, socketPath, TEST_SIDECAR_VERSION], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  sidecar = proc;
  let stdout = "";
  proc.stdout?.on("data", (b: Buffer) => {
    stdout += b.toString();
  });
  const commands = (name: string) =>
    stdout
      .split("\n")
      .filter((line) => line.startsWith("CMD "))
      .map((line) => JSON.parse(line.slice(4)) as { command?: string; args?: { text?: string } })
      .filter((cmd) => cmd.command === name);
  return {
    out: () => stdout,
    commands,
    send(obj: unknown) {
      proc.stdin?.write(`${JSON.stringify(obj)}\n`);
    },
  };
}

async function waitFor(cond: () => boolean, what: string, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** The agent on disk, on the keyed provider row, declaring flair + reachy. */
function agentOnDisk(registry: unknown, flairUrl: string, keyFile: string, socket: string) {
  const agentsRoot = join(root, "agents");
  const { agentDir } = initAgent({
    name: AGENT,
    role: "custom",
    provider: "keyed-fixture",
    model: MODEL,
    contextWindow: 200_000,
    agentsRoot,
    flairKeysDir: join(root, "keys"),
    skipFlair: true,
    registry,
  }) as { agentDir: string };
  const yaml = readFileSync(join(agentDir, "bob.yaml"), "utf8");
  writeFileSync(
    join(agentDir, "bob.yaml"),
    [
      yaml.replace(/^capabilities:.*$/m, "capabilities:\n  - flair\n  - reachy"),
      "flair:",
      `  url: ${flairUrl}`,
      `  agentId: ${AGENT}`,
      `  keyFile: ${keyFile}`,
      "",
      "voice:",
      "  wakeName: jarvis",
      "",
      "reachy:",
      `  socket: ${socket}`,
      `  sidecarVersion: ${TEST_SIDECAR_VERSION}`,
      "  roomSpeechOrigins: []",
      "",
    ].join("\n"),
  );
  return { agentsRoot, agentDir };
}

/** Every session file pi wrote under the agent's durable session directory. */
function sessionFiles(agentDir: string): string[] {
  const dir = join(agentDir, ".pi-agent", "sessions");
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".jsonl"));
}

interface Build {
  config: Partial<RunSessionConfig>;
  loaded: string[];
}

describe("bob#356 V2a — a voice turn on the production path (startPersistent, the real factory, the built reachy extension)", () => {
  it("the voice model sees no resident history, bootstrap or prior-round memory, speaks through the resident bridge, and leaves no session file", async () => {
    expect(existsSync(BUILT), "the reachy extension must be built (bun run build)").toBe(true);
    const registryPath = join(root, "providers.yaml");
    writeFileSync(registryPath, REGISTRY_YAML);
    const registry = loadProviderRegistry({ path: registryPath });
    const key = generateKeyPairSync("ed25519").privateKey;
    flair = await startFlairDouble({ [AGENT]: key }, { bootstrap: BOOTSTRAP });
    const keyFile = join(root, `${AGENT}.key`);
    writeFileSync(keyFile, key.export({ type: "pkcs8", format: "pem" }));
    chmodSync(keyFile, 0o600);
    const socket = join(root, "v.sock");
    const room = startSidecar(socket);
    const { agentsRoot, agentDir } = agentOnDisk(registry, flair.url, keyFile, socket);

    const requests: ModelRequest[] = [];
    installModel(requests);
    process.env[VARIABLE] = SENTINEL;

    // The runtime's own factory, observed. Before the WARM session is built it
    // seeds prMemory on the runtime's config, as a launcher's PR recall would,
    // and grants the reachy tools (see the header).
    const builds: Build[] = [];
    let voiceDisposals = 0;
    const realFactory = defaultPersistentFactory(registry);
    const sessionFactory = async (config: RunSessionConfig): Promise<RunSession> => {
      if (config.persistent === true) {
        config.prMemory = PR_MEMORY;
        config.tools = [...config.tools, "reachy_say", "reachy_state"];
      }
      const snapshot = { ...config };
      const session = await realFactory(config);
      const loader = (
        session as unknown as {
          resourceLoader: { getExtensions(): { extensions: Array<{ path: string }> } };
        }
      ).resourceLoader;
      builds.push({
        config: snapshot,
        loaded: loader.getExtensions().extensions.map((e) => e.path),
      });
      if (config.voiceSpeech !== undefined) {
        // Count the admission's dispose of the fresh voice session.
        const dispose = session.dispose.bind(session);
        session.dispose = () => {
          voiceDisposals += 1;
          dispose();
        };
      }
      return session;
    };

    const handle = await startPersistent({
      name: AGENT,
      agentsRoot,
      registry,
      sessionFactory,
      installSignalHandlers: false,
      keepAlive: async () => {},
      log: () => {},
    });
    try {
      await waitFor(() => room.out().includes("READY"), "the reachy-voice/1 handshake");
      expect(process.env[VARIABLE]).toBeUndefined(); // the warm session took the key

      // ── the CONTROL: a resident cron turn carries the bootstrap, the
      // prior-round memory and the turn ──
      await handle.admitTurn({ kind: "cron", job: "standup" }, RESIDENT_PROMPT);
      const resident = must(requests[0], "the resident request");
      expect(resident.text).toContain(BOOTSTRAP);
      expect(resident.text).toContain(PR_MEMORY);
      expect(resident.text).toContain(RESIDENT_PROMPT);
      expect(resident.auth).toBe(`Bearer ${SENTINEL}`);
      const filesBefore = sessionFiles(agentDir);
      expect(filesBefore.length).toBeGreaterThan(0); // the warm session is durable
      expect(process.env.BOB_PERSISTENT).toBe("1");

      // ── the voice turn: the fixture SENDS an addressed transcript ──
      room.send({
        send: {
          type: "transcript",
          text: TRANSCRIPT,
          ts: new Date().toISOString(),
          wakeHeard: true,
        },
      });
      await waitFor(() => room.commands("say").length === 1, "the say on the sidecar");
      expect(room.commands("say")[0]?.args?.text).toBe(SPOKEN);
      // A second admitted turn queues behind the voice turn, so once it returns
      // the voice turn has settled.
      await handle.admitTurn({ kind: "cron", job: "after" }, "after the voice turn");
      expect(voiceDisposals).toBe(1); // the fresh voice session lived one turn

      const voice = requests.filter((r) => r.text.includes(TRANSCRIPT));
      expect(voice).toHaveLength(2); // the tool call, then the turn's end
      for (const request of voice) {
        expect(request.text).not.toContain(BOOTSTRAP);
        expect(request.text).not.toContain(PR_MEMORY);
        expect(request.text).not.toContain(RESIDENT_PROMPT);
        expect(request.text).not.toContain(RESIDENT_REPLY);
        expect(request.auth).toBe(`Bearer ${SENTINEL}`); // custody, not a re-read
        const tools = (request.body.tools ?? []) as Array<{ function?: { name?: string } }>;
        expect(tools.map((t) => t.function?.name)).toEqual(["reachy_say"]);
      }
      // A fresh session: the only user message is the transcript itself.
      const users = must(voice[0], "the first voice request").body.messages.filter(
        (m) => m.role === "user",
      );
      expect(users).toHaveLength(1);
      expect(JSON.stringify(users[0])).toContain(TRANSCRIPT);

      // The say was the voice turn's, audited under the agent's own identity.
      expect(flair.audits.some((a) => a.kind === "reachy.say" && a.owner === AGENT)).toBe(true);
      // The voice turn wrote no session file; the warm session kept its own.
      expect(sessionFiles(agentDir)).toEqual(filesBefore);
      // The runtime's mode flag survived the non-persistent build.
      expect(process.env.BOB_PERSISTENT).toBe("1");

      // What the runtime asked its factory for, and what pi loaded for it.
      const voiceBuild = must(
        builds.find((b) => b.config.voiceSpeech !== undefined),
        "the voice session build",
      );
      const warmBuild = must(
        builds.find((b) => b.config.persistent === true),
        "the warm session build",
      );
      const reachySource = must(
        Object.entries(warmBuild.config.capabilityBySource ?? {}).find(([, n]) => n === "reachy"),
        "the reachy source",
      )[0];
      const flairSource = must(
        Object.entries(warmBuild.config.capabilityBySource ?? {}).find(([, n]) => n === "flair"),
        "the flair source",
      )[0];
      expect(warmBuild.loaded).toContain(flairSource);
      expect(voiceBuild.config.persistent).toBe(false);
      expect(voiceBuild.config.tools).toEqual(["reachy_say"]);
      expect(voiceBuild.config.excludeTools).toEqual([]);
      expect(voiceBuild.config.extensionSources).toEqual([reachySource]);
      expect(voiceBuild.loaded).toContain(reachySource);
      expect(voiceBuild.loaded).not.toContain(flairSource);
      expect(voiceBuild.loaded).toContain("<inline:bob-tool-admission>");
      expect("flairBootstrap" in voiceBuild.config).toBe(false);
      expect("prMemory" in voiceBuild.config).toBe(false);
    } finally {
      await handle.shutdown();
    }
  }, 90_000);
});

describe("bob#356 V2a — a voice session needs the agent's tool policy and a speech bridge", () => {
  /** A reviewer agent (no reachy tool in its role) under a scripted resident
   *  session; `grant` adds reachy_say to the warm config, as a role that allowed
   *  it would, and `bridge` registers a resident speech bridge as the reachy
   *  capability does. */
  async function policyWorld(name: string, extraYaml: string[], grant: boolean, bridge = true) {
    const dir = join(root, "agents", name);
    mkdirSync(join(dir, "work"), { recursive: true });
    mkdirSync(join(dir, ".pi-agent"), { recursive: true });
    writeFileSync(join(dir, "soul.md"), "You are a test agent.");
    writeFileSync(
      join(dir, "bob.yaml"),
      [
        "agent:",
        `  id: ${name}`,
        "  name: Policy",
        "  role: reviewer",
        "",
        "provider:",
        "  name: anthropic",
        "  model: claude-sonnet-4-6",
        "",
        "tools:",
        "  allow:",
        "    - read",
        ...extraYaml,
        "",
      ].join("\n"),
    );
    const { registerVoiceSpeech } = await import("../../../dist/shell/turn-admission.js");
    const configs: RunSessionConfig[] = [];
    const handle = await startPersistent({
      name,
      agentsRoot: join(root, "agents"),
      installSignalHandlers: false,
      keepAlive: async () => {},
      log: () => {},
      sessionFactory: async (config: RunSessionConfig): Promise<RunSession> => {
        configs.push(config);
        if (grant && config.persistent === true) config.tools = [...config.tools, "reachy_say"];
        if (bridge && config.turnAdmission)
          registerVoiceSpeech(config.turnAdmission, async () => ({}));
        return { subscribe: () => () => {}, dispose() {}, async prompt() {} };
      },
    });
    const voiceTurn = () =>
      handle.admitTurn(
        { kind: "voice", speakerVerified: false, utteranceId: "utt_x", correlationId: "corr_x" },
        "jarvis, what time is it",
      );
    return { handle, configs, voiceTurn };
  }

  it("refuses by name when reachy_say is not in the agent's allowlist", async () => {
    const world = await policyWorld("unlisted", [], false);
    try {
      expect(world.configs[0]?.tools).not.toContain("reachy_say");
      await expect(world.voiceTurn()).rejects.toThrow(
        "this agent's tool policy does not allow reachy_say",
      );
      expect(world.configs).toHaveLength(1); // no voice session was built
    } finally {
      await world.handle.shutdown();
    }
  });

  it("refuses by name when the operator's tools.exclude removes reachy_say", async () => {
    const world = await policyWorld("excluded", ["  exclude:", "    - reachy_say"], true);
    try {
      expect(world.configs[0]?.tools).toContain("reachy_say");
      expect(world.configs[0]?.excludeTools).toContain("reachy_say");
      await expect(world.voiceTurn()).rejects.toThrow(
        "this agent's tool policy does not allow reachy_say",
      );
      expect(world.configs).toHaveLength(1);
    } finally {
      await world.handle.shutdown();
    }
  });

  it("refuses by name when no speech bridge is registered, before building a session", async () => {
    const world = await policyWorld("unbridged", [], true, false);
    try {
      expect(world.configs[0]?.tools).toContain("reachy_say");
      await expect(world.voiceTurn()).rejects.toThrow("no reachy speech bridge is registered");
      expect(world.configs).toHaveLength(1);
    } finally {
      await world.handle.shutdown();
    }
  });

  it("CONTROL: allowed and not excluded, the voice session is built", async () => {
    const world = await policyWorld("allowed", [], true);
    try {
      await world.voiceTurn();
      expect(world.configs).toHaveLength(2);
      expect(world.configs[1]?.tools).toEqual(["reachy_say"]);
    } finally {
      await world.handle.shutdown();
    }
  });
});
