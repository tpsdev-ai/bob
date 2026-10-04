import { describe, expect, it } from "bun:test";
import { FlairHttpClient } from "../../../src/capabilities/flair/client.js";
import { makeFakeFlair } from "../../shell/flair-fake.js";

const KEY = Buffer.alloc(32, 7);
const options = {
  url: "http://flair.test",
  agentId: "anvil",
  keyFile: "/unused",
  readFile: () => KEY,
  now: () => 1_700_000_000_000,
  uuid: () => "nonce",
};
type FetchImpl = NonNullable<ConstructorParameters<typeof FlairHttpClient>[0]["fetchImpl"]>;
const methods = ["GET", "PUT"] as const;
function request(
  client: FlairHttpClient,
  method: (typeof methods)[number],
  bounds: { timeoutMs?: number; maxResponseBytes?: number },
) {
  return method === "GET"
    ? client.get("row", bounds)
    : client.write("round", { id: "row", ...bounds });
}
const delay = () => new Promise<void>((resolve) => setTimeout(resolve, 80));

describe("Memory request bounds", () => {
  for (const method of methods) {
    for (const stage of ["headers", "body"] as const) {
      it(`${method} rejects when ${stage} arrive after the deadline`, async () => {
        let signal: AbortSignal | undefined;
        const fetchImpl: FetchImpl = async (_url, init) => {
          expect(init.method).toBe(method);
          signal = init.signal;
          if (stage === "headers") await delay();
          return new Response(
            new ReadableStream<Uint8Array>({
              async start(controller) {
                if (stage === "body") await delay();
                controller.enqueue(Buffer.from('{"id":"row"}'));
                controller.close();
              },
            }),
          );
        };
        await expect(
          request(new FlairHttpClient({ ...options, fetchImpl }), method, {
            timeoutMs: 20,
            maxResponseBytes: 64,
          }),
        ).rejects.toThrow("flair request timed out");
        expect(signal?.aborted).toBe(true);
      });
    }

    it(`${method} cancels a streamed response one byte over the bound`, async () => {
      let cancelled = false;
      const bytes = Buffer.from(JSON.stringify({ id: "row", content: "€".repeat(20) }));
      const fetchImpl: FetchImpl = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.subarray(0, bytes.length - 1));
              controller.enqueue(bytes.subarray(bytes.length - 1));
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      await expect(
        request(new FlairHttpClient({ ...options, fetchImpl }), method, {
          timeoutMs: 200,
          maxResponseBytes: bytes.length - 1,
        }),
      ).rejects.toThrow("flair response exceeded the size bound");
      expect(cancelled).toBe(true);
    });

    it(`${method} accepts a response at the byte bound`, async () => {
      const bytes = Buffer.from(JSON.stringify({ id: "row", content: "€".repeat(20) }));
      const fetchImpl: FetchImpl = async () => new Response(bytes);
      await expect(
        request(new FlairHttpClient({ ...options, fetchImpl }), method, {
          maxResponseBytes: bytes.length,
        }),
      ).resolves.toMatchObject({ id: "row" });
    });
  }

  it("GET refuses an oversized 404 before treating it as absent", async () => {
    const fetchImpl: FetchImpl = async () => new Response("x".repeat(65), { status: 404 });
    const client = new FlairHttpClient({ ...options, fetchImpl });
    await expect(client.get("row", { maxResponseBytes: 64 })).rejects.toThrow(
      "flair response exceeded the size bound",
    );
    await expect(client.get("row", { maxResponseBytes: 65 })).resolves.toBeNull();
  });
});

describe("Memory refusals from the Flair fake", () => {
  it("propagates a cross-owner PUT as a rejected write", async () => {
    const fake = makeFakeFlair({ agents: { anvil: { id: "anvil" }, kern: { id: "kern" } } });
    const client = new FlairHttpClient({ ...options, fetchImpl: fake.fetchImpl });
    await expect(client.write("round", { id: "row", authorId: "kern" })).rejects.toThrow("403");
    expect(fake.memories.has("row")).toBe(false);
    await expect(client.write("round", { id: "row", visibility: "private" })).resolves.toEqual({
      id: "row",
    });
  });

  it("returns null for another owner's private row without exposing it", async () => {
    const row = { id: "row", agentId: "kern", visibility: "private", content: "secret" };
    const fake = makeFakeFlair({
      agents: { anvil: { id: "anvil" }, kern: { id: "kern" } },
      memories: { row },
    });
    const client = new FlairHttpClient({ ...options, fetchImpl: fake.fetchImpl });
    await expect(client.get("row")).resolves.toBeNull();
    expect(fake.errorBodies).toHaveLength(1);
    expect(fake.calls[0]?.method).toBe("GET");
    const owner = new FlairHttpClient({ ...options, agentId: "kern", fetchImpl: fake.fetchImpl });
    await expect(owner.get("row")).resolves.toEqual(row);
    row.visibility = "shared";
    await expect(client.get("row")).resolves.toEqual(row);
  });
});

for (const body of ["", " ", "null"]) {
  it.each([{}, { timeoutMs: 200, maxResponseBytes: 64 }])(
    `Memory GET refuses ${JSON.stringify(body)} with bounds %j`,
    async (bounds) => {
      const client = new FlairHttpClient({ ...options, fetchImpl: async () => new Response(body) });
      await expect(client.get("row", bounds)).rejects.toThrow(/flair read returned/);
    },
  );
}

for (const reader of ["soulGet", "agentGet"] as const) {
  it.each([
    { body: "", status: 200 },
    { body: "null", status: 200 },
    { body: "", status: 404 },
  ])(`${reader} returns null for %j`, async ({ body, status }) => {
    const client = new FlairHttpClient({
      ...options,
      fetchImpl: async () => new Response(body, { status }),
    });
    await expect(client[reader]("role")).resolves.toBeNull();
  });
}
