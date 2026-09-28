import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FlairRegistration } from "../../src/shell/flair-pair.js";
import { flairPair } from "../../src/shell/flair-pair.js";
import {
  pushSoulToFlair,
  readFlairSoul,
  SOUL_DIVERGENCE_BACKUP,
  SOUL_KEY_NAME,
  SOUL_KEY_PERSONA,
  SOUL_KEY_ROLE,
} from "../../src/shell/flair-soul.js";
import { makeFakeFlair } from "./flair-fake.js";

const FLAIR_URL = "http://127.0.0.1:19926";
const PERSONA = "# You are Testbot (`testbot`)\n\nYou are Testbot, a reviewer.\n";
const TEST_ADMIN_CREDENTIAL = "placeholder-not-a-real-admin-credential";

// The PUT that carries the persona (not the divergence GET on the same path).
function personaWrite(fake: ReturnType<typeof makeFakeFlair>) {
  return fake.calls.find(
    (c) => c.method === "PUT" && decodeURIComponent(c.path) === "/Soul/testbot:persona",
  );
}

describe("pushSoulToFlair (#94)", () => {
  let tmp: string;
  let keyFile: string;
  let pub: string;
  let soulPath: string;
  let warnings: string[];

  const registration = (): FlairRegistration => ({
    agentId: "testbot",
    flairUrl: FLAIR_URL,
    outcome: "created",
  });

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bob-soul-"));
    const pair = flairPair({ name: "testbot", keysDir: tmp });
    keyFile = pair.privateKeyPath;
    pub = pair.publicKeyBase64;
    soulPath = join(tmp, "soul.md");
    writeFileSync(soulPath, PERSONA);
    writeFileSync(join(tmp, "admin-pass"), `${TEST_ADMIN_CREDENTIAL}\n`, { mode: 0o600 });
    warnings = [];
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const registeredFake = () =>
    makeFakeFlair({ agents: { testbot: { id: "testbot", publicKey: pub } } });

  const push = (fake: ReturnType<typeof makeFakeFlair>, over: Record<string, unknown> = {}) =>
    pushSoulToFlair(registration(), {
      soulPath,
      displayName: "Testbot",
      role: "reviewer",
      keyFile,
      adminPassFile: join(tmp, "admin-pass"),
      fetchImpl: fake.fetchImpl,
      warn: (m) => warnings.push(m),
      ...over,
    });

  it("writes the persona into the Flair soul for the registered identity", async () => {
    const fake = registeredFake();
    const res = await push(fake);
    expect(fake.souls["testbot:persona"]).toBe(PERSONA);
    expect(res.entries.map((e) => e.key)).toEqual([SOUL_KEY_NAME, SOUL_KEY_ROLE, SOUL_KEY_PERSONA]);
    expect(res.entries.every((e) => e.id.startsWith("testbot:"))).toBe(true);
  });

  it("stamps the agent's own name and role alongside the persona (#89 pairing)", async () => {
    const fake = registeredFake();
    await push(fake);
    expect(fake.souls["testbot:name"]).toBe("Testbot");
    expect(fake.souls["testbot:role"]).toBe("reviewer");
  });

  it("writes each entry by PUT on <agentId>:<key> — a bare collection POST 405s", async () => {
    const fake = registeredFake();
    await push(fake);
    const writes = fake.calls.filter((c) => c.path.startsWith("/Soul/") && c.method === "PUT");
    expect(writes.map((c) => decodeURIComponent(c.path))).toEqual([
      "/Soul/testbot:name",
      "/Soul/testbot:role",
      "/Soul/testbot:persona",
    ]);
    // Nothing is ever POSTed to the /Soul collection.
    expect(fake.calls.some((c) => c.path === "/Soul" || c.path === "/Soul/")).toBe(false);
  });

  it("uses operator Basic auth for every write, and agent signing only for the divergence read", async () => {
    const fake = registeredFake();
    await push(fake);
    const calls = fake.calls.filter((c) => c.path.startsWith("/Soul/"));
    expect(calls[0].headers.Authorization).toMatch(/^TPS-Ed25519 testbot:/);
    expect(calls.filter((c) => c.method === "PUT")).toHaveLength(3);
    for (const write of calls.filter((c) => c.method === "PUT")) {
      expect(write.headers.Authorization).toBe(
        `Basic ${Buffer.from(`admin:${TEST_ADMIN_CREDENTIAL}`).toString("base64")}`,
      );
      expect(write.body?.agentId).toBe("testbot");
    }
  });

  it("marks soul entries permanent — identity must not age out of bootstrap", async () => {
    const fake = registeredFake();
    await push(fake);
    expect(personaWrite(fake)?.body?.durability).toBe("permanent");
  });

  it("is idempotent — a second push with the same file re-writes the same values", async () => {
    const fake = registeredFake();
    await push(fake);
    const first = await readFlairSoul(registration(), { keyFile, fetchImpl: fake.fetchImpl });
    const second = await push(fake);
    expect(second.diverged).toBe(false);
    expect(warnings).toEqual([]);
    expect(fake.souls["testbot:persona"]).toBe(first);
  });

  it("refuses to overwrite a good persona with an empty file", async () => {
    const fake = registeredFake();
    writeFileSync(soulPath, "   \n");
    await expect(push(fake)).rejects.toThrow(/empty/);
    expect(fake.souls["testbot:persona"]).toBeUndefined();
  });

  it("propagates a soul-write rejection rather than warning and continuing", async () => {
    // Unregistered agent → signed divergence read answers 401 unknown_agent.
    const fake = makeFakeFlair();
    await expect(push(fake)).rejects.toThrow(/401|unknown_agent/);
  });

  it("names actor, state, file and remedy when the operator password file is missing", async () => {
    const fake = registeredFake();
    const missing = join(tmp, "missing-admin-pass");
    const err = (await push(fake, { adminPassFile: missing }).catch((e) => e)) as Error;
    expect(err.message).toContain("cannot write Flair soul for 'testbot'");
    expect(err.message).toContain(missing);
    expect(err.message).toContain("could not be read");
    expect(err.message).toContain("flair init");
    expect(err.message).toContain("--admin-pass-file");
    expect(err.message).not.toContain(TEST_ADMIN_CREDENTIAL);
    expect(fake.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("reads the operator password file anew on each push", async () => {
    const fake = registeredFake();
    await push(fake);
    writeFileSync(join(tmp, "admin-pass"), "rotated-placeholder\n");
    const rotated = makeFakeFlair({
      agents: { testbot: { id: "testbot", publicKey: pub } },
      adminPassword: "rotated-placeholder",
    });
    await push(rotated);
    expect(rotated.souls["testbot:persona"]).toBe(PERSONA);
  });

  it("uses the supplied operator username for Basic auth", async () => {
    const fake = makeFakeFlair({
      agents: { testbot: { id: "testbot", publicKey: pub } },
      adminUser: "operator",
    });
    await push(fake, { adminUser: "operator" });
    expect(personaWrite(fake)?.headers.Authorization).toBe(
      `Basic ${Buffer.from(`operator:${TEST_ADMIN_CREDENTIAL}`).toString("base64")}`,
    );
  });

  describe("divergence (a local edit after onboard)", () => {
    it("local wins, and the superseded Flair copy is saved next to soul.md", async () => {
      const fake = registeredFake();
      fake.souls["testbot:persona"] = "# an older persona that only Flair has\n";
      const res = await push(fake);

      // Local wins: Flair now holds the local file.
      expect(fake.souls["testbot:persona"]).toBe(PERSONA);
      expect(res.diverged).toBe(true);
      // Lossless: what Flair held is on disk, not gone.
      const backup = join(tmp, SOUL_DIVERGENCE_BACKUP);
      expect(res.backupPath).toBe(backup);
      expect(existsSync(backup)).toBe(true);
      expect(readFileSync(backup, "utf8")).toBe("# an older persona that only Flair has\n");
    });

    it("warns, naming both sides and the backup — never silent", async () => {
      const fake = registeredFake();
      fake.souls["testbot:persona"] = "# divergent\n";
      await push(fake);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("soul divergence");
      expect(warnings[0]).toContain(soulPath);
      expect(warnings[0]).toContain(SOUL_DIVERGENCE_BACKUP);
    });

    it("does not warn or write a backup when the two agree", async () => {
      const fake = registeredFake();
      fake.souls["testbot:persona"] = PERSONA;
      const res = await push(fake);
      expect(res.diverged).toBe(false);
      expect(res.backupPath).toBeUndefined();
      expect(existsSync(join(tmp, SOUL_DIVERGENCE_BACKUP))).toBe(false);
      expect(warnings).toEqual([]);
    });

    it("reads BEFORE it writes — the check cannot be satisfied by its own write", async () => {
      const fake = registeredFake();
      fake.souls["testbot:persona"] = "# divergent\n";
      await push(fake);
      const soulCalls = fake.calls.filter((c) => c.path.startsWith("/Soul/"));
      expect(soulCalls[0].method).toBe("GET");
      expect(decodeURIComponent(soulCalls[0].path)).toBe("/Soul/testbot:persona");
    });
  });
});
