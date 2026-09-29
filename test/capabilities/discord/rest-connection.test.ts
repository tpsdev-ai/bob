// The discord capability's REST client must actually connect.
//
// bob#217: under Node, @discordjs/rest's default request strategy builds the
// response with `new Headers(res.headers)`. undici negotiates HTTP/2 (undici 8
// enables it by default, and Discord's edge serves it), and Node's HTTP/2
// client tags that headers object with a `Symbol(sensitiveHeaders)` key, which
// undici's Headers constructor rejects — every REST call fails and the agent
// never sends or receives a Discord message.
//
// Bun never takes that path (it uses its own fetch), so this test runs the real
// request under Node through a fixture harness (test/fixtures/discord/
// rest-harness.mjs). It asserts the acceptance from bob#217: the request arrives
// with an `Authorization: Bot <token>` header, and the client resolves with the
// server's JSON — using the capability's own client, not a hand-built one.
import { afterAll, expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The real request runs under Node (the runtime where the defect appears), so
// the harness is a .mjs the test drives. Bun's own runtime cannot reproduce it.
const HARNESS = fileURLToPath(new URL("../../fixtures/discord/rest-harness.mjs", import.meta.url));
const HARNESS_TIMEOUT_MS = 20_000;

const TOKEN = "test-bot-token";
const CHANNEL_ID = "123456";

// The client's own mapping of the harness server's raw API payload.
const EXPECTED_MESSAGES = [
  {
    id: "m1",
    channelId: CHANNEL_ID,
    authorId: "111",
    authorName: "alice",
    content: "hi",
    mentionsBot: true,
  },
  {
    id: "m2",
    channelId: CHANNEL_ID,
    authorId: "222",
    authorName: "bobby",
    content: "yo",
    mentionsBot: false,
  },
];

interface HarnessSummary {
  ok: boolean;
  authorization?: string;
  messages?: unknown;
  protocol?: string;
  probeProtocol?: string;
  error?: string;
}

const tlsDir = mkdtempSync(join(tmpdir(), "bob-discord-rest-"));
afterAll(() => rmSync(tlsDir, { recursive: true, force: true }));

// A self-signed cert with an IP SAN (openssl, which the CI image ships). The
// server is HTTP/2 over TLS; the client is told to trust it via
// NODE_EXTRA_CA_CERTS.
function makeCert(): void {
  writeFileSync(
    join(tlsDir, "openssl.cnf"),
    [
      "[req]",
      "distinguished_name=dn",
      "x509_extensions=v3",
      "prompt=no",
      "[dn]",
      "CN=localhost",
      "[v3]",
      "subjectAltName=IP:127.0.0.1,DNS:localhost",
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

function runHarness(): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [HARNESS, tlsDir, TOKEN], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: join(tlsDir, "cert.pem") },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), HARNESS_TIMEOUT_MS);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test("the discord REST client sends an authed request and reads the response", async () => {
  makeCert();
  const { code, stdout, stderr } = await runHarness();
  if (code !== 0) {
    throw new Error(`harness exited ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);
  }

  const summary = JSON.parse(stdout.trim()) as HarnessSummary;
  if (!summary.ok) {
    // On unmodified main this is the bob#217 failure:
    // "Headers constructor: Key Symbol(sensitiveHeaders) in init is a symbol ..."
    throw new Error(`REST request failed: ${summary.error ?? "unknown error"}`);
  }

  // The request arrived, authenticated, at the local server.
  expect(summary.authorization).toBe(`Bot ${TOKEN}`);
  // And the client resolved with the server's JSON.
  expect(summary.messages).toEqual(EXPECTED_MESSAGES);

  // The fixture is an HTTP/2 endpoint: through the pinned undici's own
  // transport it negotiates h2 — the transport bob#217's failure used — so the
  // mutation (undoing the fix) reproduces the reported h2 failure against this
  // same server. The fixed client makes its own call with the runtime's fetch
  // (see summary.protocol).
  expect(summary.probeProtocol).toBe("2.0");
});
