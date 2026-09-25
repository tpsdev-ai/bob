import { describe, expect, it } from "bun:test";
import { generateKeyPairSync, webcrypto } from "node:crypto";
import {
  CONFIG_ENV_VAR,
  type FlairClient,
  FlairHttpClient,
  type FlairSearchHit,
  loadConfigFromEnv,
  type PiLike,
  wireFlairCapability,
} from "../../../src/capabilities/flair/index.js";

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

// --- a fake FlairClient that records calls + returns canned data -------------
class FakeClient implements FlairClient {
  searchCalls: Array<{ query: string; limit?: number }> = [];
  writeCalls: Array<{ content: string; opts?: unknown }> = [];
  getCalls: string[] = [];
  hits: FlairSearchHit[] = [];
  async search(query: string, limit?: number) {
    this.searchCalls.push({ query, limit });
    return this.hits;
  }
  async write(content: string, opts?: { durability?: never; supersedes?: string }) {
    this.writeCalls.push({ content, opts });
    return { id: "pulse-123" };
  }
  async get(id: string) {
    this.getCalls.push(id);
    return id === "pulse-123" ? { id, content: "hello" } : null;
  }
}

describe("loadConfigFromEnv", () => {
  const good = JSON.stringify({
    url: "http://127.0.0.1:9926",
    agentId: "pulse",
    keyFile: "/home/x/.flair/keys/pulse.key",
  });

  it("parses a valid config block", () => {
    const cfg = loadConfigFromEnv({ [CONFIG_ENV_VAR]: good } as NodeJS.ProcessEnv);
    expect(cfg.agentId).toBe("pulse");
    expect(cfg.url).toBe("http://127.0.0.1:9926");
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
      url: "http://x",
      agentId: "pulse",
      keyFile: "/k",
      token: "should-not-be-here",
    });
    expect(() => loadConfigFromEnv({ [CONFIG_ENV_VAR]: bad } as NodeJS.ProcessEnv)).toThrow(
      "config is invalid",
    );
  });

  it("rejects an agentId with illegal characters", () => {
    const bad = JSON.stringify({ url: "http://x", agentId: "Pulse!", keyFile: "/k" });
    expect(() => loadConfigFromEnv({ [CONFIG_ENV_VAR]: bad } as NodeJS.ProcessEnv)).toThrow(
      "config is invalid",
    );
  });
});

describe("wireFlairCapability", () => {
  function wired() {
    const pi = new FakePi();
    const client = new FakeClient();
    wireFlairCapability({ pi, client, log: () => {} });
    return { pi, client };
  }

  it("registers exactly the three memory tools", () => {
    const { pi } = wired();
    expect([...pi.tools.keys()].sort()).toEqual(["flair_get", "flair_search", "flair_write"]);
  });

  it("flair_search passes query+limit and renders hits", async () => {
    const { pi, client } = wired();
    client.hits = [
      {
        id: "pulse-1",
        content: "moved to dtrt-pulse",
        createdAt: "2026-05-29T00:00:00Z",
        score: 0.91,
      },
    ];
    const out = await pi.call("flair_search", { query: "dtrt-pulse", limit: 3 });
    expect(client.searchCalls).toEqual([{ query: "dtrt-pulse", limit: 3 }]);
    expect(out).toContain("pulse-1");
    expect(out).toContain("moved to dtrt-pulse");
    expect(out).toContain("0.910");
    expect(out).toContain("2026-05-29");
  });

  it("flair_search caps the limit at 25", async () => {
    const { pi, client } = wired();
    await pi.call("flair_search", { query: "x", limit: 999 });
    expect(client.searchCalls[0]?.limit).toBe(25);
  });

  it("flair_search reports empty cleanly", async () => {
    const { pi } = wired();
    const out = await pi.call("flair_search", { query: "nothing" });
    expect(out).toBe("(no memories found)");
  });

  it("flair_write forwards content + durability + supersedes and returns the id", async () => {
    const { pi, client } = wired();
    const out = await pi.call("flair_write", {
      content: "remember this",
      durability: "persistent",
      supersedes: "pulse-0",
    });
    expect(client.writeCalls[0]?.content).toBe("remember this");
    expect(client.writeCalls[0]?.opts).toEqual({ durability: "persistent", supersedes: "pulse-0" });
    expect(out).toContain("pulse-123");
  });

  it("flair_get returns the memory, or (not found)", async () => {
    const { pi } = wired();
    expect(await pi.call("flair_get", { id: "pulse-123" })).toContain("hello");
    expect(await pi.call("flair_get", { id: "missing" })).toBe("(not found)");
  });
});

describe("FlairHttpClient protocol + Ed25519 signing", () => {
  // Generate a real keypair so we can verify the client's signature end-to-end.
  async function makeClientWithCapture() {
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
        text: async () =>
          JSON.stringify({ results: [{ id: "pulse-9", content: "c", _score: 0.5 }] }),
      };
    };

    const client = new FlairHttpClient({
      url: "http://127.0.0.1:9926/",
      agentId: "pulse",
      keyFile: "/unused",
      fetchImpl,
      now: () => 1_700_000_000_000, // fixed ms timestamp
      uuid: () => "nonce-abc",
      readFile: () => pkcs8b64,
    });
    return { client, captured, verifyKey: kp.publicKey };
  }

  it("signs search with a verifiable TPS-Ed25519 header over agentId:ts:nonce:METHOD:path", async () => {
    const { client, captured, verifyKey } = await makeClientWithCapture();
    const hits = await client.search("hello", 5);
    expect(hits).toEqual([{ id: "pulse-9", content: "c", createdAt: undefined, score: 0.5 }]);

    const req = captured[0];
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("http://127.0.0.1:9926/SemanticSearch"); // trailing slash on base dropped
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ agentId: "pulse", q: "hello", limit: 5 });

    const auth = req?.headers.Authorization ?? "";
    expect(auth.startsWith("TPS-Ed25519 ")).toBe(true);
    const [agentId, ts, nonce, sigB64] = auth.slice("TPS-Ed25519 ".length).split(":");
    expect(agentId).toBe("pulse");
    expect(ts).toBe("1700000000000"); // milliseconds, not seconds
    expect(nonce).toBe("nonce-abc");

    const payload = `pulse:1700000000000:nonce-abc:POST:/SemanticSearch`;
    const okSig = await subtle.verify(
      "Ed25519",
      verifyKey,
      Buffer.from(sigB64 ?? "", "base64"),
      new TextEncoder().encode(payload),
    );
    expect(okSig).toBe(true);
  });

  it("write PUTs /Memory/<id> with durability + a derived id", async () => {
    const { client, captured } = await makeClientWithCapture();
    const { id } = await client.write("note", { durability: "persistent" });
    expect(id).toBe("pulse-1700000000000");
    const req = captured[0];
    expect(req?.method).toBe("PUT");
    expect(req?.url).toBe("http://127.0.0.1:9926/Memory/pulse-1700000000000");
    const body = JSON.parse(req?.body ?? "{}");
    expect(body.agentId).toBe("pulse");
    expect(body.content).toBe("note");
    expect(body.durability).toBe("persistent");
  });

  it("expands a leading ~/ in keyFile to homedir", async () => {
    const { homedir } = await import("node:os");
    const kp = (await subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as CryptoKeyPair;
    const pkcs8b64 = Buffer.from(await subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
    let readPath = "";
    const client = new FlairHttpClient({
      url: "http://h",
      agentId: "a",
      keyFile: "~/.flair/keys/a.key",
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "{}" }),
      now: () => 1,
      uuid: () => "n",
      readFile: (p) => {
        readPath = p;
        return pkcs8b64;
      },
    });
    await client.get("x");
    expect(readPath).toBe(`${homedir()}/.flair/keys/a.key`);
  });

  // Regression for ops-kvz6: `bob flair-pair` writes the private key as PEM
  // PKCS8 (-----BEGIN PRIVATE KEY-----), but loadKey() used to base64-decode
  // the file then subtle.importKey("pkcs8", …), which throws a DataError on
  // PEM. Net: EVERY agent's flair_search/write/get failed to sign. This proves
  // a key in flairPair's ACTUAL on-disk format round-trips through the signer.
  it("signs with a key in `bob flair-pair`'s PEM PKCS8 output format (ops-kvz6)", async () => {
    // Reproduce flair-pair.ts's exact key serialization.
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    // Sanity-check we built the format the bug report names: PEM, ~119B, 3 lines.
    expect(privPem.startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);
    expect(privPem.trim().split("\n").length).toBe(3);

    let captured: Record<string, string> = {};
    const client = new FlairHttpClient({
      url: "http://127.0.0.1:9926",
      agentId: "rivet",
      keyFile: "/unused",
      fetchImpl: async (_url, init) => {
        captured = init.headers;
        return { ok: true, status: 200, text: async () => "{}" };
      },
      now: () => 1_700_000_000_000,
      uuid: () => "nonce-pem",
      readFile: () => privPem, // the PEM the cap-flair client used to choke on
    });

    // Before the fix this throws ("Invalid keyData") instead of signing.
    await client.get("rivet-1");

    const auth = captured.Authorization ?? "";
    expect(auth.startsWith("TPS-Ed25519 ")).toBe(true);
    const [agentId, ts, nonce, sigB64] = auth.slice("TPS-Ed25519 ".length).split(":");
    expect(agentId).toBe("rivet");
    expect(ts).toBe("1700000000000");
    expect(nonce).toBe("nonce-pem");

    // The signature must verify against the PEM key's matching public key.
    const spki = publicKey.export({ format: "der", type: "spki" });
    const verifyKey = await subtle.importKey("spki", spki, { name: "Ed25519" }, false, ["verify"]);
    const payload = `rivet:1700000000000:nonce-pem:GET:/Memory/rivet-1`;
    const ok = await subtle.verify(
      "Ed25519",
      verifyKey,
      Buffer.from(sigB64 ?? "", "base64"),
      new TextEncoder().encode(payload),
    );
    expect(ok).toBe(true);
  });
});

// ── Presence beat (POST /Presence) + agent record read (GET /Agent/<name>) ─────
//
// These tests prove the presence capability's wire protocol against a Flair
// store (using a real Ed25519 key so the TPS-Ed25519 signature verifies):
//   1. a liveness-only beat sends an EMPTY body — the assertion that the beacon
//      can't erase a busy stamp.
//   2. a busy beat sends exactly { activity, currentTask } — no other keys, so
//      no prompt/model/tool text can ride along.
//   3. an idle beat sends { activity: "idle" } only (currentTask:null omitted).
//   4. the request is signed with a MILLISECOND ts (the 1000x trap, named here).
//   5. agentGet GETs /Agent/<name> and surfaces a 404 as null.

async function makePresenceClient() {
  const kp = (await subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const pkcs8b64 = Buffer.from(await subtle.exportKey("pkcs8", kp.privateKey)).toString("base64");
  type Cap = {
    url: string;
    method: string;
    body?: string;
    headers: Record<string, string>;
  };
  const captured: Cap[] = [];
  const fetchImpl = async (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ): Promise<{ ok: boolean; status: number; text: () => Promise<string> }> => {
    if (url.includes("/Agent/")) {
      // Simulate Flair returning 404 for an unregistered agent so the
      // agentGet null-on-404 path is exercised.
      captured.push({ url, method: init.method, body: init.body, headers: init.headers });
      return { ok: false, status: 404, text: async () => "not found" };
    }
    captured.push({ url, method: init.method, body: init.body, headers: init.headers });
    return { ok: true, status: 200, text: async () => "{}" };
  };
  const client = new FlairHttpClient({
    url: "http://127.0.0.1:9926",
    agentId: "pulse",
    keyFile: "/unused",
    fetchImpl,
    now: () => 1_700_000_000_000,
    uuid: () => "nonce-presence",
    readFile: () => pkcs8b64,
  });
  return { client, captured, verifyKey: kp.publicKey };
}

describe("FlairHttpClient.presenceBeat — POST /Presence (metadata only)", () => {
  it("a liveness-only beat sends an empty body (no activity/currentTask keys)", async () => {
    const { client, captured } = await makePresenceClient();
    await client.presenceBeat({});
    expect(captured[0]?.method).toBe("POST");
    expect(captured[0]?.url).toBe("http://127.0.0.1:9926/Presence");
    // The load-bearing assertion: an empty body means the server preserves
    // the prior activity stamp (natural presence) — the beacon can't erase busy.
    expect(captured[0]?.body).toBe("{}");
  });

  it("a busy beat sends exactly {activity, currentTask} — no other keys", async () => {
    const { client, captured } = await makePresenceClient();
    await client.presenceBeat({ activity: "coding", currentTask: "mail from flint" });
    const body = JSON.parse(captured[0]?.body ?? "{}");
    expect(body).toEqual({ activity: "coding", currentTask: "mail from flint" });
    // exactly two keys — no prompt/model/tool text has a field to hide in
    expect(Object.keys(body).sort()).toEqual(["activity", "currentTask"]);
  });

  it("an idle beat sends {activity:'idle'} only (currentTask:null omitted)", async () => {
    const { client, captured } = await makePresenceClient();
    await client.presenceBeat({ activity: "idle", currentTask: null });
    const body = JSON.parse(captured[0]?.body ?? "{}");
    expect(body).toEqual({ activity: "idle" });
    expect(body.currentTask).toBeUndefined();
  });

  it("an empty-string currentTask is omitted (only activity lands)", async () => {
    const { client, captured } = await makePresenceClient();
    await client.presenceBeat({ activity: "debugging", currentTask: "" });
    const body = JSON.parse(captured[0]?.body ?? "{}");
    expect(body).toEqual({ activity: "debugging" });
  });

  // The 1000x trap: ts MUST be in milliseconds. A seconds value signs a
  // payload the server rejects (401). This test asserts the timestamp is the
  // full millisecond value AND the signature verifies over it.
  it("signs with a MILLIsecond timestamp (the 1000x trap) that verifies", async () => {
    const { client, captured, verifyKey } = await makePresenceClient();
    await client.presenceBeat({ activity: "planning", currentTask: "cron daily-brief" });
    const auth = captured[0]?.headers.Authorization ?? "";
    expect(auth.startsWith("TPS-Ed25519 ")).toBe(true);
    const [agentId, ts, nonce, sigB64] = auth.slice("TPS-Ed25519 ".length).split(":");
    expect(agentId).toBe("pulse");
    expect(ts).toBe("1700000000000"); // 13 digits = ms, not 10-digit seconds
    expect(Number(ts) > 1_000_000_000_000).toBe(true); // > a trillion: impossible for seconds
    expect(nonce).toBe("nonce-presence");
    const payload = "pulse:1700000000000:nonce-presence:POST:/Presence";
    const ok = await subtle.verify(
      "Ed25519",
      verifyKey,
      Buffer.from(sigB64 ?? "", "base64"),
      new TextEncoder().encode(payload),
    );
    expect(ok).toBe(true);
  });
});

describe("FlairHttpClient.agentGet — GET /Agent/<name>", () => {
  it("GETs /Agent/<name> and surfaces a 404 as null", async () => {
    const { client, captured } = await makePresenceClient();
    const got = await client.agentGet("pulse");
    expect(captured[0]?.method).toBe("GET");
    expect(captured[0]?.url).toBe("http://127.0.0.1:9926/Agent/pulse");
    expect(got).toBeNull();
  });

  it("signs the GET /Agent/<name> request with a ms timestamp that verifies", async () => {
    const { client, captured, verifyKey } = await makePresenceClient();
    // Use a name the fake fetch returns 200 for (anything not /Agent/ in the
    // helper, but agentGet always hits /Agent/ → 404 → null; still signed).
    await client.agentGet("flint");
    const auth = captured[0]?.headers.Authorization ?? "";
    const ts = auth.slice("TPS-Ed25519 ".length).split(":")[1];
    expect(ts).toBe("1700000000000");
    const payload = "pulse:1700000000000:nonce-presence:GET:/Agent/flint";
    const ok = await subtle.verify(
      "Ed25519",
      verifyKey,
      Buffer.from(auth.slice("TPS-Ed25519 ".length).split(":")[3] ?? "", "base64"),
      new TextEncoder().encode(payload),
    );
    expect(ok).toBe(true);
  });
});
