import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flairPair, registerWithFlair } from "../../src/shell/flair-pair.js";

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
  });

  it("force=true regenerates the keypair", () => {
    const first = flairPair({ name: "testbot", keysDir: tmpKeys });
    const second = flairPair({ name: "testbot", keysDir: tmpKeys, force: true });
    expect(second.publicKeyBase64).not.toBe(first.publicKeyBase64);
  });

  it("skips registration when no flairUrl is given", () => {
    const res = flairPair({ name: "testbot", keysDir: tmpKeys });
    expect(res.registered).toBe(false);
    expect(res.note).toContain("skipped");
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

describe("registerWithFlair (HTTP roundtrip)", () => {
  it("throws if admin pass file is missing", async () => {
    await expect(
      registerWithFlair({
        name: "testbot",
        publicKeyBase64: "AAAA",
        flairUrl: "http://127.0.0.1:9926",
        adminPassFile: "/nonexistent/path",
      }),
    ).rejects.toThrow(/admin pass file missing/);
  });
});
