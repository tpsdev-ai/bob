import { mock } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  loadFlairPrivateKey,
  tpsEd25519AuthHeader,
} from "../../../src/capabilities/flair/client.js";
import {
  deriveEd25519PublicKeyBase64,
  normalizeEd25519PrivateKey,
} from "../../../src/lib/ed25519-key.js";
import { makeFakeFlair } from "../../shell/flair-fake.js";

const source = process.env.FLAIR_AUTH_SOURCE_DIR;
assert.ok(source, "FLAIR_AUTH_SOURCE_DIR is required");
const seed = Buffer.alloc(32, 7);
const key = loadFlairPrivateKey(seed, "contract-key");
const otherKey = loadFlairPrivateKey(Buffer.alloc(32, 9), "other-key");
const publicKey = deriveEd25519PublicKeyBase64(normalizeEd25519PrivateKey(seed, "contract-key"));
const agent: { id: string; publicKey: string; status?: unknown } = { id: "anvil", publicKey };
const rows = new Map<string, unknown>();
let gate: (request: Request, next: (request: Request) => Promise<Response>) => Promise<Response>;
mock.module("harper", () => ({
  databases: {
    flair: {
      Agent: { get: async (id: string) => (id === agent.id ? agent : null), search: () => [] },
      ReplayNonce: {
        expirationMS: 120_000,
        primaryStore: {
          tryLock: () => true,
          unlock: () => {},
          getEntry: (id: string) => rows.get(id),
        },
        put: (row: { id: string }) => rows.set(row.id, row),
      },
    },
  },
  server: {
    workerCount: 1,
    http: (handler: typeof gate) => {
      gate = handler;
    },
    getUser: async () => ({ role: { role: "flair_agent" } }),
  },
}));
mock.module(join(source, "resources/federation-crypto.ts"), () => ({
  FEDERATION_WINDOW_MS: 30_000,
  verifyBodySignatureFreshOnce: () => {
    throw new Error("unused federation path");
  },
}));
Object.assign(globalThis, { transaction: async (_context: unknown, fn: () => unknown) => fn() });
const { verifyAgentRequest } = await import(join(source, "resources/agent-auth.ts"));
const { agentReplayGuard } = await import(join(source, "resources/replay-store.ts"));
await import(join(source, "resources/auth-middleware.ts"));

const sign = (nonce: string, tsMs = Date.now(), signingKey = key, agentId = agent.id) =>
  tpsEd25519AuthHeader({
    agentId,
    key: signingKey,
    method: "PUT",
    path: "/Memory/row",
    tsMs,
    nonce,
  });
const request = (authorization: string) =>
  new Request("http://flair.test/Memory/row", {
    method: "PUT",
    headers: { Authorization: authorization },
    body: "{",
  });
const fake = makeFakeFlair({ agents: { anvil: agent } });
const send = (authorization: string) =>
  fake.fetchImpl("http://flair.test/Memory/row", {
    method: "PUT",
    headers: { Authorization: authorization },
    body: "{",
  });
let reached = false;
const next = async () => {
  reached = true;
  return new Response("{}");
};
for (const status of ["deactivated", "disabled", null, false]) {
  agent.status = status;
  for (const signingKey of [key, otherKey]) {
    const header = sign(`status-${String(status)}-${signingKey === key}`, Date.now(), signingKey);
    assert.equal(await verifyAgentRequest(request(header)), null);
    const real = await gate(request(header), next);
    const stub = await send(header);
    assert.equal(real.status, 401);
    assert.equal(stub.status, real.status);
    assert.equal(JSON.parse(await stub.text()).error, (await real.json()).error);
    assert.equal(reached, false);
    assert.equal(fake.memories.size, 0);
  }
}
delete agent.status;
for (const [header, error] of [
  [sign("stale", Date.now() - 60_000), "timestamp_out_of_window"],
  [sign("bad-key", Date.now(), otherKey), "invalid_signature"],
  [sign("unknown", Date.now(), key, "unknown"), "unknown_agent"],
]) {
  const real = await gate(request(header), next);
  assert.equal(real.status, 401);
  assert.equal((await real.json()).error, error);
  assert.equal(JSON.parse(await (await send(header)).text()).error, error);
  assert.equal(reached, false);
}
agentReplayGuard.resetCacheForTest();
rows.clear();
const header = sign("single-use");
assert.equal((await verifyAgentRequest(request(header)))?.agentId, "anvil");
assert.equal(await verifyAgentRequest(request(header)), null);
assert.equal((await gate(request(header), next)).status, 401);
assert.equal(reached, false);
