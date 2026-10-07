import { expect, it } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  FlairHttpClient,
  loadFlairPrivateKey,
  tpsEd25519AuthHeader,
} from "../../../src/capabilities/flair/client.js";
import {
  PR_MEMORY_PRUNE_PROTECTION_MS,
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
    ).resolves.toMatchObject({ id });
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

// bob#318 — the round records of one fresh PR, written with the given clock.
function roundsFor(readerId: string, readerKey: string, url: string, now?: () => number) {
  const repository = `github.com/bob-contract/${randomUUID()}`;
  const key = loadFlairPrivateKey(readFileSync(readerKey), readerKey);
  const options = {
    target: { url, agentId: readerId, keyFile: readerKey },
    ref: { repository, number: 1 },
    identity: { agentId: readerId, repository, prNumber: 1 },
    seams: {
      ...(now !== undefined ? { now } : {}),
      fetchImpl: async (requestUrl: string, init: Parameters<typeof fetch>[1]) => {
        const parsed = new URL(requestUrl);
        return fetch(requestUrl, {
          ...init,
          headers: {
            ...init?.headers,
            Authorization: tpsEd25519AuthHeader({
              agentId: readerId,
              key,
              method: init?.method ?? "GET",
              path: parsed.pathname + parsed.search,
              tsMs: Date.now(),
              nonce: randomUUID(),
            }),
          },
        });
      },
    },
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
  const recalledDays = async () =>
    [...String((await recallPrMemoryRound(options)).block).matchAll(/day-(\d+)\.ts/g)].map((m) =>
      Number(m[1]),
    );
  const stored = async () =>
    (
      await new FlairHttpClient({ url, agentId: readerId, keyFile: readerKey }).listOwnBySubject(
        prMemoryKey(readerId, repository, 1),
        { limit: 8, timeoutMs: 2_000, maxResponseBytes: 512 * 1024 },
      )
    ).map((row) => Number(/day-(\d+)\.ts/.exec(String(row.content))?.[1]));
  return { options, write, recalledDays, stored };
}

it.skipIf(!configured)(
  "records and recalls concurrent rounds, then prunes aged rows (bob#318)",
  async () => {
    if (!url || !readerId || !readerKey) throw new Error("missing Flair test configuration");
    let at = Date.now();
    const pr = roundsFor(readerId, readerKey, url, () => at);
    const both = await Promise.all([pr.write(1), pr.write(2)]);
    expect(both.map((r) => r.status)).toEqual(["written", "written"]);
    expect((await pr.recalledDays()).sort()).toEqual([1, 2]);
    for (const day of [3, 4, 5, 6]) {
      at += PR_MEMORY_PRUNE_PROTECTION_MS + 1;
      expect((await pr.write(day)).status).toBe("written");
    }
    expect(await pr.stored()).toEqual([6, 5, 4]);
    expect(await pr.recalledDays()).toEqual([6, 5, 4]);
  },
  60_000,
);

it.skipIf(!configured)(
  "breaks a createdAt tie by id on a real Flair (bob#318)",
  async () => {
    if (!url || !readerId || !readerKey) throw new Error("missing Flair test configuration");
    const at = Date.now();
    const pr = roundsFor(readerId, readerKey, url, () => at);
    for (const day of [3, 1, 4, 2]) expect((await pr.write(day)).status).toBe("written");
    expect(await pr.stored()).toEqual([4, 3, 2, 1]);
    expect(await pr.recalledDays()).toEqual([4, 3, 2]);
  },
  60_000,
);

it.skipIf(!configured)(
  "keeps its own write under a createdAt tie on real Flair, then prunes on the next write",
  async () => {
    if (!url || !readerId || !readerKey) throw new Error("missing Flair test configuration");
    let at = Date.now();
    const pr = roundsFor(readerId, readerKey, url, () => at);
    for (const day of [4, 5, 6]) expect((await pr.write(day)).status).toBe("written");
    expect((await pr.write(1)).status).toBe("written");
    expect(await pr.stored()).toEqual([6, 5, 4, 1]);
    at += PR_MEMORY_PRUNE_PROTECTION_MS + 1;
    expect((await pr.write(7)).status).toBe("written");
    expect(await pr.stored()).toEqual([7, 6, 5]);
  },
  60_000,
);

it.skipIf(!configured)(
  "protects tied concurrent PUTs before either real Flair prune lists, then prunes aged rows",
  async () => {
    if (!url || !readerId || !readerKey) throw new Error("missing Flair test configuration");
    let at = Date.now();
    const pr = roundsFor(readerId, readerKey, url, () => at);
    for (const day of [4, 5, 6]) expect((await pr.write(day)).status).toBe("written");
    let completedPuts = 0;
    let release: () => void = () => {};
    const putsComplete = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deleted: string[] = [];
    const ids: string[] = [];
    const fetchImpl = pr.options.seams.fetchImpl;
    const options = {
      ...pr.options,
      seams: {
        ...pr.options.seams,
        fetchImpl: async (requestUrl: string, init: Parameters<typeof fetch>[1]) => {
          if (init?.method === "GET") await putsComplete;
          if (init?.method === "DELETE") deleted.push(new URL(requestUrl).pathname);
          const response = await fetchImpl(requestUrl, init);
          if (init?.method === "PUT") {
            expect(response.ok).toBe(true);
            ids.push(String(JSON.parse(String(init.body)).id));
            if (++completedPuts === 2) release();
          }
          return response;
        },
      },
    };
    const results = await Promise.all(
      [1, 2].map((day) =>
        writePrMemoryRound({
          ...options,
          evidence: {
            endedAt: `2026-10-0${day}T00:00:00.000Z`,
            outcome: "completed",
            filesTouched: [`day-${day}.ts`],
            testEvidence: [],
          },
        }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual(["written", "written"]);
    for (const id of ids) expect(deleted).not.toContain(`/Memory/${id}`);
    expect(await pr.stored()).toEqual([6, 5, 4, 2, 1]);
    at += PR_MEMORY_PRUNE_PROTECTION_MS + 1;
    expect((await pr.write(7)).status).toBe("written");
    expect(await pr.stored()).toEqual([7, 6, 5]);
  },
  60_000,
);
