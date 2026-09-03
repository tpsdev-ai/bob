import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADMIN_PASS_ENV, FlairAdminCredentialError } from "../../src/shell/flair-pair.js";
import {
  describeProvisioning,
  provisionFlairIdentity,
  syncFlairSoul,
} from "../../src/shell/flair-provision.js";
import { initAgent } from "../../src/shell/init.js";
import { makeFakeFlair } from "./flair-fake.js";

const TEST_ADMIN_CREDENTIAL = "placeholder-not-a-real-admin-credential";

// `bob onboard <name> --no-interactive` up to the point where the Flair work
// starts: a real scaffold on disk (real soul.md, real Ed25519 keypair), then
// provisioning against a fake Flair injected at bob's own fetch seam.
describe("provisionFlairIdentity — onboard --no-interactive (#93 + #94)", () => {
  let agentsRoot: string;
  let keysRoot: string;
  let scaffold: ReturnType<typeof initAgent>;

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-prov-agents-"));
    keysRoot = mkdtempSync(join(tmpdir(), "bob-prov-keys-"));
    scaffold = initAgent({
      name: "testbot",
      role: "reviewer",
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      agentsRoot,
      flairKeysDir: keysRoot,
    });
  });
  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
    rmSync(keysRoot, { recursive: true, force: true });
  });

  const provision = (
    fake: ReturnType<typeof makeFakeFlair>,
    over: Record<string, unknown> = {},
  ) => {
    const cfg = scaffold.flairConfig;
    if (!cfg) throw new Error("scaffold produced no flairConfig");
    return provisionFlairIdentity({
      name: "testbot",
      role: "reviewer",
      flairUrl: cfg.url,
      publicKeyBase64: scaffold.flair?.publicKeyBase64 ?? "",
      keyFile: cfg.keyPath,
      soulPath: join(scaffold.agentDir, "soul.md"),
      adminPassFile: join(keysRoot, "no-such-admin-pass"),
      env: { [ADMIN_PASS_ENV]: TEST_ADMIN_CREDENTIAL },
      fetchImpl: fake.fetchImpl,
      warn: () => {},
      ...over,
    });
  };

  it("registers an Agent record carrying the scaffolded public key", async () => {
    const fake = makeFakeFlair();
    const res = await provision(fake);
    expect(res.registration.outcome).toBe("created");
    expect(fake.agents.testbot.publicKey).toBe(scaffold.flair?.publicKeyBase64);
    // The key on disk and the key in Flair are the same key — the thing #93's
    // half-provisioned agent did not have.
    const pubOnDisk = readFileSync(join(keysRoot, "testbot.pub"), "utf8").trim();
    expect(fake.agents.testbot.publicKey).toBe(pubOnDisk);
  });

  it("writes the scaffolded soul.md into the Flair soul, verbatim", async () => {
    const fake = makeFakeFlair();
    await provision(fake);
    expect(fake.souls["testbot:persona"]).toBe(
      readFileSync(join(scaffold.agentDir, "soul.md"), "utf8"),
    );
    // Which means the identity header #89 stamps is now IN the substrate.
    expect(fake.souls["testbot:persona"]).toContain("You are Testbot (`testbot`)");
  });

  it("registers against the URL the scaffold actually wrote into bob.yaml", async () => {
    const fake = makeFakeFlair();
    await provision(fake);
    const yaml = readFileSync(join(scaffold.agentDir, "bob.yaml"), "utf8");
    expect(yaml).toContain(`url: ${scaffold.flairConfig?.url}`);
    // ops API is the REST port minus one, derived from that same value.
    expect(fake.calls[0].url).toBe("http://127.0.0.1:19925/");
  });

  // ─── THE ORDERING DEPENDENCY (#94 depends on #93) ────────────────────────
  //
  // Flair attributes a Soul row to the SIGNING identity and refuses a
  // signature it cannot resolve to an Agent record. A soul write in front of
  // registration is a 401, so the order is not a preference.
  it("registers BEFORE it writes the soul", async () => {
    const fake = makeFakeFlair();
    await provision(fake);
    const seq = fake.sequence();
    const registered = seq.indexOf("ops:insert:Agent");
    const firstSoulWrite = seq.findIndex((s) => s.startsWith("rest:PUT:/Soul"));
    expect(registered).toBeGreaterThanOrEqual(0);
    expect(firstSoulWrite).toBeGreaterThanOrEqual(0);
    expect(registered).toBeLessThan(firstSoulWrite);
  });

  it("no soul write EVER precedes the Agent record existing", async () => {
    const fake = makeFakeFlair();
    await provision(fake);
    // Replay the recorded calls and assert the invariant at every step, so
    // the assertion holds for each write rather than just the first one.
    let agentExists = false;
    for (const call of fake.calls) {
      if (call.op === "insert" && call.table === "Agent") agentExists = true;
      if (call.path.startsWith("/Soul/")) {
        expect(agentExists).toBe(true);
      }
    }
    expect(agentExists).toBe(true);
  });

  it("writes NOTHING at all when the soul write would fail — order is enforced end to end", async () => {
    // An instance that refuses the Soul PUT must not leave a half-done
    // provisioning that the caller reports as success.
    const fake = makeFakeFlair();
    await expect(
      provision(fake, {
        soulPath: join(scaffold.agentDir, "does-not-exist.md"),
      }),
    ).rejects.toThrow();
    expect(fake.souls["testbot:persona"]).toBeUndefined();
  });

  // ─── FAIL LOUDLY ON A MISSING CREDENTIAL ─────────────────────────────────
  it("throws — and writes no soul — when no admin credential is available", async () => {
    const fake = makeFakeFlair();
    let thrown: unknown;
    try {
      await provision(fake, { env: {} });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(FlairAdminCredentialError);
    // The load-bearing part: it did not "skip registration and carry on".
    expect(fake.calls.length).toBe(0);
    expect(Object.keys(fake.souls)).toEqual([]);
    expect(Object.keys(fake.agents)).toEqual([]);
  });

  it("the credential error names the agent, the env var, the file and the manual fix", async () => {
    const fake = makeFakeFlair();
    const err = (await provision(fake, { env: {} }).catch((e) => e)) as Error;
    expect(err.message).toContain("testbot");
    expect(err.message).toContain(ADMIN_PASS_ENV);
    expect(err.message).toContain("admin-pass");
    expect(err.message).toContain("flair agent add testbot");
  });

  // ─── IDEMPOTENT RE-RUN ────────────────────────────────────────────────────
  it("a second identical run is a no-op registration and rewrites the same soul", async () => {
    const fake = makeFakeFlair();
    await provision(fake);
    const soulAfterFirst = fake.souls["testbot:persona"];

    const second = await provision(fake);
    expect(second.registration.outcome).toBe("already-registered");
    expect(second.soul.diverged).toBe(false);
    expect(fake.souls["testbot:persona"]).toBe(soulAfterFirst);
    // No duplicate Agent row, and no second insert.
    expect(fake.sequence().filter((s) => s === "ops:insert:Agent").length).toBe(1);
    expect(Object.keys(fake.agents)).toEqual(["testbot"]);
  });

  it("a re-run after --force key regeneration REPAIRS the record instead of erroring", async () => {
    const fake = makeFakeFlair();
    await provision(fake);
    const rotated = initAgent({
      name: "testbot",
      role: "reviewer",
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      agentsRoot,
      flairKeysDir: keysRoot,
      noClobber: false,
    });
    // Simulate the operator having deleted the keys and re-onboarded: force a
    // brand-new keypair for the same name.
    rmSync(join(keysRoot, "testbot.key"));
    rmSync(join(keysRoot, "testbot.pub"));
    const regen = initAgent({
      name: "testbot",
      role: "reviewer",
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      agentsRoot,
      flairKeysDir: keysRoot,
      noClobber: false,
    });
    expect(regen.flair?.publicKeyBase64).not.toBe(rotated.flair?.publicKeyBase64);

    const res = await provision(fake, { publicKeyBase64: regen.flair?.publicKeyBase64 });
    expect(res.registration.outcome).toBe("repaired");
    expect(fake.agents.testbot.publicKey).toBe(regen.flair?.publicKeyBase64);
  });

  it("describeProvisioning names WHICH outcome happened, not a generic ok", async () => {
    const fake = makeFakeFlair();
    expect(describeProvisioning(await provision(fake))).toContain("Agent record created");
    expect(describeProvisioning(await provision(fake))).toContain("already present");

    const stale = makeFakeFlair({
      agents: { testbot: { id: "testbot", publicKey: "AAAAstaleAAAA" } },
    });
    expect(describeProvisioning(await provision(stale))).toContain("REPAIRED");
  });
});

describe("syncFlairSoul — bob align (#94)", () => {
  let agentsRoot: string;
  let keysRoot: string;
  let scaffold: ReturnType<typeof initAgent>;
  let warnings: string[];

  beforeEach(() => {
    agentsRoot = mkdtempSync(join(tmpdir(), "bob-align-agents-"));
    keysRoot = mkdtempSync(join(tmpdir(), "bob-align-keys-"));
    warnings = [];
    scaffold = initAgent({
      name: "testbot",
      role: "reviewer",
      provider: "ollama-cloud",
      model: "kimi-k2.6",
      agentsRoot,
      flairKeysDir: keysRoot,
    });
  });
  afterEach(() => {
    rmSync(agentsRoot, { recursive: true, force: true });
    rmSync(keysRoot, { recursive: true, force: true });
  });

  const sync = (fake: ReturnType<typeof makeFakeFlair>) =>
    syncFlairSoul({
      name: "testbot",
      role: "reviewer",
      flairUrl: scaffold.flairConfig?.url ?? "",
      keyFile: scaffold.flairConfig?.keyPath ?? "",
      soulPath: join(scaffold.agentDir, "soul.md"),
      fetchImpl: fake.fetchImpl,
      warn: (m) => warnings.push(m),
    });

  const registeredFake = () =>
    makeFakeFlair({
      agents: { testbot: { id: "testbot", publicKey: scaffold.flair?.publicKeyBase64 } },
    });

  it("pushes the revised persona without needing any admin credential", async () => {
    const fake = registeredFake();
    writeFileSync(join(scaffold.agentDir, "soul.md"), "# interviewed persona\n");
    await sync(fake);
    expect(fake.souls["testbot:persona"]).toBe("# interviewed persona\n");
    expect(fake.calls.every((c) => !/^Basic /.test(c.headers.Authorization ?? ""))).toBe(true);
  });

  it("verifies registration FIRST, and the verification precedes every soul call", async () => {
    const fake = registeredFake();
    await sync(fake);
    const seq = fake.sequence();
    expect(seq[0]).toBe("rest:GET:/Agent/testbot");
    expect(seq.slice(1).every((s) => s.includes("/Soul/"))).toBe(true);
  });

  it("refuses to write a soul for an identity Flair does not know", async () => {
    const fake = makeFakeFlair(); // no Agent row
    await expect(sync(fake)).rejects.toThrow(/not registered/);
    // And it stopped at the check — nothing was attempted against /Soul.
    expect(fake.calls.some((c) => c.path.startsWith("/Soul/"))).toBe(false);
  });

  it("surfaces a local edit made after onboard as a divergence, lossless", async () => {
    const fake = registeredFake();
    fake.souls["testbot:persona"] = "# what Flair had\n";
    writeFileSync(join(scaffold.agentDir, "soul.md"), "# edited locally after onboard\n");
    const res = await sync(fake);
    expect(res.soul.diverged).toBe(true);
    expect(fake.souls["testbot:persona"]).toBe("# edited locally after onboard\n");
    expect(readFileSync(res.soul.backupPath ?? "", "utf8")).toBe("# what Flair had\n");
    expect(warnings[0]).toContain("soul divergence");
  });
});
