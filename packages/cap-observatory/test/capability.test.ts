import { describe, expect, it } from "bun:test";
import { webcrypto } from "node:crypto";
import {
  type AgentSignal,
  buildAgentStatus,
  buildBatch,
  buildEvents,
  CONFIG_ENV_VAR,
  deriveStatus,
  extractBeadsSummary,
  type IngestBatch,
  loadConfigFromEnv,
  type ObservatoryClient,
  ObservatoryHttpClient,
  type PiLike,
  REDACTED,
  readSignal,
  sanitize,
  sanitizeString,
  wireObservatoryCapability,
} from "../src/index.js";

const { subtle } = webcrypto;

// --- a tiny fake pi that records registered tools + lets a test invoke them --
class FakePi implements PiLike {
  readonly tools = new Map<
    string,
    {
      name: string;
      execute: (
        id: string,
        p: Record<string, unknown>,
      ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
    }
  >();
  registerTool(tool: {
    name: string;
    execute: (
      id: string,
      p: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void {
    this.tools.set(tool.name, tool);
  }
  async call(name: string, params: Record<string, unknown>): Promise<string> {
    const t = this.tools.get(name);
    if (!t) throw new Error(`no tool ${name}`);
    const r = await t.execute("tc-1", params);
    return r.content.map((c) => c.text).join("");
  }
}

// --- a fake ObservatoryClient that records the batch it was POSTed -----------
class FakeClient implements ObservatoryClient {
  posted: IngestBatch[] = [];
  async post(batch: IngestBatch) {
    this.posted.push(batch);
    return { ok: true, events: batch.events.length, agents: batch.agents.length };
  }
}

const FIXED_NOW = 1_700_000_000_000;

// =====================================================================
// loadConfigFromEnv
// =====================================================================
describe("loadConfigFromEnv", () => {
  const good = JSON.stringify({
    observatoryUrl: "http://127.0.0.1:9926",
    officeId: "rockit",
    officeKeyFile: "/home/x/.flair/keys/rockit-office.key",
    agents: [{ agentId: "flint", role: "Strategy", model: "claude-opus-4-8" }],
  });

  it("parses a valid config block", () => {
    const cfg = loadConfigFromEnv({ [CONFIG_ENV_VAR]: good } as NodeJS.ProcessEnv);
    expect(cfg.officeId).toBe("rockit");
    expect(cfg.observatoryUrl).toBe("http://127.0.0.1:9926");
    expect(cfg.agents[0]?.agentId).toBe("flint");
  });

  it("throws when the env var is missing", () => {
    expect(() => loadConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow(CONFIG_ENV_VAR);
  });

  it("throws on invalid JSON without echoing the blob", () => {
    expect(() => loadConfigFromEnv({ [CONFIG_ENV_VAR]: "{not json" } as NodeJS.ProcessEnv)).toThrow(
      "not valid JSON",
    );
  });

  it("rejects an unknown field (additionalProperties:false)", () => {
    const bad = JSON.stringify({
      observatoryUrl: "http://x",
      officeId: "rockit",
      officeKeyFile: "/k",
      agents: [{ agentId: "flint" }],
      token: "should-not-be-here",
    });
    expect(() => loadConfigFromEnv({ [CONFIG_ENV_VAR]: bad } as NodeJS.ProcessEnv)).toThrow(
      "config is invalid",
    );
  });

  it("rejects an officeId with illegal characters", () => {
    const bad = JSON.stringify({
      observatoryUrl: "http://x",
      officeId: "Rockit!",
      officeKeyFile: "/k",
      agents: [{ agentId: "flint" }],
    });
    expect(() => loadConfigFromEnv({ [CONFIG_ENV_VAR]: bad } as NodeJS.ProcessEnv)).toThrow(
      "config is invalid",
    );
  });

  it("rejects an empty agents array (minItems:1)", () => {
    const bad = JSON.stringify({
      observatoryUrl: "http://x",
      officeId: "rockit",
      officeKeyFile: "/k",
      agents: [],
    });
    expect(() => loadConfigFromEnv({ [CONFIG_ENV_VAR]: bad } as NodeJS.ProcessEnv)).toThrow(
      "config is invalid",
    );
  });
});

// =====================================================================
// sanitize() — the redaction boundary (Sherlock hard requirement)
// =====================================================================
describe("sanitizeString (redaction boundary)", () => {
  it("strips a POSIX home path", () => {
    const out = sanitizeString("see ~/ops/tps/specs/CHECKPOINT-2.md for details");
    expect(out).not.toContain("~/ops");
    expect(out).toContain(REDACTED);
    expect(out).toContain("see");
  });

  it("strips an absolute /Users path", () => {
    const out = sanitizeString("wrote /Users/squeued/.flair/keys/rockit-office.key");
    expect(out).not.toContain("/Users/");
    expect(out).not.toContain(".flair/keys");
    expect(out).toContain(REDACTED);
  });

  it("strips an absolute /home path", () => {
    const out = sanitizeString("crashed reading /home/agent/.config/secret");
    expect(out).not.toContain("/home/");
    expect(out).toContain(REDACTED);
  });

  it("strips a GitHub PAT", () => {
    const out = sanitizeString(
      "pushed with github_pat_11ABCDEFG0abcdefghijklmnop and ghp_AbCd1234EfGh5678IjKl",
    );
    expect(out).not.toContain("github_pat_11ABCDEFG0");
    expect(out).not.toContain("ghp_AbCd1234EfGh5678IjKl");
    expect(out).toContain(REDACTED);
  });

  it("strips an sk- API key and a Bearer header", () => {
    const out = sanitizeString(
      "Authorization: Bearer eyJhbGciOiJIUzI1Niabcdefghijklmnop and key sk-ant-api03-AbCdEfGhIjKlMnOpQr",
    );
    expect(out).not.toContain("sk-ant-api03-AbCdEfGhIjKlMnOpQr");
    expect(out).not.toContain("eyJhbGciOiJIUzI1Niabcdefghijklmnop");
    expect(out).toContain(REDACTED);
  });

  it("strips a token=… assignment", () => {
    const out = sanitizeString("config token=abc123def456ghi789 loaded");
    expect(out).not.toContain("abc123def456ghi789");
    expect(out).toContain(REDACTED);
  });

  it("redacts a PEM private-key block (markers + body)", () => {
    const pem =
      "-----BEGIN RSA PRIVATE KEY-----\n" +
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDabc123def456\n" +
      "-----END RSA PRIVATE KEY-----";
    const out = sanitizeString(`leaked key:\n${pem}\nshipped anyway`);
    expect(out).not.toContain("PRIVATE KEY");
    expect(out).not.toContain("MIIEvQIBAD");
    expect(out).toContain(REDACTED);
    expect(out).toContain("leaked key");
  });

  it("is linear-time on crafted PEM-marker repetitions (no polynomial ReDoS)", () => {
    // Adversarial: many "-----BEGIN…PRIVATE KEY-----" prefixes and no END marker.
    // The bounded quantifiers keep this near-instant; the prior unbounded regex
    // (`[^-]*` / `[\s\S]*?`) was O(n^2) here — CodeQL js/polynomial-redos.
    const evil = "-----BEGIN PRIVATE KEY-----".repeat(5000);
    const start = performance.now();
    const out = sanitizeString(evil);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(typeof out).toBe("string");
  });

  it("redacts to a constant, never a partial echo of the secret", () => {
    const secret = "ghp_SuperSecretTokenValue1234567890";
    const out = sanitizeString(`leaked ${secret}`);
    // No prefix or suffix fragment of the secret survives.
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("1234567890");
  });

  it("leaves clean prose untouched", () => {
    const out = sanitizeString("Reviewing PR 421, two K&S approvals, merging");
    expect(out).toBe("Reviewing PR 421, two K&S approvals, merging");
  });
});

describe("sanitize() over a realistic DIRTY batch", () => {
  it("strips paths/secrets from currentTask and bodies from event summaries", () => {
    // Realistic dirty agent output: a path in currentTask, a token + transcript
    // snippet + a mail body crammed into event summaries.
    const dirty = {
      agents: [
        {
          agentId: "flint",
          status: "active",
          currentTask: "Debug Flair auth — see /Users/squeued/.flair/admin-pass",
        },
      ],
      events: [
        {
          id: "flint:mail:1:",
          kind: "mail",
          authorId: "flint",
          // A leaked mail BODY (must be scrubbed of its embedded secret/path).
          summary: "mailed kern: token=ghs_LeakedSecret0123456789abcdef in ~/ops/tps",
        },
        {
          id: "flint:transcript:2:",
          kind: "note",
          authorId: "flint",
          // A raw transcript snippet with a secret.
          summary: "User said: my api key is sk-ant-api03-ZyXwVuTsRqPoNmLkJiHg please",
        },
      ],
    };

    const clean = sanitize(dirty);

    // currentTask: path gone.
    expect(clean.agents[0]?.currentTask).not.toContain("/Users/");
    expect(clean.agents[0]?.currentTask).not.toContain(".flair/admin-pass");
    expect(clean.agents[0]?.currentTask).toContain(REDACTED);

    // mail-body event: token + path gone.
    expect(clean.events[0]?.summary).not.toContain("ghs_LeakedSecret0123456789abcdef");
    expect(clean.events[0]?.summary).not.toContain("~/ops");
    expect(clean.events[0]?.summary).toContain(REDACTED);

    // transcript event: api key gone.
    expect(clean.events[1]?.summary).not.toContain("sk-ant-api03-ZyXwVuTsRqPoNmLkJiHg");
    expect(clean.events[1]?.summary).toContain(REDACTED);

    // Purity: the input is not mutated.
    expect(dirty.agents[0]?.currentTask).toContain("/Users/");
  });
});

// =====================================================================
// snapshot builder
// =====================================================================
describe("deriveStatus (active | idle | offline | stale)", () => {
  const thresh = 600;
  it("offline when there is no heartbeat", () => {
    expect(deriveStatus({ lastHeartbeatMs: undefined }, FIXED_NOW, thresh)).toBe("offline");
  });
  it("stale when the heartbeat is older than the threshold", () => {
    const old = FIXED_NOW - 601 * 1000;
    expect(deriveStatus({ lastHeartbeatMs: old }, FIXED_NOW, thresh)).toBe("stale");
  });
  it("active when fresh AND a task is in progress", () => {
    expect(
      deriveStatus(
        { lastHeartbeatMs: FIXED_NOW - 1000, currentTaskSummary: "merge PR 421" },
        FIXED_NOW,
        thresh,
      ),
    ).toBe("active");
  });
  it("idle when fresh AND no task", () => {
    expect(deriveStatus({ lastHeartbeatMs: FIXED_NOW - 1000 }, FIXED_NOW, thresh)).toBe("idle");
  });
});

describe("buildAgentStatus + buildEvents + buildBatch", () => {
  const opts = { now: () => FIXED_NOW, uuid: () => "nonce-fixed", staleThresholdSeconds: 600 };

  it("builds a snapshot from a signal (role/model/status/currentTask)", () => {
    const signal: AgentSignal = {
      agentId: "flint",
      role: "Strategy",
      model: "claude-opus-4-8",
      currentTaskSummary: "merge PR 421",
      lastHeartbeatMs: FIXED_NOW - 1000,
    };
    const snap = buildAgentStatus(signal, opts);
    expect(snap.agentId).toBe("flint");
    expect(snap.role).toBe("Strategy");
    expect(snap.model).toBe("claude-opus-4-8");
    expect(snap.status).toBe("active");
    expect(snap.currentTask).toBe("merge PR 421");
    expect(snap.type).toBe("agent");
    expect(snap.lastHeartbeat).toBe(new Date(FIXED_NOW - 1000).toISOString());
  });

  it("builds events with a nonce + tsMs (per-record replay protection) and deterministic id", () => {
    const signal: AgentSignal = {
      agentId: "flint",
      lastHeartbeatMs: FIXED_NOW,
      events: [
        { kind: "pr_opened", summary: "opened PR 421", refId: "421", occurredAtMs: FIXED_NOW },
      ],
    };
    const evs = buildEvents(signal, opts);
    expect(evs).toHaveLength(1);
    expect(evs[0]?.kind).toBe("pr_opened");
    expect(evs[0]?.authorId).toBe("flint");
    expect(evs[0]?.nonce).toBe("nonce-fixed");
    expect(evs[0]?.tsMs).toBe(FIXED_NOW);
    expect(evs[0]?.id).toBe(`flint:pr_opened:${FIXED_NOW}:421`);
  });

  it("batches a whole office into one { agents, events }", () => {
    const signals: AgentSignal[] = [
      { agentId: "flint", lastHeartbeatMs: FIXED_NOW, currentTaskSummary: "x" },
      { agentId: "anvil", lastHeartbeatMs: undefined, events: [{ kind: "mail", summary: "sent" }] },
    ];
    const batch = buildBatch(signals, opts);
    expect(batch.agents.map((a) => a.agentId)).toEqual(["flint", "anvil"]);
    expect(batch.agents[1]?.status).toBe("offline");
    expect(batch.events).toHaveLength(1);
  });
});

// =====================================================================
// reader — Beads summary extraction (never the prompt/transcript)
// =====================================================================
describe("reader: extractBeadsSummary + readSignal", () => {
  it("pulls the in-progress task summary, NOT the prompt/transcript", () => {
    const beads = JSON.stringify({
      tasks: [
        { id: "ops-1", status: "done", summary: "old task" },
        {
          id: "ops-2",
          status: "in_progress",
          summary: "Build cap-observatory producer",
          prompt: "DO NOT LEAK: ~/ops/secret + token=ghp_x",
        },
      ],
    });
    expect(extractBeadsSummary(beads)).toBe("Build cap-observatory producer");
  });

  it("readSignal derives offline + no task when files are missing (no throw)", () => {
    const signal = readSignal(
      { agentId: "flint", role: "Strategy", heartbeatFile: "/nope/hb", beadsFile: "/nope/beads" },
      {
        readFile: () => {
          throw new Error("ENOENT");
        },
        statMtimeMs: () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect(signal.lastHeartbeatMs).toBeUndefined();
    expect(signal.currentTaskSummary).toBeUndefined();
  });

  it("readSignal reads heartbeat mtime + beads summary from the fs seam", () => {
    const signal = readSignal(
      { agentId: "flint", heartbeatFile: "/hb", beadsFile: "/beads" },
      {
        readFile: (p) =>
          p === "/beads"
            ? JSON.stringify({ status: "in_progress", summary: "merge PR 421" })
            : JSON.stringify({ events: [{ kind: "pr_merged", summary: "merged 421" }] }),
        statMtimeMs: () => FIXED_NOW,
      },
    );
    expect(signal.lastHeartbeatMs).toBe(FIXED_NOW);
    expect(signal.currentTaskSummary).toBe("merge PR 421");
    expect(signal.events?.[0]?.kind).toBe("pr_merged");
  });
});

// =====================================================================
// capability wiring (the observatory_report tool)
// =====================================================================
describe("wireObservatoryCapability", () => {
  function wired(signals: AgentSignal[]) {
    const pi = new FakePi();
    const client = new FakeClient();
    wireObservatoryCapability({
      pi,
      client,
      readSignals: () => signals,
      staleThresholdSeconds: 600,
      log: () => {},
    });
    return { pi, client };
  }

  it("registers exactly the observatory_report tool", () => {
    const { pi } = wired([]);
    expect([...pi.tools.keys()]).toEqual(["observatory_report"]);
  });

  it("observatory_report builds + posts one batched call and reports counts", async () => {
    const { pi, client } = wired([
      { agentId: "flint", lastHeartbeatMs: Date.now(), currentTaskSummary: "merge PR 421" },
      { agentId: "anvil", lastHeartbeatMs: undefined },
    ]);
    const out = await pi.call("observatory_report", {});
    // Exactly ONE POST for the whole office (batched, per Kern's rate limit).
    expect(client.posted).toHaveLength(1);
    expect(client.posted[0]?.agents).toHaveLength(2);
    expect(out).toContain("2 agent(s)");
    expect(out).toContain("active");
    expect(out).toContain("offline");
  });
});

// =====================================================================
// ObservatoryHttpClient — OFFICE-key signing + sign→verify round-trip
// =====================================================================
describe("ObservatoryHttpClient protocol + OFFICE-key Ed25519 signing", () => {
  async function makeClientWithCapture() {
    // Generate a real OFFICE keypair so we can verify the client's signature
    // end-to-end against the OFFICE public key (what IngestEvents verifies).
    const kp = (await subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const pkcs8b64 = Buffer.from(await subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");

    const captured: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }[] = [];
    const fetchImpl = async (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => {
      captured.push({ url, method: init.method, headers: init.headers, body: init.body });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true, events: 1, agents: 1 }),
      };
    };

    const client = new ObservatoryHttpClient({
      url: "http://127.0.0.1:9926/",
      officeId: "rockit",
      officeKeyFile: "/unused",
      fetchImpl,
      now: () => FIXED_NOW,
      uuid: () => "nonce-abc",
      readFile: () => pkcs8b64,
    });
    return { client, captured, verifyKey: kp.publicKey };
  }

  it("signs POST /IngestEvents with a verifiable TPS-Ed25519 header over officeId:ts:nonce:POST:/IngestEvents", async () => {
    const { client, captured, verifyKey } = await makeClientWithCapture();
    const batch = buildBatch(
      [{ agentId: "flint", lastHeartbeatMs: FIXED_NOW, currentTaskSummary: "x" }],
      { now: () => FIXED_NOW, uuid: () => "n" },
    );
    const result = await client.post(batch);
    expect(result.ok).toBe(true);

    const req = captured[0];
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("http://127.0.0.1:9926/IngestEvents"); // trailing slash on base dropped

    // Body envelope shape matches IngestPayload.
    const body = JSON.parse(req?.body ?? "{}");
    expect(body.officeId).toBe("rockit");
    expect(Array.isArray(body.agents)).toBe(true);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.syncedAt).toBe(new Date(FIXED_NOW).toISOString());

    const auth = req?.headers.Authorization ?? "";
    expect(auth.startsWith("TPS-Ed25519 ")).toBe(true);
    const [officeId, ts, nonce, sigB64] = auth.slice("TPS-Ed25519 ".length).split(":");
    expect(officeId).toBe("rockit");
    expect(ts).toBe(String(FIXED_NOW)); // milliseconds, not seconds
    expect(nonce).toBe("nonce-abc");

    // Round-trip verify against the OFFICE public key with the EXACT payload the
    // server (IngestEvents) reconstructs.
    const payload = `rockit:${FIXED_NOW}:nonce-abc:POST:/IngestEvents`;
    const okSig = await subtle.verify(
      "Ed25519",
      verifyKey,
      Buffer.from(sigB64 ?? "", "base64"),
      new TextEncoder().encode(payload),
    );
    expect(okSig).toBe(true);
  });

  it("sanitizes the batch before signing/POST (redaction boundary in the client)", async () => {
    const { client, captured } = await makeClientWithCapture();
    const dirty: IngestBatch = {
      agents: [
        {
          agentId: "flint",
          status: "active",
          currentTask: "see /Users/squeued/.flair/admin-pass",
        },
      ],
      events: [],
    };
    await client.post(dirty);
    const body = JSON.parse(captured[0]?.body ?? "{}");
    expect(body.agents[0].currentTask).not.toContain("/Users/");
    expect(body.agents[0].currentTask).toContain(REDACTED);
  });

  it("expands a leading ~/ in officeKeyFile to homedir", async () => {
    const { homedir } = await import("node:os");
    const kp = (await subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const pkcs8b64 = Buffer.from(await subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
    let readPath = "";
    const client = new ObservatoryHttpClient({
      url: "http://h",
      officeId: "rockit",
      officeKeyFile: "~/.flair/keys/rockit-office.key",
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }),
      now: () => 1,
      uuid: () => "n",
      readFile: (p) => {
        readPath = p;
        return pkcs8b64;
      },
    });
    await client.post({ agents: [], events: [] });
    expect(readPath).toBe(`${homedir()}/.flair/keys/rockit-office.key`);
  });

  it("throws a status-only error (no body/auth) on a non-2xx", async () => {
    const kp = (await subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const pkcs8b64 = Buffer.from(await subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
    const client = new ObservatoryHttpClient({
      url: "http://h",
      officeId: "rockit",
      officeKeyFile: "/unused",
      fetchImpl: async () => ({
        ok: false,
        status: 429,
        text: async () => JSON.stringify({ error: "rate limit: 1 call per 10s" }),
      }),
      now: () => 1,
      uuid: () => "n",
      readFile: () => pkcs8b64,
    });
    await expect(client.post({ agents: [], events: [] })).rejects.toThrow("429");
  });
});
