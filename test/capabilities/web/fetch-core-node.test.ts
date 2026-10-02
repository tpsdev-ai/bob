// The web fetch core's transport tests (bob#245 — web spec v3, slice R1b).
//
// The core is driven against REAL HTTP and HTTPS peers on loopback with
// OS-assigned ports. Its transport is an owned undici Agent whose connector
// vets DNS answers, and Bun resolves `undici` to its own implementation, whose
// Agent takes no dispatcher options — so the run happens under Node (the
// runtime bob ships on) through test/fixtures/web/fetch-harness.mjs, which
// reports what each case observed as ONE JSON line. Every assertion is here.
//
// The harness injects the loopback address policy, ephemeral ports, DNS lookup,
// TLS CA and a shorter deadline for deadline cases. The production deadline
// constant is pinned separately. Caps, redirect limit, headers, content types,
// extraction and text limit use their production values.

import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { USER_AGENT } from "../../../src/capabilities/web/index.js";

const HARNESS = fileURLToPath(new URL("../../fixtures/web/fetch-harness.mjs", import.meta.url));
const DIST_CORE = fileURLToPath(
  new URL("../../../dist/capabilities/web/index.js", import.meta.url),
);
const HARNESS_TIMEOUT_MS = 120_000;

// A self-signed cert with an IP SAN, generated with openssl (the CI image ships
// it). The harness gives it to both the HTTPS peer and the fetch core's TLS CA.
function makeCert(tlsDir: string): void {
  writeFileSync(
    join(tlsDir, "openssl.cnf"),
    [
      "[req]",
      "distinguished_name=dn",
      "x509_extensions=v3",
      "prompt=no",
      "[dn]",
      "CN=peer.test",
      "[v3]",
      "subjectAltName=IP:127.0.0.1,DNS:peer.test",
      "basicConstraints=critical,CA:TRUE",
      "keyUsage=critical,digitalSignature,keyCertSign",
      "",
    ].join("\n"),
  );
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      join(tlsDir, "key.pem"),
      "-out",
      join(tlsDir, "cert.pem"),
      "-days",
      "2",
      "-config",
      join(tlsDir, "openssl.cnf"),
    ],
    { stdio: "ignore" },
  );
}

function runHarness(
  tlsDir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [HARNESS, tlsDir], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), HARNESS_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

interface Refusal {
  code: string | null;
  detail: string | null;
}

interface CaseReport {
  ok: boolean;
  error?: string;
  [key: string]: unknown;
}

interface HarnessReport {
  caseNames: string[];
  cases: Record<string, CaseReport>;
}

// The cases the harness must run, in the order it runs them. A case that
// disappears fails this test rather than passing quietly.
const CASE_NAMES = [
  "https-page",
  "vetted-address",
  "mixed-answer",
  "literal-notation",
  "http-default-off",
  "port-not-allowed",
  "redirects",
  "redirect-relookup",
  "redirect-private",
  "redirect-scheme",
  "downgrade",
  "redirect-no-location",
  "redirect-stream",
  "encoded-cap",
  "decoded-cap",
  "content-encoding",
  "content-type",
  "content-type-stream",
  "allowed-types",
  "text-limit",
  "deadline",
  "proxy-env",
  "global-dispatcher",
  "network-failure",
  "body-reset",
];

let report: HarnessReport;

test(
  "the fetch core's transport, over real loopback peers, under Node",
  async () => {
    const tlsDir = mkdtempSync(join(tmpdir(), "bob-web-fetch-"));
    try {
      if (!existsSync(DIST_CORE)) {
        throw new Error(`the harness runs the built core; ${DIST_CORE} is missing — run the build`);
      }
      makeCert(tlsDir);
      const { code, stdout, stderr } = await runHarness(tlsDir);
      if (code !== 0) {
        throw new Error(`harness exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);
      }
      const lines = stdout.trim().split("\n");
      report = JSON.parse(lines[lines.length - 1]) as HarnessReport;

      // The harness ran exactly the cases this test asserts.
      expect(report.caseNames).toEqual(CASE_NAMES);
      for (const name of CASE_NAMES) {
        const observed = report.cases[name];
        expect(observed).toBeDefined();
        if (observed?.ok !== true) {
          throw new Error(`case ${name} did not run: ${String(observed?.error)}`);
        }
      }
    } finally {
      rmSync(tlsDir, { recursive: true, force: true });
    }
  },
  HARNESS_TIMEOUT_MS,
);

const seen = (name: string): Record<string, unknown> => {
  const observed = report.cases[name];
  if (observed === undefined) throw new Error(`case ${name} is missing from the report`);
  return observed;
};
const refusal = (name: string, key = "refusal"): Refusal => seen(name)[key] as Refusal;

test("fetches an HTTPS page with fixed User-Agent and Accept and no credential headers", () => {
  const observed = seen("https-page");
  expect(observed.status).toBe(200);
  expect(observed.contentType).toBe("text/html");
  expect(observed.truncated).toBe(false);
  expect(String(observed.finalUrl)).toMatch(/^https:\/\/peer\.test:\d+\/start$/);
  expect(observed.text).toMatch(/^Title\n\nHello next \(https:\/\/peer\.test:\d+\/next\)$/);
  expect(observed.userAgent).toBe(USER_AGENT);
  expect(String(observed.userAgent)).toMatch(/^bob\/\d+\.\d+\.\d+/);
  expect(observed.acceptHeader).toBe(
    "text/html, text/plain, text/markdown, application/json, application/xml, text/xml, application/rss+xml, application/atom+xml",
  );
  expect(observed.requestCount).toBe(1);
  expect(observed.requestMethods).toEqual(["GET"]);
  expect(observed.requestUrls).toEqual(["/start"]);
  expect(observed.connections).toBe(1);
  const headers = (observed.headers as Array<Record<string, unknown>>)[0];
  expect(headers.userAgent).toBe(USER_AGENT);
  expect(headers.accept).toBe(observed.acceptHeader);
  expect(String(headers.host)).toMatch(/^peer\.test:\d+$/);
  expect(headers.hasCookie).toBe(false);
  expect(headers.hasAuthorization).toBe(false);
  expect(headers.hasReferer).toBe(false);
  expect(headers.hasProxyAuthorization).toBe(false);
});

test("connects to an address the lookup vetted, resolving the name once", () => {
  const observed = seen("vetted-address");
  expect(observed.text).toBe("vetted");
  expect(observed.lookupCalls).toEqual(["peer.test"]);
  expect(observed.classified).toContain("127.0.0.1");
  expect(observed.connections).toBe(1);
  expect(observed.requestCount).toBe(1);
});

test("refuses a mixed DNS answer before any connection", () => {
  expect(refusal("mixed-answer").code).toBe("address");
  expect(String(refusal("mixed-answer").detail)).toContain(
    'iana-ipv4-special-registry 10.0.0.0/8 "Private-Use"',
  );
  expect(seen("mixed-answer").connections).toBe(0);
  expect(seen("mixed-answer").requestCount).toBe(0);
});

test("vets a canonical literal in every notation, before any connection", () => {
  const observed = seen("literal-notation");
  const refusals = observed.refusedNotations as Refusal[];
  expect(refusals.length).toBe(5);
  for (const refusal of refusals) {
    expect(refusal.code).toBe("address");
    expect(String(refusal.detail)).toContain('iana-ipv4-special-registry 127.0.0.0/8 "Loopback"');
  }
  expect(observed.connectionsAfterRefusals).toBe(0);
  // The same URL works when the policy allows the address: the refusals above
  // were the address, not the port.
  expect(observed.allowedText).toBe("literal");
  expect(observed.connectionsAfterAllowed).toBe(1);
});

test("refuses plain HTTP unless the operator allows it", () => {
  expect(refusal("http-default-off").code).toBe("http-not-allowed");
  expect(seen("http-default-off").connectionsAfterRefusal).toBe(0);
  expect(seen("http-default-off").allowedText).toBe("plain");
});

test("refuses a port outside the allowed set before any connection", () => {
  expect(refusal("port-not-allowed").code).toBe("port");
  expect(seen("port-not-allowed").connections).toBe(0);
});

test("follows redirects by hand, at most five, resolving relative targets", () => {
  const observed = seen("redirects");
  expect(observed.five).toEqual({
    status: 200,
    text: "done",
    finalUrl: expect.stringMatching(/^http:\/\/peer\.test:\d+\/hop\/0$/),
  });
  expect(observed.requestsForFive).toBe(6);
  expect(observed.methods).toEqual(["GET", "GET", "GET", "GET", "GET", "GET"]);
  for (const headers of observed.headers as Array<Record<string, unknown>>) {
    expect(headers.hasCookie).toBe(false);
    expect(headers.hasAuthorization).toBe(false);
    expect(headers.hasReferer).toBe(false);
  }
  expect(observed.maxRedirects).toBe(5);
  expect((observed.six as Refusal).code).toBe("redirect-limit");
});

test("opens a fresh vetted connection for each completed same-origin redirect hop", () => {
  const observed = seen("redirect-relookup");
  expect(observed.allowedText).toBe("done");
  expect(observed.allowedLookups).toEqual(["peer.test", "peer.test"]);
  expect(observed.allowedConnections).toBe(2);
  expect(observed.allowedRequests).toBe(2);
  expect((observed.denied as Refusal).code).toBe("address");
  expect(observed.deniedLookups).toBe(2);
  expect(observed.deniedConnections).toBe(1);
  expect(observed.deniedRequests).toBe(1);
});

test("refuses a redirect to a private address, and the private peer sees nothing", () => {
  expect(refusal("redirect-private").code).toBe("address");
  expect(String(refusal("redirect-private").detail)).toContain(
    'iana-ipv4-special-registry 127.0.0.0/8 "Loopback"',
  );
  expect(seen("redirect-private").internalConnections).toBe(0);
  expect(seen("redirect-private").frontRequests).toBe(1);
});

test("refuses a redirect to another scheme", () => {
  const results = seen("redirect-scheme").results as Array<{
    location: string;
    refusal: Refusal;
    connections: number;
  }>;
  expect(results.map((result) => result.location)).toEqual([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://peer.test/x",
  ]);
  for (const result of results) {
    expect(result.refusal.code).toBe("scheme");
    expect(result.connections).toBe(1);
  }
});

test("never downgrades an https URL to http, and allows an http to https hop", () => {
  const observed = seen("downgrade");
  expect((observed.downgrade as Refusal).code).toBe("downgrade");
  expect(observed.plainConnectionsAfterDowngrade).toBe(0);
  const upgrade = observed.upgrade as { status: number; text: string; finalUrl: string };
  expect(upgrade.status).toBe(200);
  expect(upgrade.text).toBe("secure");
  expect(upgrade.finalUrl).toMatch(/^https:\/\/peer\.test:\d+\/end$/);
});

test("returns a redirect status with no Location as the final response", () => {
  const observed = seen("redirect-no-location");
  expect(observed.status).toBe(302);
  expect(observed.text).toBe("no target");
  expect(observed.requestCount).toBe(1);
});

test("terminates a streaming redirect body before following its target", () => {
  const observed = seen("redirect-stream");
  expect(observed.text).toBe("target");
  expect(observed.requestCount).toBe(2);
  expect(Number(observed.abortedResponses)).toBeGreaterThan(0);
});

test("caps the encoded body at 5 MB while streaming", () => {
  const observed = seen("encoded-cap");
  expect(observed.cap).toBe(5 * 1024 * 1024);
  expect(refusal("encoded-cap").code).toBe("too-large");
  expect(String(refusal("encoded-cap").detail)).toContain("encoded");
  expect(String(refusal("encoded-cap").detail)).toContain(String(5 * 1024 * 1024));
  expect(Number(observed.abortedResponses)).toBeGreaterThan(0);
});

test("caps the decoded body at 5 MB while streaming", () => {
  const observed = seen("decoded-cap");
  expect(observed.cap).toBe(5 * 1024 * 1024);
  // The encoded body is well under the cap: the refusal is the decoded one.
  expect(Number(observed.encodedLength)).toBeLessThan(5 * 1024 * 1024);
  expect(refusal("decoded-cap").code).toBe("too-large");
  expect(String(refusal("decoded-cap").detail)).toContain("decoded");
});

test("refuses a content-encoding it does not decode, and a body it cannot decode", () => {
  expect(refusal("content-encoding", "unsupportedRefusal").code).toBe("content-encoding");
  expect(String(refusal("content-encoding", "unsupportedRefusal").detail)).toContain("zstd");
  expect(refusal("content-encoding", "corruptRefusal").code).toBe("content-encoding");
  expect(String(refusal("content-encoding", "corruptRefusal").detail)).toContain(
    "could not be decoded as gzip",
  );
});

test("refuses a content type it does not extract, naming the type", () => {
  expect(refusal("content-type", "pdfRefusal").code).toBe("content-type");
  expect(String(refusal("content-type", "pdfRefusal").detail)).toContain("application/pdf");
  expect(refusal("content-type", "noneRefusal").code).toBe("content-type");
  expect(String(refusal("content-type", "noneRefusal").detail)).toContain("(none)");
});

test("terminates a streaming body with a rejected content type", () => {
  const observed = seen("content-type-stream");
  expect(refusal("content-type-stream").code).toBe("content-type");
  expect(Number(observed.abortedResponses)).toBeGreaterThan(0);
});

test("returns every allowed content type as its text", () => {
  const observed = seen("allowed-types").observed as Array<{
    type: string;
    contentType: string;
    text: string;
  }>;
  expect(observed).toEqual([
    { type: "text/plain", contentType: "text/plain", text: "plain text" },
    { type: "text/markdown", contentType: "text/markdown", text: "# heading\n\nbody" },
    { type: "application/json", contentType: "application/json", text: '{"a":1}' },
    { type: "application/xml", contentType: "application/xml", text: "<a>1</a>" },
    { type: "text/xml", contentType: "text/xml", text: "<b>2</b>" },
    { type: "application/rss+xml", contentType: "application/rss+xml", text: "<rss/>" },
    { type: "application/atom+xml", contentType: "application/atom+xml", text: "<feed/>" },
    { type: "text/html; charset=utf-8", contentType: "text/html", text: "html body" },
  ]);
});

test("takes the operator's ceiling as the limit, and a lower one from the caller", () => {
  const observed = seen("text-limit");
  expect(observed.ceiling).toEqual({ length: 1000, truncated: true });
  expect(observed.lower).toEqual({ text: "x".repeat(20), truncated: true });
  expect(observed.raised).toEqual({ length: 1000, truncated: true });
  expect(observed.resolved).toEqual({
    undefined: 20_000,
    zero: 1,
    negative: 1,
    fractional: 1,
    lowerThanCeiling: 100,
    aboveAbsoluteCeiling: 100_000,
    nan: 20_000,
    infinity: 20_000,
  });
});

test("holds one deadline for the whole operation", () => {
  expect(refusal("deadline").code).toBe("deadline");
  expect(String(refusal("deadline").detail)).toContain("300");
  expect(seen("deadline").totalDeadlineMs).toBe(15_000);
});

test("ignores the proxy environment", () => {
  expect(seen("proxy-env").text).toBe("direct");
  expect(seen("proxy-env").proxyConnections).toBe(0);
});

test("never uses the global dispatcher", () => {
  expect(seen("global-dispatcher").text).toBe("owned dispatcher");
  expect(seen("global-dispatcher").globalDispatcherUsed).toBe(false);
});

test("refuses a network failure as a network failure", () => {
  expect(refusal("network-failure", "lookupRefusal").code).toBe("network");
  expect(String(refusal("network-failure", "lookupRefusal").detail)).toBe("ENOTFOUND");
  expect(refusal("network-failure", "closedRefusal").code).toBe("network");
  expect(String(refusal("network-failure", "closedRefusal").detail)).toBe("ECONNREFUSED");
});

test("reports a peer reset after response headers as a bounded network refusal", () => {
  const observed = seen("body-reset");
  expect(refusal("body-reset").code).toBe("network");
  expect(String(refusal("body-reset").detail)).toMatch(/^(ECONNRESET|UND_ERR_SOCKET|SocketError)$/);
  expect(observed.requestCount).toBe(1);
  expect(observed.connections).toBe(1);
});
