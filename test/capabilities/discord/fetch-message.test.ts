// The message lookup the turn binding relies on (bob#227), driven through the
// REAL DiscordJsClient and its real @discordjs/rest manager. Only the transport
// is stubbed: the runtime's global `fetch`, which the client's own REST request
// function (makeDiscordRestRequest) calls. The REST API base is pointed at an
// `.invalid` host as well, so a request can never reach Discord even if the
// stub were bypassed.
//
// DiscordJsClient.fetchMessage's contract:
//   * the lookup asks for the message in the given (bound) channel;
//   * a 404 means "not in this channel" and resolves null;
//   * every other failure (403, a surfaced 429, a 5xx, a transport error) is
//     THROWN, never turned into null.
// And at the capability level, a message the lookup returns from ANOTHER
// channel is refused, exactly like a message that is not found.
import { describe, expect, it } from "bun:test";
import { DiscordAPIError, HTTPError, RateLimitError } from "discord.js";
import {
  type PiLike,
  wireDiscordCapability,
} from "../../../src/capabilities/discord/capability.js";
import { DiscordJsClient } from "../../../src/capabilities/discord/discord-js-client.js";

const API = "http://discord.invalid/api";
const BOUND_CHANNEL = "111111111111111111";
const OTHER_CHANNEL = "222222222222222222";
const MESSAGE_ID = "333333333333333333";

// The inner discord.js client (and its REST manager) is private. The tests
// reach it to point the client at a non-routable base, as rest-request.test.ts
// and the capability's fixture harness do.
interface RestInternals {
  client: {
    rest: {
      options: {
        api: string;
        rejectOnRateLimit: ((data: unknown) => boolean) | null;
      };
    };
  };
}

interface RecordedRequest {
  method: string;
  path: string;
  authorization: string | null;
}

// Replace the global fetch for the duration of `run`. `respond` receives the
// 1-based request number and the parsed URL, and returns the response (or
// throws, to model a transport failure).
async function withStubbedFetch<T>(
  respond: (n: number, url: URL, method: string) => Response | Promise<Response>,
  run: (requests: RecordedRequest[]) => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  const requests: RecordedRequest[] = [];
  const stub = (async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    requests.push({
      method,
      path: url.pathname,
      authorization: new Headers(init?.headers).get("authorization"),
    });
    return respond(requests.length, url, method);
  }) as typeof fetch;
  (globalThis as { fetch: typeof fetch }).fetch = stub;
  try {
    return await run(requests);
  } finally {
    (globalThis as { fetch: typeof fetch }).fetch = originalFetch;
  }
}

function realClient(): DiscordJsClient {
  const client = new DiscordJsClient({ token: "tok", botUserId: "999" });
  (client as unknown as RestInternals).client.rest.options.api = API;
  return client;
}

function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

// A raw Discord API message (snake_case), as GET /channels/:c/messages/:m returns it.
function rawMessage(channelId: string) {
  return {
    id: MESSAGE_ID,
    channel_id: channelId,
    guild_id: "444444444444444444",
    author: { id: "555", username: "alice" },
    content: "hello",
    mentions: [{ id: "999" }],
  };
}

// Settle a promise into its value or its rejection, so a test can assert on the
// error itself (not only that one was thrown).
async function settle<T>(p: Promise<T>): Promise<{ value?: T; error?: unknown }> {
  try {
    return { value: await p };
  } catch (error) {
    return { error };
  }
}

describe("DiscordJsClient.fetchMessage — through the real REST manager", () => {
  it("(a) asks for the message in the bound channel: GET /channels/<channel>/messages/<message>", async () => {
    await withStubbedFetch(
      () => json(rawMessage(BOUND_CHANNEL), 200),
      async (requests) => {
        const found = await realClient().fetchMessage(BOUND_CHANNEL, MESSAGE_ID);
        expect(requests).toEqual([
          {
            method: "GET",
            path: `/api/v10/channels/${BOUND_CHANNEL}/messages/${MESSAGE_ID}`,
            authorization: "Bot tok",
          },
        ]);
        expect(found).toEqual({
          id: MESSAGE_ID,
          channelId: BOUND_CHANNEL,
          authorId: "555",
          authorName: "alice",
          content: "hello",
          mentionsBot: true,
          guildId: "444444444444444444",
        });
      },
    );
  });

  it("(b) a 404 resolves null (the message is not in this channel)", async () => {
    await withStubbedFetch(
      () => json({ message: "Unknown Message", code: 10008 }, 404),
      async (requests) => {
        expect(await realClient().fetchMessage(BOUND_CHANNEL, MESSAGE_ID)).toBeNull();
        expect(requests).toHaveLength(1);
      },
    );
  });

  it("(c) a 403 is thrown, not reported as not-found", async () => {
    await withStubbedFetch(
      () => json({ message: "Missing Access", code: 50001 }, 403),
      async () => {
        const { value, error } = await settle(realClient().fetchMessage(BOUND_CHANNEL, MESSAGE_ID));
        expect(value).toBeUndefined();
        expect(error).toBeInstanceOf(DiscordAPIError);
        expect((error as DiscordAPIError).status).toBe(403);
      },
    );
  });

  for (const status of [500, 502, 503]) {
    it(`(c) a ${status} is thrown once the REST manager's retries are spent, not reported as not-found`, async () => {
      await withStubbedFetch(
        () => json({ message: "upstream failure" }, status),
        async (requests) => {
          const { value, error } = await settle(
            realClient().fetchMessage(BOUND_CHANNEL, MESSAGE_ID),
          );
          expect(value).toBeUndefined();
          expect(error).toBeInstanceOf(HTTPError);
          expect((error as HTTPError).status).toBe(status);
          // The manager retried before giving up; every attempt asked the same path.
          expect(requests.length).toBeGreaterThan(1);
          for (const r of requests) {
            expect(r.path).toBe(`/api/v10/channels/${BOUND_CHANNEL}/messages/${MESSAGE_ID}`);
          }
        },
      );
    });
  }

  // A 429 does not reach fetchMessage as a failure in the client as constructed:
  // @discordjs/rest waits out Retry-After and asks again. These two pin both
  // halves: a 429 is never read as "absent", and a 429 the manager DOES surface
  // (rejectOnRateLimit) is thrown, not turned into null.
  it("(c) a 429 is retried after Retry-After and resolves with the real answer, never null", async () => {
    await withStubbedFetch(
      (n) =>
        n === 1
          ? json({ message: "You are being rate limited.", retry_after: 0, global: false }, 429, {
              "retry-after": "0",
            })
          : json(rawMessage(BOUND_CHANNEL), 200),
      async (requests) => {
        const found = await realClient().fetchMessage(BOUND_CHANNEL, MESSAGE_ID);
        expect(found?.id).toBe(MESSAGE_ID);
        expect(found?.channelId).toBe(BOUND_CHANNEL);
        expect(requests).toHaveLength(2);
      },
    );
  });

  it("(c) a 429 the REST manager surfaces as an error is thrown, not reported as not-found", async () => {
    await withStubbedFetch(
      () =>
        json({ message: "You are being rate limited.", retry_after: 5, global: false }, 429, {
          "retry-after": "5",
        }),
      async (requests) => {
        const client = realClient();
        (client as unknown as RestInternals).client.rest.options.rejectOnRateLimit = () => true;
        const { value, error } = await settle(client.fetchMessage(BOUND_CHANNEL, MESSAGE_ID));
        expect(value).toBeUndefined();
        expect(error).toBeInstanceOf(RateLimitError);
        expect(requests).toHaveLength(1);
      },
    );
  });

  it("(d) a transport failure is thrown, not reported as not-found", async () => {
    await withStubbedFetch(
      () => {
        throw new TypeError("fetch failed");
      },
      async (requests) => {
        const { value, error } = await settle(realClient().fetchMessage(BOUND_CHANNEL, MESSAGE_ID));
        expect(value).toBeUndefined();
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toBe("fetch failed");
        expect(requests).toHaveLength(1);
      },
    );
  });

  it("(d) a connection reset is retried and then thrown, not reported as not-found", async () => {
    await withStubbedFetch(
      () => {
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      },
      async (requests) => {
        const { value, error } = await settle(realClient().fetchMessage(BOUND_CHANNEL, MESSAGE_ID));
        expect(value).toBeUndefined();
        expect((error as { code?: string }).code).toBe("ECONNRESET");
        expect(requests.length).toBeGreaterThan(1);
      },
    );
  });
});

// (e) The capability, wired to the REAL client, during a discord turn bound to
// BOUND_CHANNEL. The lookup answers 200 with a message whose channel_id names
// another channel: the capability must refuse it and send nothing.
describe("the turn binding refuses a looked-up message from another channel (real client)", () => {
  type ToolDef = Parameters<PiLike["registerTool"]>[0];

  function wire(client: DiscordJsClient) {
    const tools = new Map<string, ToolDef>();
    const pi: PiLike = {
      registerTool: (tool) => {
        tools.set(tool.name, tool);
      },
      on: () => {},
    };
    wireDiscordCapability({
      pi,
      client,
      config: {
        tokenFile: "/secrets/bot.token",
        channelIds: [BOUND_CHANNEL, OTHER_CHANNEL],
        dispatchAll: false,
      },
      readOrigin: () => ({ kind: "discord", channelId: BOUND_CHANNEL }),
      log: () => {},
    });
    return (name: string, params: Record<string, unknown>) => {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool ${name} not registered`);
      return tool.execute(`call-${name}`, params);
    };
  }

  const LOOKUP = `/api/v10/channels/${BOUND_CHANNEL}/messages/${MESSAGE_ID}`;
  const refusal = new RegExp(
    `refusing message ${MESSAGE_ID}: it cannot be shown to belong to this turn's channel ${BOUND_CHANNEL}`,
  );

  // Answer the lookup with a message in `lookupChannel`; accept any write.
  const respondWith = (lookupChannel: string) => (_n: number, _url: URL, method: string) =>
    method === "GET" ? json(rawMessage(lookupChannel), 200) : json({}, 200);

  it("discord_reply's replyTo is refused and nothing is posted", async () => {
    await withStubbedFetch(respondWith(OTHER_CHANNEL), async (requests) => {
      const call = wire(realClient());
      await expect(
        call("discord_reply", { channelId: BOUND_CHANNEL, text: "x", replyTo: MESSAGE_ID }),
      ).rejects.toThrow(refusal);
      expect(requests).toEqual([{ method: "GET", path: LOOKUP, authorization: "Bot tok" }]);
    });
  });

  it("discord_react's messageId is refused and no reaction is put", async () => {
    await withStubbedFetch(respondWith(OTHER_CHANNEL), async (requests) => {
      const call = wire(realClient());
      await expect(
        call("discord_react", { channelId: BOUND_CHANNEL, messageId: MESSAGE_ID, emoji: "✅" }),
      ).rejects.toThrow(refusal);
      expect(requests).toEqual([{ method: "GET", path: LOOKUP, authorization: "Bot tok" }]);
    });
  });

  it("control: the same lookup answering with the bound channel lets the reply through", async () => {
    await withStubbedFetch(respondWith(BOUND_CHANNEL), async (requests) => {
      const call = wire(realClient());
      await call("discord_reply", { channelId: BOUND_CHANNEL, text: "x", replyTo: MESSAGE_ID });
      expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        `GET ${LOOKUP}`,
        `POST /api/v10/channels/${BOUND_CHANNEL}/messages`,
      ]);
    });
  });

  it("a lookup that fails (403) refuses with the real error and posts nothing", async () => {
    await withStubbedFetch(
      () => json({ message: "Missing Access", code: 50001 }, 403),
      async (requests) => {
        const call = wire(realClient());
        await expect(
          call("discord_reply", { channelId: BOUND_CHANNEL, text: "x", replyTo: MESSAGE_ID }),
        ).rejects.toThrow(/Missing Access/);
        expect(requests.map((r) => r.method)).toEqual(["GET"]);
      },
    );
  });
});
