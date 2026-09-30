import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wireDiscordCapability } from "../../src/capabilities/discord/capability.js";
import { wirePresence } from "../../src/capabilities/presence/capability.js";
import type { CronSchedulerDeps } from "../../src/shell/cron.js";
import type { DiscordMessage } from "../../src/shell/discord-types.js";
import { startPersistent } from "../../src/shell/persistent.js";
import { isolatedLoaderOptions } from "../../src/shell/session.js";
import { type createTurnAdmission, getTurnAdmission } from "../../src/shell/turn-admission.js";
import type { TurnOrigin } from "../../src/shell/turn-origin.js";

type ProbeEvent = { type: string; prompt?: string; messages?: unknown[] };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const checkpoint = () => new Promise<void>((resolve) => setImmediate(resolve));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

// Real runtime, cron fire callback, Discord inbound core and presence hooks.
// Only pi's model/session, Discord transport and Flair transport are fakes.
async function harness() {
  const root = mkdtempSync(join(tmpdir(), "bob-admission-"));
  // Register the directory's removal up front (afterEach drains `cleanups`),
  // BEFORE the setup below, which can throw — otherwise a failed start leaked
  // the directory, since the combined cleanup is only registered afterwards.
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "pulse", "work"), { recursive: true });
  mkdirSync(join(root, "pulse", ".pi-agent"));
  writeFileSync(
    join(root, "pulse", "bob.yaml"),
    [
      "agent:",
      "  name: pulse",
      "  role: coder",
      "provider:",
      "  name: anthropic",
      "  model: fake",
      "tools:",
      "  allow:",
      "    - read",
      "cron:",
      "  - name: brief",
      '    schedule: "* * * * *"',
      "    prompt: cron-secret",
    ].join("\n"),
  );
  const handlers = new Map<string, Array<(event: ProbeEvent) => unknown>>();
  const listeners: Array<(event: ProbeEvent) => void> = [];
  const phases = new Map<string, ReturnType<typeof phase>>();
  function phase() {
    return { started: deferred(), before: deferred(), finish: deferred(), ended: deferred() };
  }
  function turn(text: string) {
    let value = phases.get(text);
    if (!value) {
      value = phase();
      phases.set(text, value);
    }
    return value;
  }
  const starts: string[] = [];
  const ends: string[] = [];
  const origins: Array<{ text: string; origin: TurnOrigin }> = [];
  // The origin read at each agent_end, INSIDE the prompt: the admitted origin
  // must still be current there (agent_end fires mid-prompt).
  const postEndOrigins: Array<{ text: string; origin: TurnOrigin }> = [];
  const summaries: Array<{ origin: TurnOrigin }> = [];
  const beats: unknown[] = [];
  const replies: Array<{ channel: string; text: string; replyTo?: string }> = [];
  let inbound!: (msg: DiscordMessage) => void;
  let scheduler!: CronSchedulerDeps;
  let admission!: ReturnType<typeof createTurnAdmission>;
  let idle: () => Promise<void> = async () => {};
  let disposed = false;
  const emit = async (type: string, data = {}) => {
    const event = { type, ...data };
    for (const handler of handlers.get(type) ?? []) await handler(event);
    for (const listener of listeners) listener(event);
  };
  const session = {
    subscribe(listener: (event: ProbeEvent) => void) {
      listeners.push(listener);
      return () => {};
    },
    waitForIdle: () => idle(),
    async prompt(text: string, options?: unknown) {
      expect(options).toEqual({ expandPromptTemplates: false });
      expect(disposed).toBe(false);
      const p = turn(text);
      starts.push(text);
      p.started.resolve();
      await p.before.promise;
      origins.push({ text, origin: admission.readOrigin() });
      await emit("before_agent_start", { prompt: text });
      await emit("agent_start");
      await p.finish.promise;
      await emit("agent_end", {
        messages: [
          {
            role: "assistant",
            content: [
              { type: "text", text: `${text}-model-secret` },
              { type: "toolCall", name: "read", arguments: { secret: "tool-input-secret" } },
            ],
          },
          { role: "toolResult", content: "tool-output-secret" },
        ],
      });
      postEndOrigins.push({ text, origin: admission.readOrigin() });
      ends.push(text);
      p.ended.resolve();
    },
    dispose() {
      disposed = true;
    },
  };
  const handle = await startPersistent({
    name: "pulse",
    agentsRoot: root,
    log: () => {},
    cronSchedulerFactory(deps) {
      scheduler = deps;
      return { stop() {} };
    },
    sessionFactory: async (config) => {
      admission = config.turnAdmission as typeof admission;
      const events = isolatedLoaderOptions(config).eventBus;
      if (!events) throw new Error("missing admission event bus");
      const service = getTurnAdmission({ events });
      expect(service).toBe(admission);
      if (!service) throw new Error("missing admission service");
      const pi = {
        on(type: string, handler: (event: ProbeEvent) => unknown) {
          handlers.set(type, [...(handlers.get(type) ?? []), handler]);
        },
        registerTool() {},
        getAllTools: () => [{ name: "read" }],
      };
      wirePresence({
        pi,
        admission: service,
        config: { url: "http://unused", agentId: "pulse", keyFile: "/unused" },
        flair: {
          async presenceBeat(beat) {
            beats.push(beat);
          },
          async write(content) {
            summaries.push(JSON.parse(content));
            return { id: "summary" };
          },
        },
        scheduleBeacon: () => ({ stop() {}, tick() {} }),
      });
      const discord = wireDiscordCapability({
        pi,
        admitTurn: service.admitTurn,
        config: { tokenFile: "/unused", channelIds: ["123", "456"], dispatchAll: true },
        client: {
          on(_type, handler) {
            inbound = handler;
          },
          async connect() {},
          async disconnect() {},
          async reply(channel, text, options) {
            replies.push({ channel, text, replyTo: options?.replyTo });
          },
          async react() {},
          async fetchRecent() {
            return [];
          },
          async fetchMessage() {
            return null;
          },
          async sendTyping() {},
        },
        log: () => {},
      });
      cleanups.push(() => discord.stop());
      return session;
    },
  });
  cleanups.push(async () => {
    for (const p of phases.values()) {
      p.before.resolve();
      p.finish.resolve();
    }
    await handle.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    handle,
    admission,
    session,
    turn,
    starts,
    ends,
    origins,
    postEndOrigins,
    summaries,
    beats,
    replies,
    setIdle: (fn: () => Promise<void>) => {
      idle = fn;
    },
    fireCron: () => scheduler.fire(scheduler.entries[0]),
    discord: (text: string, channelId = "123", id = "msg") =>
      inbound({
        content: text,
        channelId,
        id,
        authorId: "user",
        authorName: "user",
        mentionsBot: true,
      }),
  };
}

describe("round 5 interleavings", () => {
  it("(a) Discord paused before before_agent_start retains its origin while cron is admitted", async () => {
    const h = await harness();
    h.discord("discord-secret");
    await h.turn("discord-secret").started.promise;
    const cron = h.fireCron();
    await checkpoint(); // the cron admission has had a chance to reach its own preflight
    h.turn("discord-secret").before.resolve();
    h.turn("discord-secret").finish.resolve();
    await h.turn("discord-secret").ended.promise;
    h.turn("cron-secret").before.resolve();
    h.turn("cron-secret").finish.resolve();
    await cron;
    expect(h.origins).toEqual([
      { text: "discord-secret", origin: { kind: "discord", channelId: "123" } },
      { text: "cron-secret", origin: { kind: "cron", job: "brief" } },
    ]);
    expect(h.summaries.map((s) => s.origin)).toEqual(h.origins.map((o) => o.origin));
    // agent_end fires INSIDE the prompt: the admitted origin must still be
    // current there (it is cleared only when the prompt settles, not on
    // agent_end), or a per-call readOrigin() would revert the discord tools to
    // allowlist reach mid-turn (bob#227).
    expect(h.postEndOrigins).toEqual([
      { text: "discord-secret", origin: { kind: "discord", channelId: "123" } },
      { text: "cron-secret", origin: { kind: "cron", job: "brief" } },
    ]);
    expect(h.replies).toEqual([
      { channel: "123", text: "discord-secret-model-secret", replyTo: "msg" },
    ]);
    const telemetry = JSON.stringify([h.beats, h.summaries]);
    for (const secret of [
      "discord-secret",
      "cron-secret",
      "model-secret",
      "tool-input-secret",
      "tool-output-secret",
    ]) {
      expect(telemetry).not.toContain(secret);
    }
  });

  it("(b) a cron fire released during shutdown sets no origin and starts no turn", async () => {
    const h = await harness();
    h.turn("cron-secret").before.resolve();
    h.turn("cron-secret").finish.resolve();
    const insideIdle = deferred();
    const release = deferred();
    h.setIdle(async () => {
      insideIdle.resolve();
      await release.promise;
    });
    const cron = h.fireCron();
    const outcome = cron.then(
      () => "started",
      () => "closed",
    );
    await insideIdle.promise;
    const shutdown = h.handle.shutdown();
    release.resolve();
    expect(await outcome).toBe("closed");
    await shutdown;
    expect(h.starts).toEqual([]);
    expect(h.origins).toEqual([]);
    expect(h.admission.readOrigin()).toEqual({ kind: "run" });
    expect(h.beats).toEqual([]);
    expect(h.summaries).toEqual([]);
  });

  it("(c) back-to-back admissions run strictly in FIFO order without interleaving", async () => {
    const h = await harness();
    const first = h.handle.admitTurn({ kind: "mail", from: "flint" }, "first");
    const second = h.handle.admitTurn({ kind: "cron", job: "second" }, "second");
    await h.turn("first").started.promise;
    h.turn("first").before.resolve();
    await checkpoint();
    expect(h.starts).toEqual(["first"]);
    expect(h.ends).toEqual([]);
    h.turn("first").finish.resolve();
    await first;
    await h.turn("second").started.promise;
    expect(h.ends).toEqual(["first"]);
    h.turn("second").before.resolve();
    h.turn("second").finish.resolve();
    await second;
    expect(h.starts).toEqual(["first", "second"]);
    expect(h.ends).toEqual(["first", "second"]);
  });

  it("shutdown drains an already started turn without erasing its origin", async () => {
    const h = await harness();
    const first = h.handle.admitTurn({ kind: "cron", job: "started" }, "started");
    await h.turn("started").started.promise;
    const shutdown = h.handle.shutdown();
    h.turn("started").before.resolve();
    h.turn("started").finish.resolve();
    await first;
    await shutdown;
    expect(h.origins).toEqual([{ text: "started", origin: { kind: "cron", job: "started" } }]);
    expect(h.summaries.map((s) => s.origin)).toEqual([{ kind: "cron", job: "started" }]);
  });

  it("a bare prompt outside admission reads run while an admitted preflight is paused", async () => {
    const h = await harness();
    const admitted = h.handle.admitTurn({ kind: "cron", job: "brief" }, "owned");
    await h.turn("owned").started.promise;
    h.turn("bare").before.resolve();
    h.turn("bare").finish.resolve();
    await h.session.prompt("bare", { expandPromptTemplates: false });
    h.turn("owned").before.resolve();
    h.turn("owned").finish.resolve();
    await admitted;
    expect(h.origins).toEqual([
      { text: "bare", origin: { kind: "run" } },
      { text: "owned", origin: { kind: "cron", job: "brief" } },
    ]);
  });
});
