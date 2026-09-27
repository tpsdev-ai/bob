import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveEd25519PublicKeyBase64 } from "../../src/lib/ed25519-key.js";
import { createPubIfAbsent, flairPair } from "../../src/shell/flair-pair.js";

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

  it("(p1) a Flair-style raw 32-byte .pub yields the correct public key for registration", () => {
    const { seed, pubRaw, pubBase64 } = makePair();
    writeFileSync(privPath(), seed); // raw seed, as `flair agent add` writes it
    writeFileSync(pubPath(), pubRaw); // RAW 32 bytes, not base64 text

    const res = flairPair({ name, keysDir: tmpKeys });
    expect(res.publicKeyBase64).toBe(pubBase64);
  });

  it("(p2) a bob-style base64 .pub yields the public key derived from its private key", () => {
    const { seed, pubBase64 } = makePair();
    writeFileSync(privPath(), seed);
    writeFileSync(pubPath(), `${pubBase64}\n`); // bob's own base64 shape

    const res = flairPair({ name, keysDir: tmpKeys });

    // For this pair, the returned key equals the key encoded in its base64 .pub.
    // (Re-derive from the seed to prove it equals the .pub content.)
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

  it("(p4) no .pub file: the derived key is used and written as the .pub", () => {
    const { seed, pubBase64 } = makePair();
    writeFileSync(privPath(), seed); // no .pub written

    const res = flairPair({ name, keysDir: tmpKeys });
    expect(res.publicKeyBase64).toBe(pubBase64);
    expect(res.generated).toBe(false);
    expect(existsSync(pubPath())).toBe(true);
    expect(readFileSync(pubPath(), "utf8")).toBe(`${pubBase64}\n`);
  });

  it("(p5) the refusal's remedy works: delete the mismatched .pub, re-run, the derived key is used and rewritten", () => {
    const { seed, pubBase64 } = makePair();
    writeFileSync(privPath(), seed);
    writeFileSync(pubPath(), makePair().pubRaw); // foreign public key
    expect(() => flairPair({ name, keysDir: tmpKeys })).toThrow(
      "bob rewrites it from the private key",
    );

    rmSync(pubPath());
    const res = flairPair({ name, keysDir: tmpKeys });
    expect(res.publicKeyBase64).toBe(pubBase64);
    expect(existsSync(pubPath())).toBe(true);
    expect(readFileSync(pubPath(), "utf8")).toBe(`${pubBase64}\n`);
  });

  it("(p6) the derivation helper refuses a non-Ed25519 private key", () => {
    const x = generateKeyPairSync("x25519").privateKey.export({
      format: "der",
      type: "pkcs8",
    }) as Buffer;
    expect(() => deriveEd25519PublicKeyBase64(x)).toThrow(
      "cannot derive an Ed25519 public key from a x25519 private key",
    );
  });

  it("(p7) the .pub repair never replaces an existing file", () => {
    const { pubBase64 } = makePair();
    writeFileSync(pubPath(), "existing\n");
    expect(createPubIfAbsent(pubPath(), pubBase64)).toBe(false);
    expect(readFileSync(pubPath(), "utf8")).toBe("existing\n");

    rmSync(pubPath());
    expect(createPubIfAbsent(pubPath(), pubBase64)).toBe(true);
    expect(readFileSync(pubPath(), "utf8")).toBe(`${pubBase64}\n`);
    expect(statSync(pubPath()).mode & 0o777).toBe(0o644);
  });

  it("(p8) the .pub repair publishes a complete file and leaves no temporary file", () => {
    const { seed, pubBase64 } = makePair();
    writeFileSync(privPath(), seed);
    flairPair({ name, keysDir: tmpKeys }); // repairs the missing .pub
    expect(readFileSync(pubPath(), "utf8")).toBe(`${pubBase64}\n`);

    // A .pub already present: nothing is published and the temporary file is still removed.
    expect(createPubIfAbsent(pubPath(), pubBase64)).toBe(false);
    expect(readdirSync(tmpKeys).sort()).toEqual([`${name}.key`, `${name}.pub`]);
  });
});
