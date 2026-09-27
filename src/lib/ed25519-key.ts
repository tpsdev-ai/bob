// ONE loader for an on-disk Ed25519 PRIVATE key, tolerant of the shapes that
// actually occur in the wild. Flair's OWN tooling (`flair agent add`,
// `flair agent rotate-key`) writes a RAW 32-byte binary seed — no PEM armor, no
// base64, no PKCS8 wrapper — while bob's `flair-pair` path writes PEM PKCS8 and
// some operators have base64-wrapped either the seed or the DER. Every one of
// these used to reach node:crypto as a UTF-8 STRING and only two shapes worked,
// so a Flair-made key failed at signing time with
// "error:0680008E:asn1 encoding routines::not enough data". This module turns
// ALL of them into one canonical thing: PKCS8 DER bytes.
//
// SECURITY: takes the key MATERIAL (a Buffer) and a PATH used only in the error
// message. It never stringifies the input into an error/log, and the refusal
// names only the path and the input's BYTE COUNT — never the bytes, their
// base64, or any decoded form.

import { createPrivateKey } from "node:crypto";

// RFC 8410 prefix that wraps a bare 32-byte Ed25519 seed into PKCS8 DER
// (ASN.1: SEQUENCE { INTEGER 0, SEQUENCE { OID 1.3.101.112 }, OCTET STRING {
// OCTET STRING { <32-byte seed> } } }). Prepending it is the whole conversion.
const ED25519_PKCS8_SEED_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

// The four accepted shapes, in words, reused by the refusal so the operator can
// see exactly what was expected without the message growing a second copy.
const ACCEPTED =
  "a raw 32-byte seed (what 'flair agent add' writes), base64 of that seed, base64 PKCS8 DER, or PEM PKCS8";

function refuse(path: string, bytes: number): never {
  throw new Error(
    `cannot load Ed25519 private key at ${path} (${bytes} bytes): expected ${ACCEPTED}`,
  );
}

/**
 * Normalize an on-disk Ed25519 private key, given as raw file BYTES, to PKCS8
 * DER. Accepts, checked in this order:
 *   (a) PEM PKCS8   — the bytes contain "-----BEGIN"
 *   (b) a raw 32-byte seed — the bytes ARE the seed
 *   (c) base64 of the text — 32 decoded bytes = a seed (prefixed the same way);
 *       any other non-empty decode = PKCS8 DER
 * The result is verified with createPrivateKey and its asymmetricKeyType MUST be
 * "ed25519"; anything unparsable or non-Ed25519 throws.
 */
export function normalizeEd25519PrivateKey(bytes: Buffer, path: string): Buffer {
  const n = bytes.length;
  const text = bytes.toString("utf8").trim();

  let der: Buffer;
  if (text.includes("-----BEGIN")) {
    // (a) PEM PKCS8 (also PEM PKCS1/EC/etc — the type check below rejects them).
    der = extractPkcs8Der(text, path, n);
  } else if (n === 32) {
    // (b) the raw seed Flair writes.
    der = Buffer.concat([ED25519_PKCS8_SEED_PREFIX, bytes]);
  } else {
    // (c) base64 text. Buffer.from(…, "base64") ignores whitespace/newlines and
    // stops at the first invalid character, so a wrapped base64 blob still
    // decodes. An empty decode (empty file, or text with no base64 at all)
    // is a refusal.
    const decoded = Buffer.from(text, "base64");
    if (decoded.length === 32) {
      der = Buffer.concat([ED25519_PKCS8_SEED_PREFIX, decoded]);
    } else if (decoded.length > 0) {
      der = decoded;
    } else {
      return refuse(path, n);
    }
  }

  // Verify: it must PARSE as a private key AND be Ed25519. This is the single
  // gate that rejects a 31-byte file, a text file of garbage, an RSA/EC key,
  // and a truncated base64 blob — all the same way, with the same message.
  let type: string | undefined;
  try {
    type = createPrivateKey({ key: der, format: "der", type: "pkcs8" }).asymmetricKeyType;
  } catch {
    return refuse(path, n);
  }
  if (type !== "ed25519") return refuse(path, n);
  return der;
}

// createPrivateKey on a PEM string, re-exported as PKCS8 DER. Pulled out so the
// "-----BEGIN" branch reads as one step; a parse failure becomes the caller's
// refusal (never a raw asn1 error naming nothing).
function extractPkcs8Der(pem: string, path: string, bytes: number): Buffer {
  try {
    return createPrivateKey(pem).export({ format: "der", type: "pkcs8" }) as Buffer;
  } catch {
    return refuse(path, bytes);
  }
}
