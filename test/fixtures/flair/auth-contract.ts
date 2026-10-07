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
      Memory: { get: async () => null },
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
for (const field of ["signature", "publicKey"]) {
  for (const encoding of ["appended !", "wrong padding", "non-base64 character"]) {
    const header = sign(`${field}-${encoding.replaceAll(" ", "-")}`);
    const split = header.lastIndexOf(":") + 1;
    const original = field === "signature" ? header.slice(split) : publicKey;
    const malformed =
      encoding === "appended !"
        ? `${original}!`
        : encoding === "wrong padding"
          ? `${original}===`
          : `${original.slice(0, 8)}@${original.slice(8)}`;
    agent.publicKey = field === "publicKey" ? malformed : publicKey;
    const authorization = field === "signature" ? header.slice(0, split) + malformed : header;
    assert.equal(await verifyAgentRequest(request(authorization)), null);
    const real = await gate(request(authorization), next);
    assert.equal(real.status, 401);
    assert.equal((await real.json()).error, "signature_verification_failed");
    const stub = await fake.fetchImpl("http://flair.test/Memory/row", {
      method: "PUT",
      headers: { Authorization: authorization },
      body: JSON.stringify({ id: "row", agentId: agent.id, content: "malformed encoding" }),
    });
    assert.equal(stub.status, real.status);
    assert.equal(JSON.parse(await stub.text()).error, "signature_verification_failed");
    assert.equal(reached, false);
    assert.equal(fake.memories.size, 0);
  }
}
const refuse = async (authorization: string, error: string) => {
  assert.equal(await verifyAgentRequest(request(authorization)), null);
  const real = await gate(request(authorization), next);
  assert.equal(real.status, 401);
  assert.equal((await real.json()).error, error);
  const stub = await fake.fetchImpl("http://flair.test/Memory/row", {
    method: "PUT",
    headers: { Authorization: authorization },
    body: JSON.stringify({ id: "row", agentId: agent.id, content: "decode refusal" }),
  });
  assert.equal(stub.status, 401);
  assert.equal(JSON.parse(await stub.text()).error, error);
  assert.equal(reached, false);
  assert.equal(fake.memories.size, 0);
};
for (const length of [31, 33]) {
  for (const encoding of ["base64", "base64url", "hex"] as const) {
    const raw = Buffer.concat([Buffer.from(publicKey, "base64"), Buffer.alloc(1)]).subarray(
      0,
      length,
    );
    agent.publicKey = raw.toString(encoding);
    await refuse(sign(`key-${length}-${encoding}`), "signature_verification_failed");
  }
}
agent.publicKey = publicKey;
for (const length of [1, 63, 65]) {
  const header = sign(`signature-${length}`);
  const split = header.lastIndexOf(":") + 1;
  const raw = Buffer.concat([Buffer.from(header.slice(split), "base64"), Buffer.alloc(1)]);
  await refuse(
    header.slice(0, split) + raw.subarray(0, length).toString("base64"),
    "invalid_signature",
  );
}
const hexHeader = sign("signature-hex");
const hexSplit = hexHeader.lastIndexOf(":") + 1;
await refuse(
  hexHeader.slice(0, hexSplit) + Buffer.from(hexHeader.slice(hexSplit), "base64").toString("hex"),
  "invalid_signature",
);
agent.publicKey = publicKey;
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
const rawKey = Buffer.from(publicKey, "base64");
for (const encodedKey of [
  publicKey,
  publicKey.replace(/=+$/, ""),
  rawKey.toString("base64url"),
  rawKey.toString("base64url") + "=",
  rawKey.toString("hex"),
  rawKey.toString("hex").toUpperCase(),
]) {
  agent.publicKey = encodedKey;
  for (const encoding of ["base64", "base64url", "unpadded base64", "padded base64url"]) {
    const header = sign(`accepted-${encodedKey}-${encoding.replaceAll(" ", "-")}`);
    const split = header.lastIndexOf(":") + 1;
    const raw = Buffer.from(header.slice(split), "base64");
    const signature =
      encoding === "unpadded base64"
        ? raw.toString("base64").replace(/=+$/, "")
        : encoding === "padded base64url"
          ? raw.toString("base64url") + "=="
          : raw.toString(encoding as BufferEncoding);
    const authorization = header.slice(0, split) + signature;
    assert.equal((await gate(request(authorization), next)).status, 200);
    assert.equal(reached, true);
    const stub = await fake.fetchImpl("http://flair.test/Memory/row", {
      method: "PUT",
      headers: { Authorization: authorization },
      body: JSON.stringify({ id: "row", agentId: agent.id, content: "accepted encoding" }),
    });
    assert.equal(stub.status, 200);
    assert.equal(fake.memories.get("row")?.content, "accepted encoding");
    reached = false;
    fake.memories.clear();
  }
}
agent.publicKey = publicKey;
agentReplayGuard.resetCacheForTest();
rows.clear();
const header = sign("single-use");
assert.equal((await verifyAgentRequest(request(header)))?.agentId, "anvil");
assert.equal(await verifyAgentRequest(request(header)), null);
assert.equal((await gate(request(header), next)).status, 401);
assert.equal(reached, false);
