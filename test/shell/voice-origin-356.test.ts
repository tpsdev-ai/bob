// bob#356 V1 — the shell side of the voice slice:
//   * the `voice` turn origin lands in the union, validation, projection and
//     label together — and is NOT admitted yet (D1/D2 are V2);
//   * `voice.wakeName` is the sole, bob-owned source of the wake name, projected
//     into the reachy config; a `reachy:` block cannot set its own;
//   * an allowlist naming a tool the configured profile does not register is
//     refused by name before any session.
import { describe, expect, it } from "bun:test";
import { reachyManifest } from "../../src/capabilities/reachy/manifest.js";
import { lookupCapability } from "../../src/shell/capability-catalog.js";
import {
  assertConditionalTools,
  capabilityConfigEnv,
  conditionalToolRefusals,
  configuredCapabilityTools,
  readVoiceWakeName,
  resolveCapabilities,
} from "../../src/shell/capability-loader.js";
import { REASONING_CONTINUE_TURN } from "../../src/shell/compaction-contract.js";
import { ToolLoopError } from "../../src/shell/tool-loop.js";
import {
  boundOrigin,
  createTurnAdmission,
  getSessionOrigin,
  getTurnAdmission,
  getVoiceSpeech,
  runtimeEventBus,
} from "../../src/shell/turn-admission.js";
import {
  approvedOrigin,
  isValidOrigin,
  originLabel,
  type TurnOrigin,
} from "../../src/shell/turn-origin.js";

const voice = (over: Record<string, unknown> = {}) =>
  ({
    kind: "voice",
    speakerVerified: false,
    utteranceId: "utt_1",
    correlationId: "corr_1",
    ...over,
  }) as TurnOrigin;

describe("bob#356 — the voice turn origin", () => {
  it("validates, projects (dropping extra fields) and labels without content", () => {
    expect(isValidOrigin(voice())).toBe(true);
    const projected = approvedOrigin({
      ...voice(),
      text: "jarvis, the secret is 42",
    } as TurnOrigin);
    expect(projected).toEqual(voice());
    expect(JSON.stringify(projected)).not.toContain("secret");
    expect(originLabel(voice())).toBe("voice (unverified speaker)");
    expect(originLabel(voice({ speakerVerified: true }))).toBe("voice (verified speaker)");
  });

  it.each([
    [{ speakerVerified: "yes" }, "voice.speakerVerified must be a boolean"],
    [{ utteranceId: "" }, "voice.utteranceId must not be empty"],
    [{ utteranceId: "a b" }, "voice.utteranceId contains invalid characters"],
    [{ utteranceId: "u".repeat(65) }, "voice.utteranceId exceeds 64 characters"],
    [{ correlationId: "c/1" }, "voice.correlationId contains invalid characters"],
  ])("refuses malformed voice metadata %j", (over, reason) => {
    expect(isValidOrigin(voice(over))).toBe(false);
    expect(() => approvedOrigin(voice(over))).toThrow(reason);
  });

  it("is admitted in V2a: the projected origin reaches the prompt and the FIFO stays intact", async () => {
    const prompts: string[] = [];
    const origins: Array<TurnOrigin | undefined> = [];
    const residentPrompts: string[] = [];
    const admission = createTurnAdmission({
      // A voice turn runs in a FRESH session; the resident one must not receive it.
      voiceSession: async () => ({
        subscribe: () => () => {},
        dispose() {},
        async prompt(text: string) {
          prompts.push(text);
          origins.push(admission.readAdmittedOrigin());
        },
      }),
    });
    admission.bind({
      subscribe: () => () => {},
      dispose() {},
      async prompt(text: string) {
        residentPrompts.push(text);
      },
    });
    await admission.admitTurn(voice(), "jarvis, read my mail");
    expect(prompts).toEqual(["jarvis, read my mail"]);
    expect(origins).toEqual([voice()]);
    await admission.admitTurn({ kind: "run" }, "next");
    expect(prompts).toEqual(["jarvis, read my mail"]);
    expect(residentPrompts).toEqual(["next"]);
  });
});

describe("bob#356 V2a — an admission with no voice session refuses a voice turn", () => {
  it("rejects it by name, and the resident session is not prompted", async () => {
    const residentPrompts: string[] = [];
    const admission = createTurnAdmission({ log: () => {} });
    admission.bind({
      subscribe: () => () => {},
      dispose() {},
      async prompt(text: string) {
        residentPrompts.push(text);
      },
    });
    await expect(admission.admitTurn(voice(), "jarvis, hi")).rejects.toThrow(
      /needs a fresh voice session/,
    );
    expect(residentPrompts).toEqual([]);
    // CONTROL: the same resident session serves a non-voice turn.
    await admission.admitTurn({ kind: "run" }, "next");
    expect(residentPrompts).toEqual(["next"]);
  });
});

// A scripted session: `prompt` runs `onPrompt` with an `emit` that calls each
// subscriber synchronously, so an event is emitted under the caller's
// AsyncLocalStorage store (inside a turn's prompt, or outside a turn).
function scriptedSession(
  onPrompt: (text: string, emit: (event: unknown) => void) => Promise<void>,
) {
  const listeners: Array<(event: never) => void> = [];
  const emit = (event: unknown) => {
    for (const l of listeners) l(event as never);
  };
  const calls = { prompts: [] as string[], aborts: 0, disposals: 0 };
  return {
    calls,
    emit,
    session: {
      subscribe(l: (event: never) => void) {
        listeners.push(l);
        return () => {
          const i = listeners.indexOf(l);
          if (i >= 0) listeners.splice(i, 1);
        };
      },
      dispose() {
        calls.disposals += 1;
      },
      async abort() {
        calls.aborts += 1;
      },
      async prompt(text: string) {
        calls.prompts.push(text);
        await onPrompt(text, emit);
      },
    },
  };
}
const ending = (content: unknown) => ({
  type: "message_end",
  message: { role: "assistant", content, stopReason: "stop" },
});
const TEXT = [{ type: "text", text: "It is noon." }];
const REASONING_ONLY = [{ type: "thinking", thinking: "the clock says noon" }];
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("bob#356 V2a — another session's events do not set the active voice turn's ending", () => {
  it("a reasoning-only ending emitted outside the turn does not re-prompt a voice turn that ended in text", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const voiceSide = scriptedSession(async (_text, emit) => {
      emit(ending(TEXT));
      await held;
    });
    const resident = scriptedSession(async () => {});
    const admission = createTurnAdmission({
      log: () => {},
      voiceSession: async () => voiceSide.session,
    });
    admission.bind(resident.session);
    const turn = admission.admitTurn(voice(), "jarvis, what time is it");
    while (voiceSide.calls.prompts.length === 0) await tick();
    resident.emit(ending(REASONING_ONLY)); // emitted outside every turn
    release();
    await turn;
    expect(voiceSide.calls.prompts).toEqual(["jarvis, what time is it"]);
  });

  it("a text ending emitted outside the turn does not cancel a voice turn's reasoning-only re-prompt", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const voiceSide = scriptedSession(async (text, emit) => {
      if (text === REASONING_CONTINUE_TURN) {
        emit(ending(TEXT));
        return;
      }
      emit(ending(REASONING_ONLY));
      await held;
    });
    const resident = scriptedSession(async () => {});
    const admission = createTurnAdmission({
      log: () => {},
      voiceSession: async () => voiceSide.session,
    });
    admission.bind(resident.session);
    const turn = admission.admitTurn(voice(), "jarvis, what time is it");
    while (voiceSide.calls.prompts.length === 0) await tick();
    resident.emit(ending(TEXT)); // emitted outside every turn
    release();
    await turn;
    expect(voiceSide.calls.prompts).toEqual(["jarvis, what time is it", REASONING_CONTINUE_TURN]);
  });
});

describe("bob#356 V2a — another session's tool calls and turn ends do not count for the active voice turn", () => {
  it("two tool calls emitted outside the turn do not trip its loop breaker", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const voiceSide = scriptedSession(async (_text, emit) => {
      emit(ending(TEXT));
      await held;
    });
    const resident = scriptedSession(async () => {});
    const admission = createTurnAdmission({
      log: () => {},
      toolLoopLimit: 2,
      voiceSession: async () => voiceSide.session,
    });
    admission.bind(resident.session);
    const turn = admission.admitTurn(voice(), "jarvis, what time is it");
    while (voiceSide.calls.prompts.length === 0) await tick();
    for (let i = 0; i < 2; i++) {
      resident.emit({ type: "tool_execution_start", toolName: "reachy_say", args: { text: "x" } });
    }
    release();
    await turn; // resolves: no ToolLoopError
    expect(voiceSide.calls.aborts).toBe(0);
    expect(resident.calls.aborts).toBe(0);
  });

  it("a turn end emitted outside the turn does not replace the turn's messages", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const own = { role: "assistant", content: TEXT, stopReason: "stop" };
    const voiceSide = scriptedSession(async (_text, emit) => {
      emit({ type: "agent_end", messages: [own] });
      await held;
    });
    const resident = scriptedSession(async () => {});
    const admission = createTurnAdmission({
      log: () => {},
      voiceSession: async () => voiceSide.session,
    });
    admission.bind(resident.session);
    const turn = admission.admitTurn(voice(), "jarvis, what time is it");
    while (voiceSide.calls.prompts.length === 0) await tick();
    resident.emit({
      type: "agent_end",
      messages: [
        { role: "assistant", content: [{ type: "text", text: "foreign" }], stopReason: "stop" },
      ],
    });
    release();
    expect(await turn).toEqual([own]);
  });
});

describe("bob#356 V2a — the resident session's events inside a voice turn do not count for it", () => {
  // The resident session emits from INSIDE the voice prompt's async context:
  // the emitting session is what tells these events apart from the turn's own.
  it("two resident tool calls emitted inside the voice prompt do not trip its loop breaker", async () => {
    const holder: { resident?: ReturnType<typeof scriptedSession> } = {};
    const voiceSide = scriptedSession(async (_text, emit) => {
      emit(ending(TEXT));
      for (let i = 0; i < 2; i++) {
        holder.resident?.emit({
          type: "tool_execution_start",
          toolName: "reachy_say",
          args: { text: "x" },
        });
      }
    });
    holder.resident = scriptedSession(async () => {});
    const admission = createTurnAdmission({
      log: () => {},
      toolLoopLimit: 2,
      voiceSession: async () => voiceSide.session,
    });
    admission.bind(holder.resident.session);
    await admission.admitTurn(voice(), "jarvis, what time is it"); // no ToolLoopError
    expect(voiceSide.calls.aborts).toBe(0);
  });

  it("a resident turn end emitted inside the voice prompt does not replace the turn's messages", async () => {
    const holder: { resident?: ReturnType<typeof scriptedSession> } = {};
    const own = { role: "assistant", content: TEXT, stopReason: "stop" };
    const voiceSide = scriptedSession(async (_text, emit) => {
      emit({ type: "agent_end", messages: [own] });
      holder.resident?.emit({
        type: "agent_end",
        messages: [
          { role: "assistant", content: [{ type: "text", text: "foreign" }], stopReason: "stop" },
        ],
      });
    });
    holder.resident = scriptedSession(async () => {});
    const admission = createTurnAdmission({
      log: () => {},
      voiceSession: async () => voiceSide.session,
    });
    admission.bind(holder.resident.session);
    expect(await admission.admitTurn(voice(), "jarvis, what time is it")).toEqual([own]);
  });
});

describe("bob#356 V2a — the fresh voice session is disposed when its startup fails", () => {
  const unsubscribeFails = (side: ReturnType<typeof scriptedSession>) => {
    const subscribe = side.session.subscribe.bind(side.session);
    side.session.subscribe = (l: (event: never) => void) => {
      subscribe(l);
      return () => {
        throw new Error("unsubscribe failed");
      };
    };
    return side;
  };

  it("an unsubscribe that throws still disposes the session: on a pre-start refusal", async () => {
    const voiceSide = unsubscribeFails(scriptedSession(async () => {}));
    const admission = createTurnAdmission({
      log: () => {},
      voiceSession: async () => voiceSide.session,
    });
    admission.bind(scriptedSession(async () => {}).session);
    await expect(
      admission.admitTurn(voice(), "jarvis, hi", { beforeStart: () => "refused here" }),
    ).rejects.toThrow("refused here");
    expect(voiceSide.calls.disposals).toBe(1);
  });

  it("an unsubscribe that throws still disposes the session: after its prompt settles", async () => {
    const voiceSide = unsubscribeFails(scriptedSession(async (_t, emit) => emit(ending(TEXT))));
    const admission = createTurnAdmission({
      log: () => {},
      voiceSession: async () => voiceSide.session,
    });
    admission.bind(scriptedSession(async () => {}).session);
    await admission.admitTurn(voice(), "jarvis, hi");
    expect(voiceSide.calls.disposals).toBe(1);
  });

  it("a subscribe, a beforeStart or an onTurnStart that throws disposes the session", async () => {
    // subscribe throws
    const a = scriptedSession(async () => {});
    a.session.subscribe = () => {
      throw new Error("subscribe failed");
    };
    const admissionA = createTurnAdmission({ log: () => {}, voiceSession: async () => a.session });
    admissionA.bind(scriptedSession(async () => {}).session);
    await expect(admissionA.admitTurn(voice(), "jarvis, hi")).rejects.toThrow("subscribe failed");
    expect(a.calls.disposals).toBe(1);
    // beforeStart throws
    const b = scriptedSession(async () => {});
    const admissionB = createTurnAdmission({ log: () => {}, voiceSession: async () => b.session });
    admissionB.bind(scriptedSession(async () => {}).session);
    await expect(
      admissionB.admitTurn(voice(), "jarvis, hi", {
        beforeStart: () => {
          throw new Error("beforeStart failed");
        },
      }),
    ).rejects.toThrow("beforeStart failed");
    expect(b.calls.disposals).toBe(1);
    // onTurnStart throws
    const c = scriptedSession(async () => {});
    const admissionC = createTurnAdmission({
      log: () => {},
      voiceSession: async () => c.session,
      onTurnStart: () => {
        throw new Error("onTurnStart failed");
      },
    });
    admissionC.bind(scriptedSession(async () => {}).session);
    await expect(admissionC.admitTurn(voice(), "jarvis, hi")).rejects.toThrow("onTurnStart failed");
    expect(c.calls.disposals).toBe(1);
    expect([a, b, c].map((side) => side.calls.prompts.length)).toEqual([0, 0, 0]);
  });

  it("a beforeStart that closes the admission stops the turn before its prompt", async () => {
    const voiceSide = scriptedSession(async () => {});
    let admission!: ReturnType<typeof createTurnAdmission>;
    admission = createTurnAdmission({ log: () => {}, voiceSession: async () => voiceSide.session });
    admission.bind(scriptedSession(async () => {}).session);
    await expect(
      admission.admitTurn(voice(), "jarvis, hi", {
        beforeStart: () => {
          admission.close();
          return null;
        },
      }),
    ).rejects.toThrow("turn admission is closed");
    expect(voiceSide.calls.prompts).toEqual([]);
    expect(voiceSide.calls.disposals).toBe(1);
  });
});

describe("bob#356 V2a — each turn's reasoning-only check reads its own ending", () => {
  it("a loop-broken voice prompt that settles late does not take the next turn's ending", async () => {
    let releaseVoice!: () => void;
    const voiceHeld = new Promise<void>((r) => {
      releaseVoice = r;
    });
    let releaseResident!: () => void;
    const residentHeld = new Promise<void>((r) => {
      releaseResident = r;
    });
    const voiceSide = scriptedSession(async (text, emit) => {
      if (text === REASONING_CONTINUE_TURN) return;
      for (let i = 0; i < 3; i++) {
        emit({ type: "tool_execution_start", toolName: "reachy_say", args: { text: "again" } });
      }
      await voiceHeld;
    });
    const resident = scriptedSession(async (text, emit) => {
      if (text === REASONING_CONTINUE_TURN) {
        emit(ending(TEXT));
        return;
      }
      emit(ending(REASONING_ONLY));
      await residentHeld;
    });
    const admission = createTurnAdmission({
      log: () => {},
      toolLoopLimit: 2,
      loopAbortGraceMs: 10,
      voiceSession: async () => voiceSide.session,
    });
    admission.bind(resident.session);
    await expect(admission.admitTurn(voice(), "jarvis, again")).rejects.toBeInstanceOf(
      ToolLoopError,
    );
    // The next turn starts while the voice prompt is still running, and its
    // prompt records a reasoning-only ending.
    const cronTurn = admission.admitTurn({ kind: "cron", job: "digest" }, "digest");
    while (resident.calls.prompts.length === 0) await tick();
    releaseVoice(); // the voice continuation reads its own (empty) ending
    while (voiceSide.calls.disposals === 0) await tick();
    releaseResident();
    await cronTurn;
    expect(voiceSide.calls.prompts).toEqual(["jarvis, again"]);
    expect(resident.calls.prompts).toEqual(["digest", REASONING_CONTINUE_TURN]);
  });
});

describe("bob#356 V2a — a loop-broken voice turn", () => {
  it("stops the voice session, keeps its binding and session until the prompt settles, then disposes it", async () => {
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    let admission!: ReturnType<typeof createTurnAdmission>;
    const originsInPrompt: Array<TurnOrigin | undefined> = [];
    const voiceSide = scriptedSession(async (_text, emit) => {
      for (let i = 0; i < 4; i++) {
        emit({ type: "tool_execution_start", toolName: "reachy_say", args: { text: "again" } });
      }
      await held; // the prompt keeps running past the loop break
      originsInPrompt.push(admission.readAdmittedOrigin());
    });
    const resident = scriptedSession(async () => {});
    admission = createTurnAdmission({
      log: () => {},
      toolLoopLimit: 3,
      loopAbortGraceMs: 20,
      voiceSession: async () => voiceSide.session,
    });
    admission.bind(resident.session);
    await expect(admission.admitTurn(voice(), "jarvis, say it again")).rejects.toBeInstanceOf(
      ToolLoopError,
    );
    await tick();
    // The stop went to the voice session, not the resident one.
    expect(voiceSide.calls.aborts).toBe(1);
    expect(resident.calls.aborts).toBe(0);
    // The prompt has not settled: the session is not disposed yet.
    expect(voiceSide.calls.disposals).toBe(0);
    release();
    while (voiceSide.calls.disposals === 0) await tick();
    // Inside the prompt, after the break, the call was still bound to the turn.
    expect(originsInPrompt).toEqual([voice()]);
    expect(voiceSide.calls.disposals).toBe(1);
    expect(admission.readAdmittedOrigin()).toBeUndefined();
  });
});

describe("bob#356 round 1 — the origin a tool call is BOUND to, never defaulted", () => {
  it("readAdmittedOrigin: the admitted turn's origin inside it; undefined outside and after it settled", async () => {
    const admission = createTurnAdmission();
    const seen: Array<TurnOrigin | undefined> = [];
    const late: Array<TurnOrigin | undefined> = [];
    admission.bind({
      subscribe: () => () => {},
      dispose() {},
      async prompt() {
        seen.push(admission.readAdmittedOrigin());
        // a continuation of the turn that runs AFTER its prompt settled
        setTimeout(() => late.push(admission.readAdmittedOrigin()), 30);
      },
    });
    expect(admission.readAdmittedOrigin()).toBeUndefined();
    expect(admission.readOrigin()).toEqual({ kind: "run" }); // the defaulting reader, unchanged
    await admission.admitTurn({ kind: "cron", job: "standup" }, "go");
    expect(seen).toEqual([{ kind: "cron", job: "standup" }]);
    expect(admission.readAdmittedOrigin()).toBeUndefined();
    await new Promise((r) => setTimeout(r, 60));
    expect(late).toEqual([undefined]); // the settled turn binds nothing any more
  });

  it("the runtime bus carries the admission and/or the declared session origin; nothing when neither", () => {
    const admission = createTurnAdmission();
    const both = { events: runtimeEventBus({ admission, sessionOrigin: { kind: "run" } }) };
    expect(getTurnAdmission(both)).toBe(admission);
    expect(getSessionOrigin(both)).toEqual({ kind: "run" });
    const runOnly = { events: runtimeEventBus({ sessionOrigin: { kind: "run" } }) };
    expect(getTurnAdmission(runOnly)).toBeUndefined();
    const none = { events: runtimeEventBus({}) };
    expect(getSessionOrigin(none)).toBeUndefined();
    // the fresh voice session's speech bridge travels the same way
    const speak = async () => ({ kind: "admitted", action: "say" });
    expect(getVoiceSpeech({ events: runtimeEventBus({ voiceSpeech: speak }) })).toBe(speak);
    expect(getVoiceSpeech(none)).toBeUndefined();
    // a declared origin is validated and copied: an extra field never travels
    expect(
      getSessionOrigin({
        events: runtimeEventBus({ sessionOrigin: { kind: "run", extra: 1 } as TurnOrigin }),
      }),
    ).toEqual({ kind: "run" });
    // binding: an admission wins (and binds nothing outside a turn); else the declared origin
    expect(boundOrigin({ admission, sessionOrigin: { kind: "run" } })).toBeUndefined();
    expect(boundOrigin({ sessionOrigin: { kind: "run" } })).toEqual({ kind: "run" });
    expect(boundOrigin({})).toBeUndefined();
  });
});

const REACHY_YAML = (extra: string[] = [], reachy: string[] = []) =>
  [
    "capabilities:",
    "  - reachy",
    "",
    "reachy:",
    "  socket: /tmp/reachy.sock",
    "  sidecarVersion: 0.1.0",
    ...reachy,
    "",
    ...extra,
    "",
  ].join("\n");
const resolve = (yaml: string) =>
  resolveCapabilities({ yamlText: yaml, resolveSource: () => "/x" });

describe("bob#356 — voice.wakeName, bob-owned and projected", () => {
  it("defaults to jarvis, projected into the reachy config the extension reads", () => {
    const res = resolve(REACHY_YAML());
    expect(res.capabilities[0]?.config.wakeName).toBe("jarvis");
    expect(JSON.parse(capabilityConfigEnv(res).BOB_CAP_REACHY ?? "{}").wakeName).toBe("jarvis");
  });

  it("a configured voice.wakeName is the one bob pushes", () => {
    const res = resolve(REACHY_YAML(["voice:", "  wakeName: rocky"]));
    expect(res.capabilities[0]?.config.wakeName).toBe("rocky");
    expect(readVoiceWakeName("voice:\n  wakeName: hey-rocky\n")).toBe("hey-rocky");
  });

  it("a reachy block that sets its own wakeName is refused (one source of truth)", () => {
    expect(() => resolve(REACHY_YAML([], ["  wakeName: rocky"]))).toThrow(
      /wake name is bob-owned at the agent level/,
    );
  });

  it.each([
    ["voice:\n  wakeName: Rocky\n", /wakeName must be/],
    ["voice:\n  wakeName: r\n", /wakeName must be/],
    ["voice:\n  wakeName: 42\n", /wakeName must be/],
    ["voice:\n  wakeName: rocky!\n", /wakeName must be/],
    ["voice:\n  name: rocky\n", /unknown key "name"/],
  ])("refuses a malformed voice block: %s", (yaml, err) => {
    expect(() => readVoiceWakeName(yaml)).toThrow(err);
  });

  it("an unknown profile is refused at bob.yaml load", () => {
    expect(() => resolve(REACHY_YAML([], ["  profile: robot"]))).toThrow(/config is invalid/);
    expect(resolve(REACHY_YAML([], ["  profile: reachy"])).capabilities[0]?.config.profile).toBe(
      "reachy",
    );
  });

  it("bob.yaml refuses a V1 mail speech grant", () => {
    expect(() => resolve(REACHY_YAML([], ["  roomSpeechOrigins: [mail:flint]"]))).toThrow(
      /REACHY_V1_MAIL_SPEECH_UNSUPPORTED/,
    );
  });

  it("room-speech grants are exact origins; a voice grant is not expressible", () => {
    expect(() =>
      resolve(REACHY_YAML([], ["  roomSpeechOrigins: [run, cron:standup, discord:123]"])),
    ).not.toThrow();
    for (const bad of ["voice", "cron:*", "discord:abc", "everyone"]) {
      expect(() => resolve(REACHY_YAML([], [`  roomSpeechOrigins: [${bad}]`]))).toThrow(
        /config is invalid/,
      );
    }
  });
});

describe("bob#356 — the conditional tool map, applied before the registry audit", () => {
  const reachy = (config: Record<string, unknown>) => ({
    name: "reachy",
    manifest: reachyManifest,
    config,
  });

  it("the configured row is what the capability registers (voice by default)", () => {
    expect(configuredCapabilityTools(reachy({}))).toEqual(["reachy_say", "reachy_state"]);
    expect(configuredCapabilityTools(reachy({ profile: "reachy" }))).toEqual([
      "reachy_look",
      "reachy_say",
      "reachy_state",
      "reachy_frame",
    ]);
    // a capability without a map registers its declared tools
    const flair = lookupCapability("flair");
    if (!flair) throw new Error("flair is blessed");
    expect(configuredCapabilityTools({ manifest: flair.manifest, config: {} })).toEqual(
      flair.manifest.provides?.tools ?? ["(none)"],
    );
  });

  it("an allowlisted body tool under the voice profile is refused BY NAME, naming the setting", () => {
    const policy = { tools: ["reachy_say", "reachy_look", "reachy_frame"], excludeTools: [] };
    expect(conditionalToolRefusals(policy, [reachy({})])).toEqual([
      "reachy_look (reachy.profile is voice, which does not register it)",
      "reachy_frame (reachy.profile is voice, which does not register it)",
    ]);
    expect(() => assertConditionalTools(policy, [reachy({})])).toThrow(
      /2 allowlisted tools the configured capability does not register: reachy_look/,
    );
    // the same allowlist under the body profile, or with the body tools excluded, passes
    expect(() => assertConditionalTools(policy, [reachy({ profile: "reachy" })])).not.toThrow();
    expect(() =>
      assertConditionalTools({ ...policy, excludeTools: ["reachy_look", "reachy_frame"] }, [
        reachy({}),
      ]),
    ).not.toThrow();
  });
});
