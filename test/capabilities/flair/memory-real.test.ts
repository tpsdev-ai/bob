import { expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { FlairHttpClient } from "../../../src/capabilities/flair/client.js";
import { prMemoryKey, writePrMemoryRound } from "../../../src/shell/pr-memory.js";

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

it.skipIf(!configured)(
  "skips a deterministic PR-memory write over another owner's stored row",
  async () => {
    if (!url || !ownerId || !ownerKey || !readerId || !readerKey)
      throw new Error("missing Flair test configuration");
    const repository = `github.com/bob-contract/${randomUUID()}`;
    const ref = { repository, number: 1 };
    const identity = { agentId: readerId, repository, prNumber: 1 };
    const id = prMemoryKey(readerId, repository, 1);
    const owner = new FlairHttpClient({ url, agentId: ownerId, keyFile: ownerKey });
    const reader = new FlairHttpClient({ url, agentId: readerId, keyFile: readerKey });
    const bounds = { timeoutMs: 2_000, maxResponseBytes: 64 * 1024 };
    await owner.write("foreign history", {
      id,
      visibility: "private",
      durability: "ephemeral",
      ...bounds,
    });
    await expect(reader.get(id, bounds)).resolves.toBeNull();
    await expect(reader.write("replacement", { id, ...bounds })).rejects.toThrow("403");
    expect(
      (
        await writePrMemoryRound({
          target: { url, agentId: readerId, keyFile: readerKey },
          ref,
          identity,
          evidence: { endedAt: "now", outcome: "completed", filesTouched: [], testEvidence: [] },
        })
      ).status,
    ).toBe("skipped");
    await expect(owner.get(id, bounds)).resolves.toMatchObject({
      agentId: ownerId,
      content: "foreign history",
    });
  },
);
