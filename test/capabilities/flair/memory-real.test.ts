import { expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { FlairHttpClient } from "../../../src/capabilities/flair/client.js";
import {
  PR_MEMORY_RETAINED_ROUNDS,
  prMemoryKey,
  recallPrMemoryRound,
  writePrMemoryRound,
} from "../../../src/shell/pr-memory.js";

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
  "writes a PR-memory round beside another owner's row at the key, leaving it unchanged",
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
    ).toBe("written");
    await expect(owner.get(id, bounds)).resolves.toMatchObject({
      agentId: ownerId,
      content: "foreign history",
    });
    const listed = await reader.listOwnBySubject(id, { limit: 6, ...bounds });
    expect(listed.map((row) => String(row.id).startsWith(`${id}-r`))).toEqual([true]);
  },
  30_000,
);

it.skipIf(!configured)(
  "records and recalls two concurrent rounds and keeps the newest after a prune (bob#318)",
  async () => {
    if (!url || !readerId || !readerKey) throw new Error("missing Flair test configuration");
    const repository = `github.com/bob-contract/${randomUUID()}`;
    const target = { url, agentId: readerId, keyFile: readerKey };
    const options = {
      target,
      ref: { repository, number: 1 },
      identity: { agentId: readerId, repository, prNumber: 1 },
    };
    const write = (day: number) =>
      writePrMemoryRound({
        ...options,
        evidence: {
          runId: `run-${day}`,
          endedAt: `2026-10-0${day}T00:00:00.000Z`,
          outcome: "completed",
          filesTouched: [`day-${day}.ts`],
          testEvidence: [],
        },
      });
    const both = await Promise.all([write(1), write(2)]);
    expect(both.map((r) => r.status)).toEqual(["written", "written"]);
    const recalled = await recallPrMemoryRound(options);
    expect(recalled.status).toBe("recalled");
    expect(recalled.block).toContain("day-1.ts");
    expect(recalled.block).toContain("day-2.ts");

    for (const day of [3, 4, 5, 6]) expect((await write(day)).status).toBe("written");
    const reader = new FlairHttpClient({ url, agentId: readerId, keyFile: readerKey });
    const key = prMemoryKey(readerId, repository, 1);
    const kept = await reader.listOwnBySubject(key, {
      limit: 6,
      timeoutMs: 2_000,
      maxResponseBytes: 512 * 1024,
    });
    expect(kept).toHaveLength(PR_MEMORY_RETAINED_ROUNDS);
    const contents = kept.map((row) => String(row.content));
    for (const day of [3, 4, 5, 6])
      expect(contents.some((c) => c.includes(`day-${day}.ts`))).toBe(true);
    const latest = String((await recallPrMemoryRound(options)).block);
    expect(latest.indexOf("day-6.ts")).toBeGreaterThan(-1);
    expect(latest.indexOf("day-6.ts")).toBeLessThan(latest.indexOf("day-4.ts"));
    expect(latest).not.toContain("day-3.ts");
  },
  60_000,
);
