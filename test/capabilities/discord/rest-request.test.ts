// Focused tests for the discord capability's REST request wrapper
// (makeDiscordRestRequest) — the function this binding hands to discord.js's
// REST manager. They pin the two deliberate transport decisions:
//   * a dispatcher the manager supplies is ignored, not forwarded; and
//   * a redirect is refused, so an authenticated call cannot leave the process
//     unauthenticated on a cross-origin 3xx.
// The wrapper uses the runtime's global fetch, which these exercise directly.
import { describe, expect, it } from "bun:test";
import {
  copyStringHeaders,
  DiscordJsClient,
  makeDiscordRestRequest,
} from "../../../src/capabilities/discord/discord-js-client.js";

type MakeRequestInit = Parameters<typeof makeDiscordRestRequest>[1];
// The inner discord.js client (and its REST manager) is private. The tests
// reach it to point the client at a local server, as the capability's own
// fixture harness does.
interface RestInternals {
  client: { rest: { options: { api: string } } };
}

describe("makeDiscordRestRequest — the dispatcher decision", () => {
  it("never forwards a dispatcher the REST manager supplies", async () => {
    const originalFetch = globalThis.fetch;
    let forwarded: { dispatcher?: unknown } | undefined;
    const stub = (async (...args: unknown[]) => {
      forwarded = (args[1] ?? {}) as { dispatcher?: unknown };
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = stub;
    try {
      const res = await makeDiscordRestRequest("http://discord.invalid/v10/x", {
        method: "GET",
        headers: { authorization: "Bot tok" },
        // An npm-undici agent is the shape @discordjs/rest would pass. Node's
        // global fetch rejects a foreign dispatcher, so the wrapper must drop
        // it rather than forward it.
        dispatcher: { fake: "dispatcher" },
      } as unknown as MakeRequestInit);
      expect(res.status).toBe(200);
      expect(forwarded?.dispatcher).toBeUndefined();
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
});

describe("makeDiscordRestRequest — redirects", () => {
  it("refuses a 3xx, and the redirect target receives NO request", async () => {
    let targetHits = 0;
    const target = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        targetHits += 1;
        return Response.json({ leaked: true });
      },
    });
    const origin = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(null, {
          status: 302,
          headers: { location: `http://127.0.0.1:${target.port}/next` },
        });
      },
    });
    try {
      const client = new DiscordJsClient({ token: "tok", botUserId: "1" });
      (client as unknown as RestInternals).client.rest.options.api =
        `http://127.0.0.1:${origin.port}`;

      // Capture the rejection once (the client rejects with the wrapper's
      // redirect refusal; there is no response to resolve with).
      const error = await client.fetchRecent("123456", 5).then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/HTTP 302/);
      expect((error as Error).message).toContain(`127.0.0.1:${target.port}`);
      // The redirect was not followed, so the other origin was never contacted.
      expect(targetHits).toBe(0);
    } finally {
      origin.stop(true);
      target.stop(true);
    }
  });
});

describe("makeDiscordRestRequest — a refused redirect releases its body", () => {
  it("cancels the 3xx response body before rejecting", async () => {
    const originalFetch = globalThis.fetch;
    let cancelled = false;
    const stub = (async () => {
      const body = new ReadableStream({
        pull() {},
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, {
        status: 302,
        headers: { location: "http://elsewhere.invalid/" },
      });
    }) as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = stub;
    try {
      await expect(
        makeDiscordRestRequest("http://discord.invalid/v10/x", {
          method: "GET",
          headers: { authorization: "Bot tok" },
        } as unknown as MakeRequestInit),
      ).rejects.toThrow(/HTTP 302/);
      expect(cancelled).toBe(true);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });

  it("still rejects with the redirect error when cancelling the body fails", async () => {
    const originalFetch = globalThis.fetch;
    const stub = (async () => {
      const body = new ReadableStream({
        pull() {},
        cancel() {
          throw new Error("cancel failed");
        },
      });
      return new Response(body, {
        status: 307,
        headers: { location: "http://elsewhere.invalid/" },
      });
    }) as typeof fetch;
    (globalThis as { fetch: typeof fetch }).fetch = stub;
    try {
      await expect(
        makeDiscordRestRequest("http://discord.invalid/v10/x", {
          method: "GET",
          headers: { authorization: "Bot tok" },
        } as unknown as MakeRequestInit),
      ).rejects.toThrow(/HTTP 307 to elsewhere\.invalid/);
    } finally {
      (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
    }
  });
});

describe("copyStringHeaders — every HeadersInit form", () => {
  it("keeps string headers from a plain object, a Headers instance and pairs", () => {
    const fromObject = copyStringHeaders({ authorization: "Bot tok", "x-a": "1" });
    const fromHeaders = copyStringHeaders(new Headers({ authorization: "Bot tok", "x-a": "1" }));
    const fromPairs = copyStringHeaders([
      ["authorization", "Bot tok"],
      ["x-a", "1"],
    ]);
    for (const h of [fromObject, fromHeaders, fromPairs]) {
      expect(h.get("authorization")).toBe("Bot tok");
      expect(h.get("x-a")).toBe("1");
    }
  });

  it("drops symbol keys and non-string values", () => {
    const raw: Record<string | symbol, unknown> = { "x-ok": "yes", "x-num": 7 };
    raw[Symbol("sensitiveHeaders")] = ["authorization"];
    const h = copyStringHeaders(raw);
    expect(h.get("x-ok")).toBe("yes");
    expect(h.has("x-num")).toBe(false);
  });
});
