// Node-side harness for the discord capability's REST-connection test.
//
// The defect this backs is Node-specific: @discordjs/rest's default request
// strategy uses the `undici` package the lockfile pins, undici negotiates
// HTTP/2, and Node's HTTP/2 client tags the response headers object with a
// `Symbol(sensitiveHeaders)` key that undici's Headers constructor rejects. Bun
// never takes that path (it uses its own fetch), so the real request has to run
// under Node — this harness is that request.
//
// It starts a local HTTP/2 (TLS) server, runs the capability's DiscordJsClient
// against it exactly as the capability constructs it, and reports — as one JSON
// line on stdout — what the server received and what the client resolved.
//
// Invoked as: node rest-harness.mjs <tls-dir> <token>
// <tls-dir> holds key.pem + cert.pem; the caller sets NODE_EXTRA_CA_CERTS to
// <tls-dir>/cert.pem so the client trusts the server.

import fs from "node:fs";
import http2 from "node:http2";
import { Agent, request as undiciRequest } from "undici";
import { DiscordJsClient } from "../../../dist/capabilities/discord/discord-js-client.js";

const [tlsDir, token] = process.argv.slice(2);
if (!tlsDir || !token) {
  console.error("usage: node rest-harness.mjs <tls-dir> <token>");
  process.exit(2);
}

// The raw Discord API payload (snake_case + a mentions array) the REST layer
// parses. Kept here so the caller can assert the client resolved with it.
const MESSAGES = [
  {
    id: "m1",
    channel_id: "123456",
    author: { id: "111", username: "alice" },
    content: "hi",
    mentions: [{ id: "999" }],
  },
  {
    id: "m2",
    channel_id: "123456",
    author: { id: "222", username: "bobby" },
    content: "yo",
    mentions: [],
  },
];

const server = http2.createSecureServer({
  key: fs.readFileSync(`${tlsDir}/key.pem`),
  cert: fs.readFileSync(`${tlsDir}/cert.pem`),
  allowHTTP1: true,
});

// Record the Authorization header the request arrives with, and the HTTP
// version the server negotiated for it. Node's HTTP/2 server emits the
// HTTP/1-compatible "request" event for h2 streams too, so one handler covers
// both the h2 path (the pinned undici's default, and the transport bob#217's
// failure used) and the HTTP/1.1 path a plain fetch takes.
const versions = [];
let authorization;
server.on("request", (req, res) => {
  versions.push(req.httpVersion);
  authorization = req.headers.authorization;
  res.setHeader("content-type", "application/json");
  // Mirror the reported Discord response, which carried a Set-Cookie header.
  res.setHeader("set-cookie", "bob_fixture=1; Path=/");
  res.end(JSON.stringify(MESSAGES));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();
const apiBase = `https://127.0.0.1:${port}`;

// The capability's own client, constructed the way the capability constructs it.
// Only the REST API base is pointed at the local server.
const client = new DiscordJsClient({ token, botUserId: "999" });
client.client.rest.options.api = apiBase;

let result;
try {
  const messages = await client.fetchRecent("123456", 5);
  result = { ok: true, authorization, messages, protocol: versions[0] };
} catch (err) {
  result = {
    ok: false,
    authorization,
    protocol: versions[0],
    error: err instanceof Error ? err.message : String(err),
  };
}

// Probe the fixture through the pinned undici's OWN transport, to show it
// negotiates HTTP/2 — the transport bob#217's failure used. The fixed client
// makes its call with the runtime's fetch instead. A short keep-alive keeps the
// harness from lingering on the probe's socket.
const probeAgent = new Agent({ keepAliveTimeout: 1, keepAliveMaxTimeout: 1 });
try {
  const probe = await undiciRequest(`${apiBase}/probe`, { dispatcher: probeAgent });
  await probe.body.dump();
  result.probeProtocol = versions[1];
} catch (err) {
  result.probeProtocol = `error: ${err instanceof Error ? err.message : String(err)}`;
} finally {
  await probeAgent.close();
}

server.close();
console.log(JSON.stringify(result));
