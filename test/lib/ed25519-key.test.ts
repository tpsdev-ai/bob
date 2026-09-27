// ONE normalizer for the Ed25519 private key shapes that occur in the wild.
//
// The bug (bob#142): bob read key files as UTF-8 TEXT and accepted only PEM
// PKCS8 or base64 PKCS8 DER, but Flair's own tooling (`flair agent add`,
// `flair agent rotate-key`) writes a RAW 32-byte binary seed — so a Flair-made
// key failed at signing time with
// "error:0680008E:asn1 encoding routines::not enough data".
//
// These tests pin the four accepted shapes to ONE DER, prove determinism (the
// same key signs the same payload the same way, Ed25519 being deterministic),
// and prove the refusal names the file, its size and the accepted formats
// WITHOUT ever echoing the key.

import { describe, expect, it } from "bun:test";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { FlairHttpClient } from "../../src/capabilities/flair/client.js";
import { ObservatoryHttpClient } from "../../src/capabilities/observatory/client.js";
import { normalizeEd25519PrivateKey } from "../../src/lib/ed25519-key.js";

// A throwaway 32-byte seed (NOT a secret — a fixed pattern, so the test can
// assert byte-for-byte). The RFC 8410 prefix that wraps it into PKCS8 DER.
const SEED = Buffer.alloc(32, 0x07);
const PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const PKCS8_DER = Buffer.concat([PREFIX, SEED]);

// The four shapes a key file can be on disk, all carrying the SAME key:
//   (a) PEM PKCS8 (what `bob flair-pair` writes)
//   (b) the raw 32-byte seed (what `flair agent add` writes)
//   (c) base64 of that seed
//   (d) base64 of the PKCS8 DER
const SHAPES: Record<string, Buffer> = {
  pem: Buffer.from(
    createPrivateKey({ key: PKCS8_DER, format: "der", type: "pkcs8" })
      .export({ format: "pem", type: "pkcs8" })
      .toString(),
  ),
  raw: Buffer.from(SEED),
  "base64-seed": Buffer.from(SEED.toString("base64")),
  "base64-der": Buffer.from(PKCS8_DER.toString("base64")),
};

describe("normalizeEd25519PrivateKey (bob#142)", () => {
  it("(t1) all four shapes normalize to the SAME DER, and sign a fixed payload with the SAME signature", async () => {
    // The DER itself is identical across shapes.
    for (const [name, bytes] of Object.entries(SHAPES)) {
      const der = normalizeEd25519PrivateKey(bytes, `/keys/${name}.key`);
      expect(der.equals(PKCS8_DER), `shape ${name} normalizes to the canonical DER`).toBe(true); // assertion: same DER
    }

    // …and through the FLAIR CLIENT's header builder (its readFile seam), all
    // four shapes produce a byte-identical Authorization header.
    const flairAuth = (bytes: Buffer): string => {
      let captured: Record<string, string> = {};
      const client = new FlairHttpClient({
        url: "http://127.0.0.1:9926",
        agentId: "pulse",
        keyFile: "/unused",
        fetchImpl: async (_url, init) => {
          captured = init.headers;
          return { ok: true, status: 200, text: async () => "{}" };
        },
        now: () => 1_700_000_000_000, // fixed ms
        uuid: () => "nonce-fixed",
        readFile: () => bytes,
      });
      void client.get("x"); // signed GET — the header is built before the fetch resolves
      return captured.Authorization ?? "";
    };
    const flairHeaders = Object.values(SHAPES).map(flairAuth);
    expect(new Set(flairHeaders).size, "flair signs all four shapes identically").toBe(1); // assertion: one header
    expect(flairHeaders[0]?.startsWith("TPS-Ed25519 pulse:1700000000000:nonce-fixed:")).toBe(true); // assertion: header shape (signature validity is covered by the flair client tests)

    // …and through the OBSERVATORY CLIENT's post path (its readFile seam).
    const obsAuth = async (bytes: Buffer): Promise<string> => {
      let captured: Record<string, string> = {};
      const client = new ObservatoryHttpClient({
        url: "http://127.0.0.1:9926",
        officeId: "rockit",
        officeKeyFile: "/unused",
        fetchImpl: async (_url, init) => {
          captured = init.headers;
          return { ok: true, status: 200, text: async () => "{}" };
        },
        now: () => 1_700_000_000_000,
        uuid: () => "nonce-fixed",
        readFile: () => bytes,
      });
      await client.post({ events: [], agents: [] });
      return captured.Authorization ?? "";
    };
    const obsHeaders: string[] = [];
    for (const bytes of Object.values(SHAPES)) obsHeaders.push(await obsAuth(bytes));
    expect(new Set(obsHeaders).size, "observatory signs all four shapes identically").toBe(1); // assertion: one header
    expect(obsHeaders[0]?.startsWith("TPS-Ed25519 rockit:1700000000000:nonce-fixed:")).toBe(true); // assertion: header shape (signature validity is covered by the observatory client tests)
  });

  it("(t2) a 31-byte file, an empty file and a text file of garbage each throw, naming the path + byte count (never the key)", () => {
    const cases: Array<{ name: string; bytes: Buffer }> = [
      { name: "short", bytes: Buffer.alloc(31, 0x07) }, // 31 bytes: one short of a seed
      { name: "empty", bytes: Buffer.alloc(0) }, // empty file
      { name: "garbage", bytes: Buffer.from("this is plain prose, not a key at all\n") }, // not 32 bytes
    ];
    const seedB64 = SEED.toString("base64");
    for (const c of cases) {
      const path = `/keys/${c.name}.key`;
      const size = c.bytes.length;
      let message = "";
      try {
        normalizeEd25519PrivateKey(c.bytes, path);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, `${c.name}: threw`).not.toBe(""); // assertion: it threw
      expect(message).toContain(path); // assertion: the path is named
      expect(message).toContain(`(${size} bytes)`); // assertion: the byte count is named
      expect(message).toContain("raw 32-byte seed"); // assertion: the accepted shapes are named
      expect(message).not.toContain(seedB64); // assertion: never the reference key
      // …and never THIS input's own bytes in any encoding.
      if (c.bytes.length > 0) {
        expect(message).not.toContain(c.bytes.toString("base64"));
        expect(message).not.toContain(c.bytes.toString("hex"));
      }
    }
  });

  it("(t3) an RSA PKCS8 key throws: base64 and PEM forms by the Ed25519 type gate, binary DER as not an accepted shape", () => {
    // base64 PKCS8 and PEM are ACCEPTED SHAPES that parse as valid private keys,
    // so only the asymmetricKeyType gate rejects them. Binary DER is not one of
    // the four accepted shapes: it is refused as malformed input.
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaDer = privateKey.export({ format: "der", type: "pkcs8" }) as Buffer;
    const rsaPem = Buffer.from(privateKey.export({ format: "pem", type: "pkcs8" }).toString());

    for (const [name, bytes] of [
      ["rsa-der", rsaDer],
      ["rsa-b64", Buffer.from(rsaDer.toString("base64"))],
      ["rsa-pem", rsaPem],
    ] as const) {
      let message = "";
      try {
        normalizeEd25519PrivateKey(bytes, `/keys/${name}.key`);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, `${name}: threw`).not.toBe(""); // assertion: it threw
      expect(message).toContain(`/keys/${name}.key`); // assertion: the path is named
      expect(message).toContain("raw 32-byte seed"); // assertion: the accepted shapes are named
    }
  });
  it('(t4) a raw 32-byte seed is accepted whatever its bytes are, including the text "-----BEGIN"', () => {
    const seed = Buffer.concat([Buffer.from("-----BEGIN"), Buffer.alloc(22, 0x01)]);
    expect(seed.length).toBe(32);
    const der = normalizeEd25519PrivateKey(seed, "/keys/pem-looking-seed.key");
    expect(der.equals(Buffer.concat([PREFIX, seed]))).toBe(true); // assertion: read as a seed
    expect(createPrivateKey({ key: der, format: "der", type: "pkcs8" }).asymmetricKeyType).toBe(
      "ed25519",
    );
  });

  it("(t5) base64 is STRICT: a valid seed's base64 with a stray suffix, a bad character or broken padding is refused", () => {
    const good = SEED.toString("base64");
    for (const [name, text] of [
      ["suffix", `${good}!ignored`],
      ["mid-char", `${good.slice(0, 10)}*${good.slice(11)}`],
      ["no-padding", good.replace(/=+$/, "")],
    ] as const) {
      let message = "";
      try {
        normalizeEd25519PrivateKey(Buffer.from(text), `/keys/${name}.key`);
      } catch (err) {
        message = err instanceof Error ? err.message : String(err);
      }
      expect(message, `${name}: refused`).toContain(`/keys/${name}.key`);
    }
  });
});
