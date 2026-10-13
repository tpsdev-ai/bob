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
import { createTurnAdmission } from "../../src/shell/turn-admission.js";
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

  it("is NOT admitted in V1: refused before queuing, nothing prompted, the FIFO unharmed", async () => {
    const admission = createTurnAdmission();
    const prompts: string[] = [];
    admission.bind({
      subscribe: () => () => {},
      dispose() {},
      async prompt(text: string) {
        prompts.push(text);
      },
    });
    await expect(admission.admitTurn(voice(), "jarvis, read my mail")).rejects.toThrow(
      /voice-origin turns are not admitted yet/,
    );
    expect(prompts).toEqual([]);
    await admission.admitTurn({ kind: "run" }, "next");
    expect(prompts).toEqual(["next"]);
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

  it("room-speech grants are exact origins; a voice grant is not expressible", () => {
    expect(() =>
      resolve(
        REACHY_YAML([], ["  roomSpeechOrigins: [run, cron:standup, discord:123, mail:flint]"]),
      ),
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
