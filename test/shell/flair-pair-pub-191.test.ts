import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { flairPair } from "../../src/shell/flair-pair.js";

// bob#191: flair-pair must DERIVE the registered public key from the private
// key, never trust the .pub file's content. A Flair-minted .pub is RAW 32
// bytes; reading it as base64 text registers a key that cannot verify.

// A generated Ed25519 pair in the shapes the two writers actually produce.
function makePair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pkcs8 = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
  const seed = pkcs8.subarray(pkcs8.length - 32); // raw 32-byte seed (Flair's shape)
  const spki = publicKey.export({ format: "der", type: "spki" }) as Buffer;
  const pubRaw = spki.subarray(spki.length - 32); // raw 32-byte public key
  const pubBase64 = pubRaw.toString("base64");
  return { seed, pubRaw, pubBase64 };
}

describe("flairPair derives the public key from the private key (bob#191)", () => {
  let tmpKeys: string;
  let name: string;

  beforeEach(() => {
    tmpKeys = mkdtempSync(join(tmpdir(), "bob-keys-191-"));
    name = "testbot";
  });

  afterEach(() => {
    rmSync(tmpKeys, { recursive: true, force: true });
  });

  const privPath = () => join(tmpKeys, `${name}.key`);
  const pubPath = () => join(tmpKeys, `${name}.pub`);

  it("(p1) a Flair-style raw 32-byte .pub registers the correct public key", () => {
    const { seed, pubRaw, pubBase64 } = makePair();
    writeFileSync(privPath(), seed); // raw seed, as `flair agent add` writes it
    writeFileSync(pubPath(), pubRaw); // RAW 32 bytes, not base64 text

    const res = flairPair({ name, keysDir: tmpKeys });
    expect(res.publicKeyBase64).toBe(pubBase64);
  });

  it("(p2) a bob-style base64 .pub registers the same key as p1", () => {
    const { seed, pubBase64 } = makePair();
    writeFileSync(privPath(), seed);
    writeFileSync(pubPath(), `${pubBase64}\n`); // bob's own base64 shape

    const res = flairPair({ name, keysDir: tmpKeys });

    // Same key as the raw-bytes shape: read the file as BYTES and accept both
    // shapes. (Re-derive from the seed to prove it equals the .pub content.)
    const derived = createPublicKey(
      createPrivateKey({
        key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
        format: "der",
        type: "pkcs8",
      }),
    ).export({ format: "der", type: "spki" }) as Buffer;
    expect(res.publicKeyBase64).toBe(derived.subarray(derived.length - 32).toString("base64"));
    expect(res.publicKeyBase64).toBe(pubBase64);
  });

  it("(p3) a .pub that does not match the private key is refused, naming both files, with no key bytes", () => {
    const { seed } = makePair();
    const other = makePair(); // a DIFFERENT key
    writeFileSync(privPath(), seed);
    writeFileSync(pubPath(), other.pubRaw); // foreign public key

    let message = "";
    try {
      flairPair({ name, keysDir: tmpKeys });
      throw new Error("expected flairPair to refuse a mismatched .pub");
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toContain(pubPath()); // names the .pub file
    expect(message).toContain(privPath()); // names the private key file
    // No key material of EITHER file, in base64 or hex.
    const foreignBase64 = other.pubRaw.toString("base64");
    const derivedBase64 = createPublicKey(
      createPrivateKey({
        key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
        format: "der",
        type: "pkcs8",
      }),
    ).export({ format: "der", type: "spki" }) as Buffer;
    const selfBase64 = derivedBase64.subarray(derivedBase64.length - 32).toString("base64");
    expect(message).not.toContain(foreignBase64);
    expect(message).not.toContain(selfBase64);
    expect(message).not.toContain(other.pubRaw.toString("hex"));
    expect(message).not.toContain(seed.toString("hex"));
  });

  it("(p4) no .pub file: the derived key is used", () => {
    const { seed, pubBase64 } = makePair();
    writeFileSync(privPath(), seed); // no .pub written

    const res = flairPair({ name, keysDir: tmpKeys });
    expect(res.publicKeyBase64).toBe(pubBase64);
  });
});
