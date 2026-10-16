// bob#356 round 2: the reachy audit and memory writes are OWNED by the
// authenticated agent. Flair's Memory owner guard refuses a body whose agentId
// is another agent (a non-admin signer); the HTTP double models that guard, and
// the real FlairHttpClient talks to it.
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FlairHttpClient } from "../../../src/capabilities/flair/client.js";
import { flairMemoryWriter, flairOrgEventStore } from "../../../src/capabilities/reachy/client.js";
import { type FlairDouble, startFlairDouble } from "./flair-double.js";

let dir: string;
let flair: FlairDouble;
let client: FlairHttpClient;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "rv-owner-"));
  const { privateKey } = generateKeyPairSync("ed25519");
  const keyFile = join(dir, "voicebot.key");
  writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  chmodSync(keyFile, 0o600);
  flair = await startFlairDouble({ voicebot: privateKey });
  client = new FlairHttpClient({ url: flair.url, agentId: "voicebot", keyFile });
});
afterAll(() => {
  flair.close();
  rmSync(dir, { recursive: true, force: true });
});

const event = {
  id: "evt_reachy.say_1",
  kind: "reachy.say",
  authorId: "jarvis", // the event's own label, inside its content
  summary: "admitted say (confidence 1)",
  targetIds: [],
  createdAt: new Date(0).toISOString(),
  nonce: "n",
  tsMs: 0,
};

describe("bob#356 round 2 — reachy's Flair writes are owned by the signing agent", () => {
  it("the OrgEvent store's write is accepted: its owner is the authenticated agent", async () => {
    await flairOrgEventStore(client).write(event);
    expect(flair.audits.at(-1)).toMatchObject({ kind: "reachy.say", owner: "voicebot" });
    expect(flair.refusals.filter((r) => r.status === 403)).toEqual([]);
  });

  it("the memory writer's write is accepted under the same owner", async () => {
    await flairMemoryWriter(client).writePrivate({
      content: "the fire drill is on Tuesday",
      visibility: "private",
      authorId: "jarvis",
      metadata: { speakerId: "spk-1", correlationId: "c", orgEventId: "o" },
    });
    expect(flair.refusals.filter((r) => r.status === 403)).toEqual([]);
  });

  it("CONTROL: a body owned by another agent (round 1's `authorId: jarvis`) is REFUSED by the guard", async () => {
    await expect(client.write(JSON.stringify(event), { authorId: "jarvis" })).rejects.toThrow();
    expect(flair.refusals.at(-1)).toMatchObject({ status: 403 });
    expect(flair.refusals.at(-1)?.reason).toContain(
      "owner jarvis is not the signing agent voicebot",
    );
  });
});
