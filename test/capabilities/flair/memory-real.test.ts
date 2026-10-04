import { expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { FlairHttpClient } from "../../../src/capabilities/flair/client.js";

const url = process.env.BOB_TEST_FLAIR_URL;
const ownerId = process.env.BOB_TEST_FLAIR_OWNER_ID;
const ownerKey = process.env.BOB_TEST_FLAIR_OWNER_KEY;
const readerId = process.env.BOB_TEST_FLAIR_READER_ID;
const readerKey = process.env.BOB_TEST_FLAIR_READER_KEY;
const configured = !!(url && ownerId && ownerKey && readerId && readerKey);

it.skipIf(!configured)(
  "propagates real Flair's cross-owner PUT and private by-id refusals",
  async () => {
    if (!url || !ownerId || !ownerKey || !readerId || !readerKey)
      throw new Error("missing Flair test configuration");
    expect(ownerId).not.toBe(readerId);
    const owner = new FlairHttpClient({ url, agentId: ownerId, keyFile: ownerKey });
    const reader = new FlairHttpClient({ url, agentId: readerId, keyFile: readerKey });
    const id = `bob-pr-memory-contract-${randomUUID()}`;
    const bounds = { timeoutMs: 2_000, maxResponseBytes: 64 * 1024 };
    await expect(
      owner.write("private round", {
        id,
        visibility: "private",
        durability: "ephemeral",
        ...bounds,
      }),
    ).resolves.toEqual({ id });
    await expect(owner.get(id, bounds)).resolves.toMatchObject({
      id,
      agentId: ownerId,
      visibility: "private",
      content: "private round",
    });
    await expect(reader.get(id, bounds)).resolves.toBeNull();
    await expect(
      reader.write("cross-owner round", { id, authorId: ownerId, ...bounds }),
    ).rejects.toThrow("403");
    await expect(owner.get(id, bounds)).resolves.toMatchObject({ content: "private round" });
  },
);
