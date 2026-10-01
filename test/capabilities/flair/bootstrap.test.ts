// FlairHttpClient.bootstrap — POST /BootstrapMemories (bob#254).
//
// The client is exercised through its fetch/readFile seams (a real keypair so
// the signing path runs). The point of these tests is the ERROR stance: a
// non-2xx, an unreadable body or a body with no `context` is a typed
// FlairBootstrapError, never an empty context, and the server body is never
// put in the error (it can carry a reflected credential).
import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { FlairBootstrapError, FlairHttpClient } from "../../../src/capabilities/flair/client.js";

const PEM = generateKeyPairSync("ed25519").privateKey.export({
  type: "pkcs8",
  format: "pem",
}) as string;

type Captured = { url: string; method: string; headers: Record<string, string>; body?: string };

function clientWith(
  reply: (captured: Captured) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>,
): { client: FlairHttpClient; captured: Captured[] } {
  const captured: Captured[] = [];
  const client = new FlairHttpClient({
    url: "http://127.0.0.1:9926/",
    agentId: "pulse",
    keyFile: "/unused",
    fetchImpl: async (url, init) => {
      const c: Captured = { url, method: init.method, headers: init.headers, body: init.body };
      captured.push(c);
      return reply(c);
    },
    now: () => 1_700_000_000_000,
    uuid: () => "nonce",
    readFile: () => Buffer.from(PEM),
  });
  return { client, captured };
}

const ok = (body: string) => async () => ({ ok: true, status: 200, text: async () => body });

describe("FlairHttpClient.bootstrap", () => {
  it("POSTs /BootstrapMemories signed as the agent, and returns context + tokenEstimate", async () => {
    const { client, captured } = clientWith(
      ok(JSON.stringify({ context: "## Active Skills\n- skill-x", tokenEstimate: 42 })),
    );
    const boot = await client.bootstrap({ maxTokens: 1234 });
    expect(boot).toEqual({ context: "## Active Skills\n- skill-x", tokenEstimate: 42 });

    const req = captured[0];
    expect(req?.method).toBe("POST");
    expect(req?.url).toBe("http://127.0.0.1:9926/BootstrapMemories");
    expect(JSON.parse(req?.body ?? "{}")).toEqual({ agentId: "pulse", maxTokens: 1234 });
    expect(req?.headers.Authorization?.startsWith("TPS-Ed25519 pulse:")).toBe(true);
  });

  it("forwards channel, surface and includeSoul only when set", async () => {
    const { client, captured } = clientWith(ok(JSON.stringify({ context: "c" })));
    await client.bootstrap({ channel: "discord", surface: "cli-session", includeSoul: false });
    expect(JSON.parse(captured[0]?.body ?? "{}")).toEqual({
      agentId: "pulse",
      channel: "discord",
      surface: "cli-session",
      includeSoul: false,
    });
  });

  it("a non-2xx is an http_error carrying the status, and never the server body", async () => {
    const { client } = clientWith(async () => ({
      ok: false,
      status: 500,
      text: async () => "boom: Authorization: TPS-Ed25519 pulse:1:2:secret-sig",
    }));
    let err: unknown;
    try {
      await client.bootstrap({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FlairBootstrapError);
    const e = err as FlairBootstrapError;
    expect(e.failure).toBe("http_error");
    expect(e.status).toBe(500);
    expect(e.message).not.toContain("secret-sig");
    expect(e.message).not.toContain("boom");
  });

  it("a rejected transport is an unreachable failure", async () => {
    const { client } = clientWith(async () => {
      throw new Error("ECONNREFUSED");
    });
    let err: unknown;
    try {
      await client.bootstrap({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FlairBootstrapError);
    expect((err as FlairBootstrapError).failure).toBe("unreachable");
  });

  it("a body that is not JSON is an invalid_response", async () => {
    const { client } = clientWith(ok("not json at all"));
    await expect(client.bootstrap({})).rejects.toThrow(FlairBootstrapError);
    await client.bootstrap({}).catch((e: FlairBootstrapError) => {
      expect(e.failure).toBe("invalid_response");
    });
  });

  it("a JSON object with no context string is an invalid_response", async () => {
    const { client } = clientWith(ok(JSON.stringify({ tokenEstimate: 10 })));
    await client.bootstrap({}).catch((e: FlairBootstrapError) => {
      expect(e.failure).toBe("invalid_response");
    });
    let err: unknown;
    try {
      await client.bootstrap({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FlairBootstrapError);
  });

  it("an empty body is an invalid_response, not an empty context", async () => {
    const { client } = clientWith(ok(""));
    let err: unknown;
    try {
      await client.bootstrap({});
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FlairBootstrapError);
    expect((err as FlairBootstrapError).failure).toBe("invalid_response");
  });
});
