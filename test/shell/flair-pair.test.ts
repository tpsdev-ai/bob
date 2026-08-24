import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADMIN_PASS_ENV,
  checkFlairRegistration,
  FlairAdminCredentialError,
  flairPair,
  OPS_TARGET_ENV,
  registerWithFlair,
  resolveFlairAdminPass,
  resolveFlairOpsUrl,
  verifyRegisteredWithFlair,
} from "../../src/shell/flair-pair.js";
import { makeFakeFlair } from "./flair-fake.js";

// Obvious placeholder, never a real credential. Every assertion about it is
// about SHAPE (present / absent / not-echoed), never about the value meaning
// anything.
const TEST_ADMIN_CREDENTIAL = "placeholder-not-a-real-admin-credential";
const FLAIR_URL = "http://127.0.0.1:19926";

describe("flairPair (keypair generation)", () => {
  let tmpKeys: string;

  beforeEach(() => {
    tmpKeys = mkdtempSync(join(tmpdir(), "bob-keys-"));
  });

  afterEach(() => {
    rmSync(tmpKeys, { recursive: true, force: true });
  });

  it("generates an Ed25519 keypair on disk", () => {
    const res = flairPair({ name: "testbot", keysDir: tmpKeys });
    expect(existsSync(res.privateKeyPath)).toBe(true);
    expect(existsSync(res.publicKeyPath)).toBe(true);
    expect(res.publicKeyBase64).toMatch(/^[A-Za-z0-9+/=]+$/);
    // 32-byte Ed25519 pub key → 44-char base64 (with padding)
    expect(res.publicKeyBase64.length).toBe(44);
  });

  it("private key file is mode 0600", () => {
    const res = flairPair({ name: "testbot", keysDir: tmpKeys });
    const mode = statSync(res.privateKeyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("public key file is mode 0644", () => {
    const res = flairPair({ name: "testbot", keysDir: tmpKeys });
    const mode = statSync(res.publicKeyPath).mode & 0o777;
    expect(mode).toBe(0o644);
  });

  it("returns the existing keys on second call (idempotent)", () => {
    const first = flairPair({ name: "testbot", keysDir: tmpKeys });
    const second = flairPair({ name: "testbot", keysDir: tmpKeys });
    expect(second.publicKeyBase64).toBe(first.publicKeyBase64);
    expect(second.privateKeyPath).toBe(first.privateKeyPath);
    expect(first.generated).toBe(true);
    expect(second.generated).toBe(false);
  });

  it("force=true regenerates the keypair", () => {
    const first = flairPair({ name: "testbot", keysDir: tmpKeys });
    const second = flairPair({ name: "testbot", keysDir: tmpKeys, force: true });
    expect(second.publicKeyBase64).not.toBe(first.publicKeyBase64);
    expect(second.generated).toBe(true);
  });

  // #93: flairPair used to report on registration it had no code to perform
  // ("registration skipped"). A keypair function must not be able to say
  // anything about the Agent record at all — that is registerWithFlair's job,
  // and it either registers or throws.
  it("reports only on the keypair — no registration signal to ignore", () => {
    const res = flairPair({ name: "testbot", keysDir: tmpKeys }) as Record<string, unknown>;
    expect(Object.keys(res).sort()).toEqual([
      "generated",
      "privateKeyPath",
      "publicKeyBase64",
      "publicKeyPath",
    ]);
    expect(res.registered).toBeUndefined();
    expect(res.note).toBeUndefined();
  });

  it("rejects invalid agent names", () => {
    expect(() => flairPair({ name: "../etc", keysDir: tmpKeys })).toThrow(/invalid agent name/);
  });

  it("private key is PKCS8 PEM", () => {
    const res = flairPair({ name: "testbot", keysDir: tmpKeys });
    const pem = readFileSync(res.privateKeyPath, "utf8");
    expect(pem).toContain("-----BEGIN PRIVATE KEY-----");
    expect(pem).toContain("-----END PRIVATE KEY-----");
  });
});

describe("resolveFlairOpsUrl", () => {
  it("derives the ops port as REST port minus one (flair's convention)", () => {
    expect(resolveFlairOpsUrl("http://127.0.0.1:19926")).toBe("http://127.0.0.1:19925");
    expect(resolveFlairOpsUrl("http://127.0.0.1:9926")).toBe("http://127.0.0.1:9925");
  });

  it("uses 19925 when an http URL carries no explicit port", () => {
    expect(resolveFlairOpsUrl("http://flair.internal")).toBe("http://flair.internal:19925");
  });

  it("refuses to GUESS for an https URL on the implicit 443", () => {
    // A managed instance puts the ops API on a well-known port unrelated to
    // REST. Silently targeting :442 would be a plausible wrong answer.
    expect(() => resolveFlairOpsUrl("https://flair.example.com")).toThrow(
      new RegExp(OPS_TARGET_ENV),
    );
  });

  it("honours an explicit override", () => {
    expect(resolveFlairOpsUrl("http://127.0.0.1:19926", "http://ops.example:9999/")).toBe(
      "http://ops.example:9999",
    );
  });
});

describe("resolveFlairAdminPass", () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "bob-adminpass-"));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("prefers the environment over the file", () => {
    const file = join(tmp, "admin-pass");
    writeFileSync(file, "from-file-placeholder\n");
    const got = resolveFlairAdminPass({
      adminPassFile: file,
      env: { [ADMIN_PASS_ENV]: TEST_ADMIN_CREDENTIAL },
    });
    expect(got).toBe(TEST_ADMIN_CREDENTIAL);
  });

  it("falls back to the 0600 file flair init writes", () => {
    const file = join(tmp, "admin-pass");
    writeFileSync(file, `${TEST_ADMIN_CREDENTIAL}\n`);
    expect(resolveFlairAdminPass({ adminPassFile: file, env: {} })).toBe(TEST_ADMIN_CREDENTIAL);
  });

  it("returns undefined when neither is available", () => {
    expect(resolveFlairAdminPass({ adminPassFile: join(tmp, "nope"), env: {} })).toBeUndefined();
  });

  it("treats an empty file as no credential (not as an empty password)", () => {
    const file = join(tmp, "admin-pass");
    writeFileSync(file, "   \n");
    expect(resolveFlairAdminPass({ adminPassFile: file, env: {} })).toBeUndefined();
  });
});

describe("registerWithFlair", () => {
  let tmpKeys: string;
  let pub: string;

  beforeEach(() => {
    tmpKeys = mkdtempSync(join(tmpdir(), "bob-keys-"));
    pub = flairPair({ name: "testbot", keysDir: tmpKeys }).publicKeyBase64;
  });
  afterEach(() => {
    rmSync(tmpKeys, { recursive: true, force: true });
  });

  const args = (fake: ReturnType<typeof makeFakeFlair>, env: NodeJS.ProcessEnv = {}) => ({
    name: "testbot",
    publicKeyBase64: pub,
    flairUrl: FLAIR_URL,
    adminPassFile: join(tmpKeys, "no-such-admin-pass"),
    env: { [ADMIN_PASS_ENV]: TEST_ADMIN_CREDENTIAL, ...env },
    fetchImpl: fake.fetchImpl,
  });

  it("creates the Agent record when none exists, carrying the public key", async () => {
    const fake = makeFakeFlair();
    const reg = await registerWithFlair(args(fake));
    expect(reg.outcome).toBe("created");
    expect(fake.agents.testbot.publicKey).toBe(pub);
    // Seeded through the ops API — flair's only supported path for Agent rows
    // (REST's Agent.put() deletes publicKey outright).
    expect(fake.sequence()).toEqual(["ops:search_by_id:Agent", "ops:insert:Agent"]);
  });

  it("mirrors flair's Agent.post() defaults so the agent is visible to roster/presence", async () => {
    const fake = makeFakeFlair();
    await registerWithFlair(args(fake));
    const row = fake.agents.testbot;
    expect(row.kind).toBe("agent");
    expect(row.status).toBe("active");
    expect(row.type).toBe("agent");
    expect(row.admin).toBe(false);
    expect(row.defaultTrustTier).toBe("unverified");
  });

  it("is a true no-op when the record already carries this key", async () => {
    const fake = makeFakeFlair({ agents: { testbot: { id: "testbot", publicKey: pub } } });
    const reg = await registerWithFlair(args(fake));
    expect(reg.outcome).toBe("already-registered");
    expect(fake.sequence()).toEqual(["ops:search_by_id:Agent"]);
  });

  // The idempotence decision: DETECT-AND-REPAIR, not no-op. A record that
  // exists with the wrong key is the same broken state #93 describes — the
  // agent has an Agent row AND its signatures still fail.
  it("REPAIRS a record whose public key does not match the key on disk", async () => {
    const fake = makeFakeFlair({
      agents: { testbot: { id: "testbot", publicKey: "AAAAstalekeyAAAA" } },
    });
    const reg = await registerWithFlair(args(fake));
    expect(reg.outcome).toBe("repaired");
    expect(fake.agents.testbot.publicKey).toBe(pub);
    expect(fake.sequence()).toEqual(["ops:search_by_id:Agent", "ops:update:Agent"]);
  });

  it("repairs an AgentSeed row still holding the literal 'pending' placeholder", async () => {
    const fake = makeFakeFlair({
      agents: { testbot: { id: "testbot", publicKey: "pending" } },
    });
    const reg = await registerWithFlair(args(fake));
    expect(reg.outcome).toBe("repaired");
    expect(fake.agents.testbot.publicKey).toBe(pub);
  });

  it("reconciles when an insert is refused as a duplicate (200 + skipped_hashes)", async () => {
    const fake = makeFakeFlair();
    // Race: the row appears between our read and our write. The fake reports
    // it Harper's way — 200 with the id under skipped_hashes — so a caller
    // that trusted the STATUS would report a creation that never happened.
    const orig = fake.fetchImpl;
    let seenRead = false;
    const racing: typeof fake.fetchImpl = async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (body?.operation === "search_by_id" && !seenRead) {
        seenRead = true;
        fake.agents.testbot = { id: "testbot", publicKey: "AAAAotherkeyAAAA" };
        return { ok: true, status: 200, text: async () => "[]" };
      }
      return orig(url, init);
    };
    const reg = await registerWithFlair({ ...args(fake), fetchImpl: racing });
    expect(reg.outcome).toBe("repaired");
    expect(fake.agents.testbot.publicKey).toBe(pub);
  });

  // FAIL LOUDLY. The whole defect of #93 is a step that did not happen and
  // said nothing; a "skipped" return value here would be the same bug.
  it("throws FlairAdminCredentialError when no admin credential is available", async () => {
    const fake = makeFakeFlair();
    let thrown: unknown;
    try {
      await registerWithFlair({ ...args(fake), env: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FlairAdminCredentialError);
    expect(fake.calls.length).toBe(0); // never even reached the network
  });

  it("the missing-credential message names what is missing AND the manual fallback", async () => {
    const fake = makeFakeFlair();
    const err = await registerWithFlair({ ...args(fake), env: {} }).catch((e) => e as Error);
    const msg = (err as Error).message;
    expect(msg).toContain(ADMIN_PASS_ENV); // what to set
    expect(msg).toContain("admin-pass"); // where the file lives
    expect(msg).toContain("flair agent add testbot"); // the manual fallback
    expect(msg).toContain("--no-flair"); // the explicit opt-out
    expect(msg).toContain("testbot"); // which agent
  });

  it("sends the credential ONLY as a Basic header — never in a body or a URL", async () => {
    const fake = makeFakeFlair();
    await registerWithFlair(args(fake));
    for (const call of fake.calls) {
      expect(call.headers.Authorization).toMatch(/^Basic /);
      expect(call.url).not.toContain(TEST_ADMIN_CREDENTIAL);
      expect(JSON.stringify(call.body ?? {})).not.toContain(TEST_ADMIN_CREDENTIAL);
    }
  });

  it("never echoes the credential in an error message", async () => {
    const fake = makeFakeFlair({ opsStatus: 500 });
    const err = await registerWithFlair(args(fake)).catch((e) => e as Error);
    expect((err as Error).message).toContain("500");
    expect((err as Error).message).not.toContain(TEST_ADMIN_CREDENTIAL);
  });

  it("rejects invalid agent names before touching the network", async () => {
    const fake = makeFakeFlair();
    await expect(registerWithFlair({ ...args(fake), name: "../etc" })).rejects.toThrow(
      /invalid agent name/,
    );
    expect(fake.calls.length).toBe(0);
  });

  it("honours FLAIR_OPS_TARGET over the derived port", async () => {
    const fake = makeFakeFlair();
    await registerWithFlair(args(fake, { [OPS_TARGET_ENV]: "http://ops.example:4242" }));
    expect(fake.calls[0].url).toBe("http://ops.example:4242/");
  });
});

describe("checkFlairRegistration / verifyRegisteredWithFlair", () => {
  let tmpKeys: string;
  let keyFile: string;
  let pub: string;

  beforeEach(() => {
    tmpKeys = mkdtempSync(join(tmpdir(), "bob-keys-"));
    const pair = flairPair({ name: "testbot", keysDir: tmpKeys });
    keyFile = pair.privateKeyPath;
    pub = pair.publicKeyBase64;
  });
  afterEach(() => {
    rmSync(tmpKeys, { recursive: true, force: true });
  });

  it("reports registered for an existing agent — signed with the agent's OWN key", async () => {
    const fake = makeFakeFlair({ agents: { testbot: { id: "testbot", publicKey: pub } } });
    const res = await checkFlairRegistration({
      name: "testbot",
      flairUrl: FLAIR_URL,
      keyFile,
      fetchImpl: fake.fetchImpl,
    });
    expect(res.state).toBe("registered");
    // Signed as the agent — no admin credential anywhere on this path.
    expect(fake.calls[0].headers.Authorization).toMatch(/^TPS-Ed25519 testbot:/);
    expect(fake.calls.every((c) => !/^Basic /.test(c.headers.Authorization ?? ""))).toBe(true);
  });

  it("decodes Flair's 401 unknown_agent as not-registered (it is NOT a 404)", async () => {
    const fake = makeFakeFlair();
    const res = await checkFlairRegistration({
      name: "testbot",
      flairUrl: FLAIR_URL,
      keyFile,
      fetchImpl: fake.fetchImpl,
    });
    expect(res.state).toBe("not-registered");
  });

  it("does NOT claim not-registered on a bare 401 with no unknown_agent marker", async () => {
    const fetchImpl = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: "AccessViolation" }),
    });
    const res = await checkFlairRegistration({
      name: "testbot",
      flairUrl: FLAIR_URL,
      keyFile,
      fetchImpl,
    });
    expect(res.state).toBe("unreachable");
  });

  it("reports an unloadable key as unreachable-with-a-disk-reason, not a network fault", async () => {
    const bogus = join(tmpKeys, "bogus.key");
    writeFileSync(bogus, "not a key\n");
    const fake = makeFakeFlair();
    const res = await checkFlairRegistration({
      name: "testbot",
      flairUrl: FLAIR_URL,
      keyFile: bogus,
      fetchImpl: fake.fetchImpl,
    });
    expect(res.state).toBe("unreachable");
    expect(res.detail).toContain(bogus);
    expect(fake.calls.length).toBe(0); // signing failed before any request
  });

  it("verifyRegisteredWithFlair yields a registration token when registered", async () => {
    const fake = makeFakeFlair({ agents: { testbot: { id: "testbot", publicKey: pub } } });
    const reg = await verifyRegisteredWithFlair({
      name: "testbot",
      flairUrl: FLAIR_URL,
      keyFile,
      fetchImpl: fake.fetchImpl,
    });
    expect(reg.agentId).toBe("testbot");
    expect(reg.flairUrl).toBe(FLAIR_URL);
  });

  it("verifyRegisteredWithFlair throws with the fix when the agent is unknown", async () => {
    const fake = makeFakeFlair();
    const err = await verifyRegisteredWithFlair({
      name: "testbot",
      flairUrl: FLAIR_URL,
      keyFile,
      fetchImpl: fake.fetchImpl,
    }).catch((e) => e as Error);
    expect((err as Error).message).toContain("not registered");
    expect((err as Error).message).toContain("flair agent add testbot");
  });
});
