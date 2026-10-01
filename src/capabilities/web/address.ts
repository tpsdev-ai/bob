// The versioned public-unicast address policy (bob#245 — web spec v3, slice
// R1b). The fetch core vets EVERY address a request could connect to against
// this file: each DNS answer, and the canonical literal when the URL names an
// address instead of a name.
//
// THE POLICY. An address is accepted only when it is global unicast and not in
// a row of the IANA IPv4 or IPv6 Special-Purpose Address Registry. Refused:
// loopback, this-network/unspecified, private-use, link-local, shared address
// space (CGNAT), benchmarking, documentation, reserved, multicast and the
// broadcast address; on v6 unique-local, link-local, multicast and site-local,
// and anything outside 2000::/3; and every transition/translation prefix
// (NAT64 64:ff9b::/96 and 64:ff9b:1::/48, 6to4 2002::/16, Teredo inside
// 2001::/23, the deprecated IPv4-compatible ::/96 and the IPv4-mapped
// ::ffff:0:0/96). The host's own interface addresses are refused, so a request
// can never reach the machine bob runs on. Anything unparsable is refused.
//
// ONE REFUSED ADDRESS REFUSES THE REQUEST. Nothing here returns "the first
// allowed answer": the caller refuses the whole request when any answer is
// refused (fetch.ts, vettedLookup).
//
// THE VERSION. ADDRESS_POLICY_VERSION names the registry revision this table
// was transcribed from. Registry rows are data, so a new revision is a
// reviewed edit to this table; the policy object carries the version it was
// built with, and the tests pin it.

import { networkInterfaces } from "node:os";

// The registry revision this table was transcribed from (IANA special-purpose
// registries, both families). Bump it in the same review as any row edit.
export const ADDRESS_POLICY_VERSION = "iana-special-purpose/2026-10-01";

export type AddressRefusalCode =
  // Outside global unicast (2000::/3 on v6). On IPv4 the registry rows cover
  // every address outside global unicast, so this code is the v6 net's alone.
  | "not-global-unicast"
  // A row of the IANA IPv4 special-purpose registry.
  | "ipv4-special"
  // A row of the IANA IPv6 special-purpose registry.
  | "ipv6-special"
  // A transition/translation prefix (NAT64, 6to4, Teredo, IPv4-compatible).
  | "transition"
  // An address of this host's own interfaces.
  | "own-interface"
  // An IPv4-mapped IPv6 address (::ffff:0:0/96), whatever it embeds.
  | "ipv4-mapped"
  // Not an address this file can read.
  | "unparsable";

export interface AddressRefusal {
  allowed: false;
  code: AddressRefusalCode;
  // Names the rule and the row, or the address's own form. Never a secret.
  detail: string;
}

export type AddressVerdict = { allowed: true } | AddressRefusal;

export interface AddressPolicy {
  // The registry revision, ADDRESS_POLICY_VERSION.
  readonly version: string;
  // Accept only when the address is global unicast and in no registry row.
  classify(address: string): AddressVerdict;
}

export type RegistryName = "iana-ipv4-special-registry" | "iana-ipv6-special-registry";

export interface RegistryRow {
  // The canonical prefix, as the registry writes it.
  cidr: string;
  // The registry's name for the row.
  name: string;
  registry: RegistryName;
  // The refusal code a match reports: the registry's, or "transition".
  code: AddressRefusalCode;
}

const ipv4Row = (cidr: string, name: string, code?: AddressRefusalCode): RegistryRow => ({
  cidr,
  name,
  registry: "iana-ipv4-special-registry",
  code: code ?? "ipv4-special",
});

const ipv6Row = (cidr: string, name: string, code?: AddressRefusalCode): RegistryRow => ({
  cidr,
  name,
  registry: "iana-ipv6-special-registry",
  code: code ?? "ipv6-special",
});

// Rows are matched in order, first match wins, and a narrower row that is
// inside a wider one MUST come first (::1/128 and ::/128 before ::/96;
// 192.0.0.0/29 before 192.0.0.0/24; 255.255.255.255/32 before 240.0.0.0/4).
export const IPV4_REGISTRY_ROWS: readonly RegistryRow[] = Object.freeze([
  ipv4Row("0.0.0.0/8", "This network"),
  ipv4Row("10.0.0.0/8", "Private-Use"),
  ipv4Row("100.64.0.0/10", "Shared Address Space"),
  ipv4Row("127.0.0.0/8", "Loopback"),
  ipv4Row("169.254.0.0/16", "Link Local"),
  ipv4Row("172.16.0.0/12", "Private-Use"),
  ipv4Row("192.0.0.0/29", "IPv4 Service Continuity Prefix"),
  ipv4Row("192.0.0.0/24", "IETF Protocol Assignments"),
  ipv4Row("192.0.2.0/24", "Documentation (TEST-NET-1)"),
  ipv4Row("192.31.196.0/24", "AS112-v4"),
  ipv4Row("192.52.193.0/24", "AMT"),
  ipv4Row("192.88.99.0/24", "Deprecated (6to4 Relay Anycast)", "transition"),
  ipv4Row("192.168.0.0/16", "Private-Use"),
  ipv4Row("192.175.48.0/24", "Direct Delegation AS112 Service"),
  ipv4Row("198.18.0.0/15", "Benchmarking"),
  ipv4Row("198.51.100.0/24", "Documentation (TEST-NET-2)"),
  ipv4Row("203.0.113.0/24", "Documentation (TEST-NET-3)"),
  ipv4Row("224.0.0.0/4", "Multicast"),
  ipv4Row("255.255.255.255/32", "Limited Broadcast"),
  ipv4Row("240.0.0.0/4", "Reserved"),
]);

export const IPV6_REGISTRY_ROWS: readonly RegistryRow[] = Object.freeze([
  ipv6Row("::/128", "Unspecified"),
  ipv6Row("::1/128", "Loopback"),
  ipv6Row("::/96", "IPv4-Compatible Address (deprecated)", "transition"),
  ipv6Row("100::/64", "Discard-Only Address Block"),
  ipv6Row("64:ff9b::/96", "IPv4-IPv6 Translation", "transition"),
  ipv6Row("64:ff9b:1::/48", "IPv4-IPv6 Translation", "transition"),
  ipv6Row("2001::/23", "IETF Protocol Assignments"),
  ipv6Row("2001:db8::/32", "Documentation"),
  ipv6Row("2002::/16", "6to4", "transition"),
  ipv6Row("2620:4f:8000::/48", "Direct Delegation AS112 Service"),
  ipv6Row("3fff::/20", "Documentation"),
  ipv6Row("5f00::/16", "Segment Routing (SRv6) SIDs"),
  ipv6Row("fc00::/7", "Unique-Local"),
  ipv6Row("fe80::/10", "Link-Local Unicast"),
  ipv6Row("fec0::/10", "Site-Local (deprecated)"),
  ipv6Row("ff00::/8", "Multicast"),
]);

// ── addresses ──────────────────────────────────────────────────────────────

interface ParsedAddress {
  family: 4 | 6;
  bytes: number[];
}

// A dotted-quad IPv4 literal, or undefined. Only the canonical dotted form:
// WHATWG URL rewrites every other notation (hex, octal, short, 32-bit integer)
// into this one before any address is classified, so this is also the form a
// URL literal arrives in.
export function parseIpv4Literal(text: string): ParsedAddress | undefined {
  const parts = text.split(".");
  if (parts.length !== 4) return undefined;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^[0-9]{1,3}$/.test(part)) return undefined;
    const value = Number(part);
    if (value > 255) return undefined;
    bytes.push(value);
  }
  return { family: 4, bytes };
}

// An IPv6 literal (brackets already removed), or undefined. Accepts the
// canonical form WHATWG URL produces (lowercase hex groups, one `::`) and any
// other well-formed form.
export function parseIpv6Literal(text: string): ParsedAddress | undefined {
  let text2 = text;
  if (text2.startsWith("[") && text2.endsWith("]")) text2 = text2.slice(1, -1);
  if (text2.includes("%")) return undefined; // zone identifier
  if (text2 === "") return undefined;

  // The trailing IPv4-in-IPv6 form (::ffff:1.2.3.4): rewrite the dotted tail
  // into its two hex groups, so the rest of the parse sees one form.
  const lastColon = text2.lastIndexOf(":");
  const tail = text2.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4Literal(tail);
    if (v4 === undefined) return undefined;
    const first = ((v4.bytes[0] << 8) | v4.bytes[1]).toString(16);
    const second = ((v4.bytes[2] << 8) | v4.bytes[3]).toString(16);
    text2 = `${text2.slice(0, lastColon + 1)}${first}:${second}`;
  }

  const doubleColon = text2.indexOf("::");
  if (doubleColon !== -1 && text2.indexOf("::", doubleColon + 1) !== -1) return undefined;
  const head = doubleColon === -1 ? text2 : text2.slice(0, doubleColon);
  const rest = doubleColon === -1 ? "" : text2.slice(doubleColon + 2);
  const headParts = head === "" ? [] : head.split(":");
  const restParts = rest === "" ? [] : rest.split(":");

  const parseGroup = (g: string): number | undefined =>
    /^[0-9a-fA-F]{1,4}$/.test(g) ? Number.parseInt(g, 16) : undefined;

  const headVals: number[] = [];
  for (const g of headParts) {
    const v = parseGroup(g);
    if (v === undefined) return undefined;
    headVals.push(v);
  }
  const restVals: number[] = [];
  for (const g of restParts) {
    const v = parseGroup(g);
    if (v === undefined) return undefined;
    restVals.push(v);
  }

  const given = headVals.length + restVals.length;
  if (doubleColon === -1 && given !== 8) return undefined;
  if (doubleColon !== -1 && given > 7) return undefined;
  const zeros = new Array<number>(doubleColon === -1 ? 0 : 8 - given).fill(0);

  const all = [...headVals, ...zeros, ...restVals];
  if (all.length !== 8) return undefined;
  const bytes: number[] = [];
  for (const g of all) bytes.push((g >> 8) & 0xff, g & 0xff);
  return { family: 6, bytes };
}

// The canonical text of an address, or undefined when it cannot be read.
export function parseAddress(text: string): ParsedAddress | undefined {
  return parseIpv4Literal(text) ?? parseIpv6Literal(text);
}

function inPrefix(bytes: number[], prefix: ParsedAddress, bits: number): boolean {
  const wholeBytes = Math.floor(bits / 8);
  const restBits = bits % 8;
  for (let i = 0; i < wholeBytes; i++) if (bytes[i] !== prefix.bytes[i]) return false;
  if (restBits > 0) {
    const mask = 0xff << (8 - restBits);
    if ((bytes[wholeBytes] & mask) !== (prefix.bytes[wholeBytes] & mask)) return false;
  }
  return true;
}

function matchRow(address: ParsedAddress, row: RegistryRow): boolean {
  const prefix = parseAddress(row.cidr.split("/")[0]);
  const bits = Number(row.cidr.split("/")[1]);
  if (prefix === undefined || prefix.family !== address.family) return false;
  return inPrefix(address.bytes, prefix, bits);
}

// The IPv4 address embedded in an IPv4-mapped IPv6 address (::ffff:0:0/96), or
// undefined when the address is not in that range.
function embeddedIpv4(address: ParsedAddress): ParsedAddress | undefined {
  const mapped = inPrefix(
    address.bytes,
    { family: 6, bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff, 0, 0, 0, 0] },
    96,
  );
  if (!mapped) return undefined;
  return { family: 4, bytes: address.bytes.slice(12) };
}

function canonicalText(address: ParsedAddress): string {
  if (address.family === 4) return address.bytes.join(".");
  const groups: string[] = [];
  for (let i = 0; i < 8; i++)
    groups.push(((address.bytes[2 * i] << 8) | address.bytes[2 * i + 1]).toString(16));
  return groups.join(":");
}

// The addresses of this host's own interfaces, one entry per address, with any
// IPv6 zone identifier stripped. A read that fails returns an empty list: it
// cannot make an address acceptable, because the policy still classifies it by
// the registries.
export function ownInterfaceAddresses(
  interfaces: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const list of Object.values(interfaces)) {
    for (const info of list ?? []) out.push(info.address.split("%")[0]);
  }
  return out;
}

export interface AddressPolicyOptions {
  // The host's own interface addresses. Defaults to this host's; a caller that
  // needs a deterministic list (a test) passes one.
  own?: readonly string[];
}

// The public-unicast policy. Refusal order: the registry rows (data), then the
// host's own interfaces, then the global-unicast net — which is the IPv6 one:
// on IPv4 the rows cover every address outside global unicast.
export function publicUnicastPolicy(options: AddressPolicyOptions = {}): AddressPolicy {
  const own = new Set(
    (options.own ?? ownInterfaceAddresses())
      .map((text) => {
        const parsed = parseAddress(text);
        return parsed === undefined ? undefined : `${parsed.family}:${canonicalText(parsed)}`;
      })
      .filter((key): key is string => key !== undefined),
  );

  const classify = (address: string): AddressVerdict => {
    const parsed = parseAddress(address);
    if (parsed === undefined) {
      return { allowed: false, code: "unparsable", detail: `not an IP address: ${address}` };
    }

    if (parsed.family === 6) {
      const mappedInner = embeddedIpv4(parsed);
      if (mappedInner !== undefined) {
        const inner = classify(mappedInner.bytes.join("."));
        return {
          allowed: false,
          code: "ipv4-mapped",
          detail: `IPv4-mapped address ${canonicalText(parsed)} (${inner.allowed ? `embeds the global unicast address ${canonicalText(mappedInner)}` : inner.detail})`,
        };
      }
    }

    const rows = parsed.family === 4 ? IPV4_REGISTRY_ROWS : IPV6_REGISTRY_ROWS;
    for (const row of rows) {
      if (matchRow(parsed, row)) {
        return {
          allowed: false,
          code: row.code,
          detail: `${row.registry} ${row.cidr} "${row.name}"`,
        };
      }
    }

    if (own.has(`${parsed.family}:${canonicalText(parsed)}`)) {
      return {
        allowed: false,
        code: "own-interface",
        detail: "a local interface address of the host bob runs on",
      };
    }

    if (
      parsed.family === 6 &&
      !inPrefix(
        parsed.bytes,
        { family: 6, bytes: [0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
        3,
      )
    ) {
      return {
        allowed: false,
        code: "not-global-unicast",
        detail: "IPv6 outside global unicast (2000::/3)",
      };
    }

    return { allowed: true };
  };

  return { version: ADDRESS_POLICY_VERSION, classify };
}
