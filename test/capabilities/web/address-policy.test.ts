// The web fetch core's address policy and URL admission (bob#245 — web spec v3,
// slice R1b). Pure: no sockets here. Every registry row and every prefix rule
// is pinned by a sample address and the refusal it must produce; the loopback
// transport tests live in fetch-core-node.test.ts.

import { describe, expect, it } from "bun:test";
import {
  ADDRESS_POLICY_VERSION,
  type AddressRefusal,
  IPV4_REGISTRY_ROWS,
  IPV6_REGISTRY_ROWS,
  ownInterfaceAddresses,
  parseAddress,
  publicUnicastPolicy,
} from "../../../src/capabilities/web/address.js";
import { WebFetchError } from "../../../src/capabilities/web/errors.js";
import {
  admitUrl,
  hasZoneIdentifier,
  type UrlPolicy,
  WEB_PORTS,
} from "../../../src/capabilities/web/url-admission.js";

const policy = publicUnicastPolicy({ own: [] });

function refusal(
  address: string,
  from: ReturnType<typeof publicUnicastPolicy> = policy,
): AddressRefusal {
  const verdict = from.classify(address);
  if (verdict.allowed) throw new Error(`${address} was accepted, expected a refusal`);
  return verdict;
}

// One sample address per IANA IPv4 special-purpose row, with the registry line
// the refusal must name and the code the refusal must carry. Hand-written, so a
// row edit in address.ts fails here.
const IPV4_CASES: ReadonlyArray<[string, string, "ipv4-special" | "transition"]> = [
  ["0.0.0.0", 'iana-ipv4-special-registry 0.0.0.0/8 "This network"', "ipv4-special"],
  ["10.0.0.1", 'iana-ipv4-special-registry 10.0.0.0/8 "Private-Use"', "ipv4-special"],
  ["100.64.0.1", 'iana-ipv4-special-registry 100.64.0.0/10 "Shared Address Space"', "ipv4-special"],
  ["127.0.0.1", 'iana-ipv4-special-registry 127.0.0.0/8 "Loopback"', "ipv4-special"],
  ["169.254.1.1", 'iana-ipv4-special-registry 169.254.0.0/16 "Link Local"', "ipv4-special"],
  ["172.16.0.1", 'iana-ipv4-special-registry 172.16.0.0/12 "Private-Use"', "ipv4-special"],
  [
    "192.0.0.1",
    'iana-ipv4-special-registry 192.0.0.0/29 "IPv4 Service Continuity Prefix"',
    "ipv4-special",
  ],
  [
    "192.0.0.9",
    'iana-ipv4-special-registry 192.0.0.0/24 "IETF Protocol Assignments"',
    "ipv4-special",
  ],
  [
    "192.0.2.1",
    'iana-ipv4-special-registry 192.0.2.0/24 "Documentation (TEST-NET-1)"',
    "ipv4-special",
  ],
  ["192.31.196.1", 'iana-ipv4-special-registry 192.31.196.0/24 "AS112-v4"', "ipv4-special"],
  ["192.52.193.1", 'iana-ipv4-special-registry 192.52.193.0/24 "AMT"', "ipv4-special"],
  [
    "192.88.99.1",
    'iana-ipv4-special-registry 192.88.99.0/24 "Deprecated (6to4 Relay Anycast)"',
    "transition",
  ],
  ["192.168.1.1", 'iana-ipv4-special-registry 192.168.0.0/16 "Private-Use"', "ipv4-special"],
  [
    "192.175.48.1",
    'iana-ipv4-special-registry 192.175.48.0/24 "Direct Delegation AS112 Service"',
    "ipv4-special",
  ],
  ["198.18.0.1", 'iana-ipv4-special-registry 198.18.0.0/15 "Benchmarking"', "ipv4-special"],
  ["198.19.255.254", 'iana-ipv4-special-registry 198.18.0.0/15 "Benchmarking"', "ipv4-special"],
  [
    "198.51.100.1",
    'iana-ipv4-special-registry 198.51.100.0/24 "Documentation (TEST-NET-2)"',
    "ipv4-special",
  ],
  [
    "203.0.113.1",
    'iana-ipv4-special-registry 203.0.113.0/24 "Documentation (TEST-NET-3)"',
    "ipv4-special",
  ],
  ["224.0.0.1", 'iana-ipv4-special-registry 224.0.0.0/4 "Multicast"', "ipv4-special"],
  ["240.0.0.1", 'iana-ipv4-special-registry 240.0.0.0/4 "Reserved"', "ipv4-special"],
  [
    "255.255.255.255",
    'iana-ipv4-special-registry 255.255.255.255/32 "Limited Broadcast"',
    "ipv4-special",
  ],
];

// One sample address per IANA IPv6 special-purpose row, plus the transition
// prefixes, with the registry line and the code the refusal must carry.
const IPV6_CASES: ReadonlyArray<[string, string, "ipv6-special" | "transition"]> = [
  ["::", 'iana-ipv6-special-registry ::/128 "Unspecified"', "ipv6-special"],
  ["::1", 'iana-ipv6-special-registry ::1/128 "Loopback"', "ipv6-special"],
  [
    "::1.2.3.4",
    'iana-ipv6-special-registry ::/96 "IPv4-Compatible Address (deprecated)"',
    "transition",
  ],
  ["100::1", 'iana-ipv6-special-registry 100::/64 "Discard-Only Address Block"', "ipv6-special"],
  ["64:ff9b::1", 'iana-ipv6-special-registry 64:ff9b::/96 "IPv4-IPv6 Translation"', "transition"],
  [
    "64:ff9b:1::1",
    'iana-ipv6-special-registry 64:ff9b:1::/48 "IPv4-IPv6 Translation"',
    "transition",
  ],
  ["2001::1", 'iana-ipv6-special-registry 2001::/23 "IETF Protocol Assignments"', "ipv6-special"],
  ["2001:2::1", 'iana-ipv6-special-registry 2001::/23 "IETF Protocol Assignments"', "ipv6-special"],
  ["2001:db8::1", 'iana-ipv6-special-registry 2001:db8::/32 "Documentation"', "ipv6-special"],
  ["2002::1", 'iana-ipv6-special-registry 2002::/16 "6to4"', "transition"],
  [
    "2620:4f:8000::1",
    'iana-ipv6-special-registry 2620:4f:8000::/48 "Direct Delegation AS112 Service"',
    "ipv6-special",
  ],
  ["3fff::1", 'iana-ipv6-special-registry 3fff::/20 "Documentation"', "ipv6-special"],
  ["5f00::1", 'iana-ipv6-special-registry 5f00::/16 "Segment Routing (SRv6) SIDs"', "ipv6-special"],
  ["fc00::1", 'iana-ipv6-special-registry fc00::/7 "Unique-Local"', "ipv6-special"],
  ["fd00::1", 'iana-ipv6-special-registry fc00::/7 "Unique-Local"', "ipv6-special"],
  ["fe80::1", 'iana-ipv6-special-registry fe80::/10 "Link-Local Unicast"', "ipv6-special"],
  ["fec0::1", 'iana-ipv6-special-registry fec0::/10 "Site-Local (deprecated)"', "ipv6-special"],
  ["ff02::1", 'iana-ipv6-special-registry ff00::/8 "Multicast"', "ipv6-special"],
];

describe("the address policy", () => {
  it("names the registry revision it was transcribed from", () => {
    expect(ADDRESS_POLICY_VERSION).toBe("iana-special-purpose/2026-10-01");
    expect(policy.version).toBe(ADDRESS_POLICY_VERSION);
  });

  it("carries one row per IANA special-purpose row, each a usable prefix", () => {
    expect(IPV4_REGISTRY_ROWS.length).toBe(20);
    expect(IPV6_REGISTRY_ROWS.length).toBe(16);
    for (const row of [...IPV4_REGISTRY_ROWS, ...IPV6_REGISTRY_ROWS]) {
      const [address, bits] = row.cidr.split("/");
      const parsed = parseAddress(address);
      expect(parsed).toBeDefined();
      expect(parsed?.family).toBe(row.registry === "iana-ipv4-special-registry" ? 4 : 6);
      expect(Number(bits)).toBeGreaterThan(0);
      expect(Number(bits)).toBeLessThanOrEqual(parsed?.family === 4 ? 32 : 128);
      expect(row.name.length).toBeGreaterThan(0);
    }
    expect(new Set([...IPV4_REGISTRY_ROWS, ...IPV6_REGISTRY_ROWS].map((r) => r.cidr)).size).toBe(
      36,
    );
  });

  it("refuses every IANA IPv4 special-purpose row, naming it", () => {
    for (const [address, detail, code] of IPV4_CASES) {
      const verdict = refusal(address);
      expect(verdict.detail).toBe(detail);
      expect(verdict.code).toBe(code);
    }
  });

  it("refuses every IANA IPv6 special-purpose row, naming it", () => {
    for (const [address, detail, code] of IPV6_CASES) {
      const verdict = refusal(address);
      expect(verdict.detail).toBe(detail);
      expect(verdict.code).toBe(code);
    }
  });

  it("accepts global unicast addresses", () => {
    for (const address of [
      "1.1.1.1",
      "8.8.8.8",
      "93.184.216.34",
      "223.255.255.254",
      "2001:4860:4860::8888",
      "2606:4700:4700::1111",
      "2a00:1450:4001:81b::200e",
    ]) {
      expect(policy.classify(address)).toEqual({ allowed: true });
    }
  });

  it("refuses every address outside global unicast", () => {
    // On IPv4 the rows already cover everything outside global unicast
    // (0.0.0.0/8, 224.0.0.0/4, 240.0.0.0/4); this net catches the rest.
    for (const address of ["4000::1", "8000::1", "c000::1", "e000::1"]) {
      const verdict = refusal(address);
      expect(verdict.code).toBe("not-global-unicast");
      expect(verdict.detail).toBe("IPv6 outside global unicast (2000::/3)");
    }
  });

  it("refuses an IPv4-mapped IPv6 address, whatever it embeds", () => {
    const privateMapped = refusal("::ffff:10.0.0.1");
    expect(privateMapped.code).toBe("ipv4-mapped");
    expect(privateMapped.detail).toContain('iana-ipv4-special-registry 10.0.0.0/8 "Private-Use"');

    const publicMapped = refusal("::ffff:93.184.216.34");
    expect(publicMapped.code).toBe("ipv4-mapped");
    expect(publicMapped.detail).toContain("embeds the global unicast address 93.184.216.34");

    // The bracketed form a URL's hostname carries.
    expect(refusal("[::ffff:127.0.0.1]").code).toBe("ipv4-mapped");
  });

  it("refuses an address that cannot be read", () => {
    for (const address of [
      "not-an-address",
      "1.2.3",
      "1.2.3.4.5",
      "999.0.0.1",
      "::gg",
      "fe80::1%eth0",
      "",
    ]) {
      expect(refusal(address).code).toBe("unparsable");
    }
  });

  it("refuses supplied and enumerated interface addresses", () => {
    const own = publicUnicastPolicy({ own: ["93.184.216.34", "2606:4700::1"] });
    expect(refusal("93.184.216.34", own)).toMatchObject({
      code: "own-interface",
      detail: "a local interface address of the host bob runs on",
    });
    expect(refusal("2606:4700::1", own).code).toBe("own-interface");
    // The same addresses are accepted when they are not the host's.
    expect(policy.classify("93.184.216.34")).toEqual({ allowed: true });

    // The default policy refuses this host's real addresses.
    const ownAddresses = ownInterfaceAddresses();
    const defaultPolicy = publicUnicastPolicy();
    expect(ownAddresses.length).toBeGreaterThan(0);
    for (const address of ownAddresses) {
      expect(defaultPolicy.classify(address).allowed).toBe(false);
    }
  });

  it("reads the canonical literal forms WHATWG URL produces", () => {
    expect(parseAddress("127.0.0.1")).toEqual({ family: 4, bytes: [127, 0, 0, 1] });
    expect(parseAddress("[::ffff:a00:1]")?.bytes.slice(12)).toEqual([10, 0, 0, 1]);
    expect(parseAddress("2001:db8::1")?.bytes.slice(0, 4)).toEqual([0x20, 0x01, 0x0d, 0xb8]);
    expect(parseAddress("1.2.3")).toBeUndefined();
    expect(parseAddress("::ffff:1.2.3.4.5")).toBeUndefined();
    expect(parseAddress("1::2::3")).toBeUndefined();
  });
});

describe("URL admission", () => {
  const urlPolicy = (allowHttp = false, ports: readonly number[] = WEB_PORTS): UrlPolicy => ({
    allowHttp,
    ports,
    address: policy,
  });

  const refuser = (fn: () => unknown): WebFetchError => {
    try {
      fn();
    } catch (error) {
      if (error instanceof WebFetchError) return error;
      throw error;
    }
    throw new Error("expected a refusal");
  };

  it("allows https on 443 and http on 80 only when the operator allows it", () => {
    expect(admitUrl("https://example.test/page", urlPolicy()).href).toBe(
      "https://example.test/page",
    );
    expect(refuser(() => admitUrl("http://example.test/", urlPolicy(false))).code).toBe(
      "http-not-allowed",
    );
    expect(admitUrl("http://example.test/", urlPolicy(true)).protocol).toBe("http:");
  });

  it("refuses a scheme that is not http or https", () => {
    for (const url of [
      "ftp://example.test/x",
      "file:///etc/passwd",
      "data:text/html,x",
      "ws://example.test/",
    ]) {
      expect(refuser(() => admitUrl(url, urlPolicy(true))).code).toBe("scheme");
    }
  });

  it("refuses a port other than 443 and 80", () => {
    for (const url of [
      "https://example.test:8443/",
      "http://example.test:8080/",
      "https://example.test:3000/",
    ]) {
      expect(refuser(() => admitUrl(url, urlPolicy(true))).code).toBe("port");
    }
    expect(admitUrl("https://example.test:443/", urlPolicy()).port).toBe("");
    expect(admitUrl("http://example.test:80/", urlPolicy(true)).host).toBe("example.test");
  });

  it("refuses userinfo and zone identifiers", () => {
    expect(refuser(() => admitUrl("https://user:pw@example.test/", urlPolicy())).code).toBe(
      "userinfo",
    );
    expect(refuser(() => admitUrl("https://user@example.test/", urlPolicy())).code).toBe(
      "userinfo",
    );
    expect(refuser(() => admitUrl("https://[fe80::1%25eth0]/", urlPolicy())).code).toBe(
      "zone-identifier",
    );
    expect(hasZoneIdentifier("https://[fe80::1%25eth0]/")).toBe(true);
    expect(hasZoneIdentifier("https://example.test/a%20b")).toBe(false);
  });

  it("refuses to downgrade https to http, whatever allow_http says", () => {
    const from = new URL("https://example.test/");
    const refused = refuser(() => admitUrl("http://example.test/next", urlPolicy(true), { from }));
    expect(refused.code).toBe("downgrade");
    // The default port is what makes it a downgrade, not the port rule.
    expect(admitUrl("https://example.test/next", urlPolicy(true), { from }).protocol).toBe(
      "https:",
    );
  });

  it("refuses to parse a URL it cannot read, without echoing it", () => {
    const refused = refuser(() => admitUrl("not a url", urlPolicy()));
    expect(refused.code).toBe("url-invalid");
    expect(refused.detail).not.toContain("not a url");
  });

  it("vets a canonical literal before dispatch, in every notation", () => {
    const cases: ReadonlyArray<[string, string]> = [
      ["http://127.0.0.1/", "127.0.0.1"],
      ["http://127.1/", "127.0.0.1"],
      ["http://0x7f.0.0.1/", "127.0.0.1"],
      ["http://2130706433/", "127.0.0.1"],
      ["http://0177.0.0.1/", "127.0.0.1"],
      ["http://[::1]/", "::1/128"],
      ["http://[::ffff:127.0.0.1]/", "IPv4-mapped"],
      ["http://[0:0:0:0:0:0:0:1]/", "::1/128"],
      ["https://10.0.0.1/", "10.0.0.0/8"],
    ];
    for (const [url, names] of cases) {
      const refused = refuser(() => admitUrl(url, urlPolicy(true)));
      expect(refused.code).toBe("address");
      expect(refused.detail).toContain(names);
    }
  });

  it("returns the parsed URL the caller dispatches, not the raw string", () => {
    const url = admitUrl("https://Example.TEST/a/../b?q=1#frag", urlPolicy());
    expect(url.hostname).toBe("example.test");
    expect(url.href).toBe("https://example.test/b?q=1#frag");
  });

  it("pins the ports a URL may use", () => {
    expect([...WEB_PORTS]).toEqual([443, 80]);
  });
});
