// bob#356 round 1 — the speech origin through the REAL session path. No fake pi
// registry: an agent on disk (bob.yaml declaring `flair` and `reachy`), bob's
// real config resolution, resource loader and session factory, the REAL reachy
// extension (the built package), a scripted model that calls `reachy_say`, the
// REAL voice sidecar on a UNIX socket, and a local HTTP Flair double that
// accepts the audit writes.
//
//   * one-shot `bob run`: the runtime declares `run` for the session, so a
//     `run` grant speaks; the session's EFFECTIVE tools under the voice profile
//     are reachy_say/reachy_state, and no body tool is even registered;
//   * persistent runtime: a prompt OUTSIDE every admission is bound to nothing
//     and refuses — even with `run` granted — while an admitted cron turn
//     speaks under its own `cron:<job>` grant.
//
// No shipped role allows a reachy tool yet, so the session factory is handed
// the reachy tools as its policy (as the anchored-edit integration test does);
// everything else is production code.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { initAgent } from "../../../src/shell/init.js";
import { startPersistent } from "../../../src/shell/persistent.js";
import type { RunSession, RunSessionConfig, RunSessionFactory } from "../../../src/shell/run.js";
import { runAgent } from "../../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../../src/shell/session.js";
import { must } from "./handshake.js";

const REPO = join(import.meta.dirname, "..", "..", "..");
const SIDECAR = join(REPO, "sidecar", "reachy-voice", "sidecar.py");
const FIXTURES = join(REPO, "test", "fixtures", "reachy-voice");
const BUILT = join(REPO, "dist", "capabilities", "reachy", "index.js");
const SIDECAR_VERSION = /^SIDECAR_VERSION = "([^"]+)"$/m.exec(readFileSync(SIDECAR, "utf8"))?.[1];
const STUB_PROVIDER = "bob-stub";
const STUB_MODEL = "stub-1";

let root: string;
let sidecar: ChildProcess | undefined;
let sidecarLog = "";
let flair: Server;
let flairUrl = "";
const audits: Array<{ kind: string; summary: string }> = [];

function python(): string {
  return spawnSync(
    "python3",
    ["-I", "-c", "import os,sys;print(os.path.realpath(sys.executable))"],
    {
      encoding: "utf8",
    },
  ).stdout.trim();
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "rvs-session-"));
  // The local Flair double: Memory PUTs are recorded (the reachy audit store
  // writes its OrgEvents there); everything else is 404.
  flair = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      if (req.method === "PUT" && req.url?.startsWith("/Memory/")) {
        try {
          const event = JSON.parse(JSON.parse(body).content) as { kind: string; summary: string };
          audits.push({ kind: event.kind, summary: event.summary });
        } catch {
          /* not an OrgEvent */
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => flair.listen(0, "127.0.0.1", () => r()));
  const addr = flair.address();
  flairUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => {
  sidecar?.kill();
  flair.close();
  delete process.env.BOB_CAP_REACHY;
  delete process.env.BOB_CAP_FLAIR;
  rmSync(root, { recursive: true, force: true });
});

/** The REAL voice sidecar (stand-in Piper and player) on its own socket: it
 *  serves ONE connection at a time, and a finished in-process session keeps
 *  its link until its process exits, so each test gets its own. */
async function startSidecar(tag: string): Promise<string> {
  sidecarLog = "";
  const py = python();
  const tts = join(root, `tts-${tag}`);
  mkdirSync(tts);
  for (const [name, src] of [
    ["piper", "fake-piper.py"],
    ["player", "fake-player.py"],
  ] as const) {
    writeFileSync(join(tts, name), `#!${py} -I\n${readFileSync(join(FIXTURES, src), "utf8")}`);
    chmodSync(join(tts, name), 0o755);
  }
  const model = randomBytes(64);
  writeFileSync(join(tts, "model.onnx"), model);
  const sock = join(root, `${tag}.sock`);
  sidecar?.kill();
  sidecar = spawn(
    py,
    [
      "-I",
      SIDECAR,
      "--socket",
      sock,
      "--work-dir",
      join(root, `work-${tag}`),
      "--piper",
      join(tts, "piper"),
      "--piper-model",
      join(tts, "model.onnx"),
      "--piper-model-sha256",
      createHash("sha256").update(model).digest("hex"),
      "--player",
      join(tts, "player"),
      "--device-mute",
      "absent",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  sidecar.stderr?.on("data", (b: Buffer) => {
    sidecarLog += b.toString();
  });
  const until = Date.now() + 10_000;
  while (!sidecarLog.includes("listening")) {
    if (Date.now() > until) throw new Error("the sidecar never listened");
    await new Promise((r) => setTimeout(r, 20));
  }
  return sock;
}

/** An agent ON DISK: bob.yaml declares flair (the audit store) and reachy. */
function agentOnDisk(name: string, roomSpeechOrigins: string[], sock: string): string {
  const agentsRoot = join(root, `agents-${name}`);
  const { agentDir } = initAgent({
    name,
    role: "custom",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    contextWindow: 200_000,
    agentsRoot,
    flairKeysDir: join(root, "keys"),
    skipFlair: true,
  });
  const keyFile = join(root, `${name}.key`);
  const { privateKey } = generateKeyPairSync("ed25519");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  chmodSync(keyFile, 0o600);
  const yaml = readFileSync(join(agentDir, "bob.yaml"), "utf8");
  writeFileSync(
    join(agentDir, "bob.yaml"),
    [
      yaml.replace(/^capabilities:.*$/m, "capabilities:\n  - flair\n  - reachy"),
      "flair:",
      `  url: ${flairUrl}`,
      `  agentId: ${name}`,
      `  keyFile: ${keyFile}`,
      "",
      "voice:",
      "  wakeName: jarvis",
      "",
      "reachy:",
      `  socket: ${sock}`,
      `  sidecarVersion: ${SIDECAR_VERSION}`,
      `  roomSpeechOrigins: [${roomSpeechOrigins.join(", ")}]`,
      "",
    ].join("\n"),
  );
  return agentsRoot;
}

const configured = () => sidecarLog.match(/ configured /g)?.length ?? 0;

/** A model that calls `reachy_say` once per prompt, then ends the turn. It
 *  waits until THIS session's link was configured by the sidecar (the count
 *  passed `baseline`), so the link is ready when the tool runs. */
function sayingModel(text: string, baseline: number) {
  let calls = 0;
  return (model: Model<string>): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    calls += 1;
    const callTool = calls % 2 === 1;
    void (async () => {
      const until = Date.now() + 10_000;
      while (configured() <= baseline && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await new Promise((r) => setTimeout(r, 100)); // the health line reaches bob
      const usage = {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
      const content = callTool
        ? [
            {
              type: "toolCall" as const,
              id: `call-${calls}`,
              name: "reachy_say",
              arguments: { text },
            },
          ]
        : [{ type: "text" as const, text: "done" }];
      const message = {
        role: "assistant" as const,
        content,
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: (callTool ? "toolUse" : "stop") as "toolUse" | "stop",
        timestamp: Date.now(),
      };
      stream.push({ type: "start", partial: { ...message, content: [] } as never });
      stream.push({ type: "done", reason: message.stopReason, message: message as never });
      stream.end(message as never);
    })();
    return stream;
  };
}

/** bob's REAL session factory over the config bob resolved from bob.yaml —
 *  extension sources, capability env and runtime services untouched — with
 *  the scripted model. Records the session's effective and registered tools. */
function realFactory(
  text: string,
  seen: { active?: string[]; registered?: string[] },
): RunSessionFactory {
  return async (config: RunSessionConfig): Promise<RunSession> => {
    const baseline = configured();
    const runtime = await ModelRuntime.create({ modelsPath: null });
    runtime.registerProvider(STUB_PROVIDER, {
      name: "Bob Stub",
      apiKey: "stub-key",
      api: "bob-stub-api",
      baseUrl: "http://localhost:0",
      streamSimple: sayingModel(text, baseline),
      models: [
        {
          id: STUB_MODEL,
          name: "Stub",
          api: "bob-stub-api",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 4096,
        },
      ],
    });
    const factory = createBobRuntimeFactory({
      config: {
        ...config,
        provider: STUB_PROVIDER,
        providerRecord: undefined,
        model: STUB_MODEL,
        modelLimits: { provider: STUB_PROVIDER, model: STUB_MODEL, contextWindow: 200_000 },
      },
      policy: {
        tools: ["reachy_say", "reachy_state"],
        excludeTools: [],
        resident: false,
        allowResidentShell: false,
      },
      deps: { log: () => {}, exit: () => {} },
      modelRuntime: runtime,
    });
    const { session } = await factory({
      cwd: config.cwd,
      agentDir: config.piAgentDir,
      sessionManager: SessionManager.inMemory(config.cwd) as never,
    });
    const s = session as unknown as {
      getActiveToolNames(): string[];
      getAllTools(): Array<{ name: string }>;
    };
    seen.active = s.getActiveToolNames();
    seen.registered = s.getAllTools().map((t) => t.name);
    return session as unknown as RunSession;
  };
}

const spoken = () => sidecarLog.match(/say\.spoken/g)?.length ?? 0;
/** Playback completes after the tool returns: wait for the count to reach `n`. */
async function spokenReaches(n: number): Promise<void> {
  const until = Date.now() + 10_000;
  while (spoken() < n) {
    if (Date.now() > until) throw new Error(`the sidecar spoke ${spoken()} time(s), not ${n}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("bob#356 round 1 — the speech origin through the REAL session path", () => {
  it("one-shot `bob run`: the runtime-declared `run` origin speaks under a `run` grant; the voice registry has no body tool", async () => {
    expect(existsSync(BUILT), "the reachy extension must be built (bun run build)").toBe(true);
    const agentsRoot = agentOnDisk("voicerun", ["run"], await startSidecar("run"));
    const seen: { active?: string[]; registered?: string[] } = {};
    const before = spoken();
    audits.length = 0;
    await runAgent({
      name: "voicerun",
      prompt: "say hello",
      agentsRoot,
      sessionFactory: realFactory("Hello from a one-shot run.", seen),
    });
    await spokenReaches(before + 1);
    expect(audits.some((a) => a.kind === "reachy.say")).toBe(true);
    expect(must(seen.active, "active tools").sort()).toEqual(["reachy_say", "reachy_state"]);
    expect(seen.registered).toContain("reachy_say");
    expect(seen.registered).not.toContain("reachy_look");
    expect(seen.registered).not.toContain("reachy_frame");
  }, 60_000);

  it("persistent: a prompt OUTSIDE every admission is bound to nothing and refused, even with `run` granted; an admitted cron turn speaks", async () => {
    const agentsRoot = agentOnDisk(
      "voicepersist",
      ["run", "cron:speak"],
      await startSidecar("persist"),
    );
    const seen: { active?: string[]; registered?: string[] } = {};
    const handle = await startPersistent({
      name: "voicepersist",
      agentsRoot,
      installSignalHandlers: false,
      keepAlive: async () => {},
      sessionFactory: realFactory("Standup in five minutes.", seen),
    });
    try {
      const before = spoken();
      audits.length = 0;
      await handle.session.prompt("speak", { expandPromptTemplates: false });
      const refusal = audits.find((a) => a.kind === "reachy.refused");
      expect(must(refusal, "the refusal").summary).toContain(
        "bound to no admitted turn and no runtime-declared run",
      );
      expect(audits.some((a) => a.kind === "reachy.say")).toBe(false);
      await new Promise((r) => setTimeout(r, 500));
      expect(spoken()).toBe(before); // nothing was sent, so nothing plays

      await handle.admitTurn({ kind: "cron", job: "speak" }, "speak");
      await spokenReaches(before + 1);
      expect(audits.some((a) => a.kind === "reachy.say")).toBe(true);
      expect(must(seen.active, "active tools").sort()).toEqual(["reachy_say", "reachy_state"]);
    } finally {
      await handle.shutdown();
    }
  }, 60_000);
});
