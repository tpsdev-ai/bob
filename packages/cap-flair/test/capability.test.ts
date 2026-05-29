import { webcrypto } from "node:crypto";
import { describe, expect, it } from "bun:test";
import {
  CONFIG_ENV_VAR,
  type FlairClient,
  FlairHttpClient,
  type FlairSearchHit,
  loadConfigFromEnv,
  type PiLike,
  wireFlairCapability,
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
      { id: "pulse-1", content: "moved to dtrt-pulse", createdAt: "2026-05-29T00:00:00Z", score: 0.91 },
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

    const captured: { url: string; method: string; headers: Record<string, string>; body?: string }[] =
      [];
    const fetchImpl = async (
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string },
    ) => {
      captured.push({ url, method: init.method, headers: init.headers, body: init.body });
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ results: [{ id: "pulse-9", content: "c", _score: 0.5 }] }),
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
});
