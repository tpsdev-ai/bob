// Node-side harness for the web fetch core's transport tests (bob#245 — web
// spec v3, slice R1b).
//
// WHY NODE. The core builds an owned undici Agent and vets addresses in its
// connector's `lookup`. Bun resolves `undici` to its own implementation, whose
// Agent takes no dispatcher options, so the real transport only exists under
// Node — which is also the runtime bob ships on. This harness is that run: it
// starts real HTTP and HTTPS peers on loopback with OS-assigned ports, drives
// the compiled core against them, and prints ONE JSON line of what each case
// observed. Every assertion lives in the bun test that drives this file.
//
// Invoked as: node fetch-harness.mjs <tls-dir> [redirect-private-skip-reason]
// <tls-dir> holds cert.pem + key.pem for the HTTPS peer. The optional reason is
// present only when the parent setup could not bind 127.0.0.2.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { gzipSync } from "node:zlib";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import {
  ACCEPT_HEADER,
  fetchDocument,
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  publicUnicastPolicy,
  resolveMaxChars,
  resolveWebSettings,
  TOTAL_DEADLINE_MS,
  USER_AGENT,
} from "../../../dist/capabilities/web/index.js";

const tlsDir = process.argv[2];
if (!tlsDir) {
  console.error("usage: node fetch-harness.mjs <tls-dir>");
  process.exit(2);
}
const certificate = readFileSync(`${tlsDir}/cert.pem`, "utf8");
const privateKey = readFileSync(`${tlsDir}/key.pem`, "utf8");
const redirectPrivateSkipReason = process.argv[3];

const LOOPBACK = "127.0.0.1";
const allowHttp = () => resolveWebSettings({ allow_http: true });
const httpsOnly = () => resolveWebSettings({});

// ── peers ──────────────────────────────────────────────────────────────────

const peers = [];

function trackPeer(server, port, address) {
  const requests = [];
  const sockets = new Set();
  let connections = 0;
  let aborted = 0;
  server.on("connection", (socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  const peer = {
    port,
    address,
    requests,
    connections: () => connections,
    abortedResponses: () => aborted,
    close: () =>
      new Promise((resolve, reject) => {
        for (const socket of sockets) socket.destroy();
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
  peers.push(peer);
  return {
    peer,
    handler: (req, res) => {
      requests.push({ method: req.method ?? "", url: req.url ?? "", headers: { ...req.headers } });
      res.on("close", () => {
        if (!res.writableFinished) aborted += 1;
      });
    },
    countAbort: () => {
      aborted += 1;
    },
  };
}

function listen(server, address) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, address);
  });
}

async function httpPeer(handler, address = LOOPBACK) {
  let wrap;
  const server = createServer((req, res) => {
    wrap.handler(req, res);
    handler(req, res);
  });
  wrap = trackPeer(server, 0, address);
  await listen(server, address);
  wrap.peer.port = server.address().port;
  return wrap.peer;
}

async function httpsPeer(handler, address = LOOPBACK) {
  let wrap;
  const server = createHttpsServer({ cert: certificate, key: privateKey }, (req, res) => {
    wrap.handler(req, res);
    handler(req, res);
  });
  wrap = trackPeer(server, 0, address);
  await listen(server, address);
  wrap.peer.port = server.address().port;
  return wrap.peer;
}

// ── the seams a loopback case needs ────────────────────────────────────────

// Add the named addresses to public-unicast classification; all others use
// that real policy with own-address exclusions disabled for these tests.
function testPolicy(allowed) {
  const base = publicUnicastPolicy({ own: [] });
  return {
    version: base.version,
    classify: (address) => (allowed.includes(address) ? { allowed: true } : base.classify(address)),
  };
}

function cannedLookup(answers, onCall) {
  return (hostname, _options, callback) => {
    if (onCall) onCall(hostname);
    callback(null, answers);
  };
}

function depsFor(peer, over = {}) {
  return {
    addressPolicy: testPolicy([LOOPBACK]),
    ports: [peer.port],
    lookup: cannedLookup([{ address: LOOPBACK, family: 4 }]),
    ...(peer.address === "127.0.0.2" ? {} : {}),
    ...over,
  };
}

const url = (peer, path = "/", scheme = "http") => `${scheme}://peer.test:${peer.port}${path}`;

// The refusal a promise produced, as observations. Never throws: a missing
// refusal is recorded as a null code, and the bun test fails on it.
async function refusalOf(promise) {
  try {
    await promise;
    return { code: null, detail: null };
  } catch (error) {
    return {
      code: error?.code ?? error?.name ?? "unknown",
      detail: error?.detail ?? String(error?.message ?? error),
    };
  }
}

const headerSubset = (headers) => ({
  userAgent: headers["user-agent"] ?? null,
  accept: headers.accept ?? null,
  host: headers.host ?? null,
  hasCookie: "cookie" in headers,
  hasAuthorization: "authorization" in headers,
  hasReferer: "referer" in headers,
  hasProxyAuthorization: "proxy-authorization" in headers,
});

// ── cases ──────────────────────────────────────────────────────────────────

const cases = {};
const skippedCases = new Map();
if (redirectPrivateSkipReason !== undefined) {
  skippedCases.set("redirect-private", redirectPrivateSkipReason);
}
const record = async (name, fn) => {
  const skipReason = skippedCases.get(name);
  if (skipReason !== undefined) {
    cases[name] = { ok: false, skipped: skipReason };
    return;
  }
  try {
    cases[name] = { ok: true, ...(await fn()) };
  } catch (error) {
    cases[name] = { ok: false, error: String(error?.stack ?? error) };
  } finally {
    // A case can fail after opening a peer, including during listen. Close all
    // its peers before starting the next case, even if one teardown fails.
    const results = await Promise.allSettled(peers.splice(0).map((peer) => peer.close()));
    for (const result of results) {
      if (result.status === "rejected") {
        cases[name] = { ok: false, error: `peer teardown failed: ${String(result.reason)}` };
      }
    }
  }
};

await record("https-page", async () => {
  const peer = await httpsPeer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<html><body><h1>Title</h1><p>Hello <a href="/next">next</a></p></body></html>');
  });
  const result = await fetchDocument(
    url(peer, "/start", "https"),
    { settings: httpsOnly() },
    depsFor(peer, { tlsCa: certificate }),
  );
  return {
    status: result.status,
    contentType: result.contentType,
    finalUrl: result.finalUrl,
    truncated: result.truncated,
    text: result.text,
    userAgent: USER_AGENT,
    acceptHeader: ACCEPT_HEADER,
    requestCount: peer.requests.length,
    requestMethods: peer.requests.map((r) => r.method),
    requestUrls: peer.requests.map((r) => r.url),
    headers: peer.requests.map((r) => headerSubset(r.headers)),
    connections: peer.connections(),
  };
});

await record("vetted-address", async () => {
  const peer = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("vetted");
  });
  const classified = [];
  const base = testPolicy([LOOPBACK]);
  const calls = [];
  const result = await fetchDocument(
    url(peer),
    { settings: allowHttp() },
    {
      addressPolicy: {
        version: base.version,
        classify: (address) => {
          classified.push(address);
          return base.classify(address);
        },
      },
      ports: [peer.port],
      lookup: cannedLookup([{ address: LOOPBACK, family: 4 }], (hostname) => calls.push(hostname)),
    },
  );
  return {
    text: result.text,
    lookupCalls: calls,
    classified,
    connections: peer.connections(),
    requestCount: peer.requests.length,
  };
});

await record("mixed-answer", async () => {
  const peer = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("never");
  });
  const refusal = await refusalOf(
    fetchDocument(
      url(peer),
      { settings: allowHttp() },
      {
        ...depsFor(peer),
        lookup: cannedLookup([
          { address: LOOPBACK, family: 4 },
          { address: "10.0.0.1", family: 4 },
        ]),
      },
    ),
  );
  return { refusal, connections: peer.connections(), requestCount: peer.requests.length };
});

await record("literal-notation", async () => {
  const peer = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("literal");
  });
  const strict = testPolicy([]);
  const notations = [
    `127.0.0.1:${peer.port}`,
    `127.1:${peer.port}`,
    `0x7f.0.0.1:${peer.port}`,
    `2130706433:${peer.port}`,
    `0177.0.0.1:${peer.port}`,
  ];
  const refusedNotations = [];
  for (const host of notations) {
    refusedNotations.push(
      await refusalOf(
        fetchDocument(
          `http://${host}/`,
          { settings: allowHttp() },
          {
            ...depsFor(peer, { addressPolicy: strict }),
          },
        ),
      ),
    );
  }
  const afterRefusals = peer.connections();
  const allowed = await fetchDocument(url(peer), { settings: allowHttp() }, depsFor(peer));
  return {
    refusedNotations,
    connectionsAfterRefusals: afterRefusals,
    allowedText: allowed.text,
    connectionsAfterAllowed: peer.connections(),
  };
});

await record("http-default-off", async () => {
  const peer = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("plain");
  });
  const refusal = await refusalOf(
    fetchDocument(url(peer), { settings: httpsOnly() }, depsFor(peer)),
  );
  const connectionsAfterRefusal = peer.connections();
  const allowed = await fetchDocument(url(peer), { settings: allowHttp() }, depsFor(peer));
  return { refusal, connectionsAfterRefusal, allowedText: allowed.text };
});

await record("port-not-allowed", async () => {
  const peer = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("never");
  });
  const refusal = await refusalOf(
    fetchDocument(
      url(peer),
      { settings: allowHttp() },
      { ...depsFor(peer), ports: [peer.port + 1] },
    ),
  );
  return { refusal, connections: peer.connections() };
});

await record("redirects", async () => {
  const peer = await httpPeer((req, res) => {
    const match = /^\/hop\/(\d+)$/.exec(req.url ?? "");
    if (match === null) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("no");
      return;
    }
    const hops = Number(match[1]);
    if (hops === 0) {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("done");
      return;
    }
    res.writeHead(302, { location: `/hop/${hops - 1}` });
    res.end();
  });
  const five = await fetchDocument(url(peer, "/hop/5"), { settings: allowHttp() }, depsFor(peer));
  const requestsForFive = peer.requests.length;
  const methods = peer.requests.map((r) => r.method);
  const headers = peer.requests.map((r) => headerSubset(r.headers));
  const six = await refusalOf(
    fetchDocument(url(peer, "/hop/6"), { settings: allowHttp() }, depsFor(peer)),
  );
  return {
    five: { status: five.status, text: five.text, finalUrl: five.finalUrl },
    requestsForFive,
    methods,
    headers,
    maxRedirects: MAX_REDIRECTS,
    six,
  };
});

await record("redirect-relookup", async () => {
  const peer = await httpPeer((req, res) => {
    if (req.url === "/start") {
      res.writeHead(302, { location: "/finish", "content-length": "0" });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("done");
  });
  const allowedLookups = [];
  const allowed = await fetchDocument(
    url(peer, "/start"),
    { settings: allowHttp() },
    {
      ...depsFor(peer),
      lookup: cannedLookup([{ address: LOOPBACK, family: 4 }], (host) => allowedLookups.push(host)),
    },
  );
  const allowedConnections = peer.connections();
  const allowedRequests = peer.requests.length;
  let deniedLookups = 0;
  const denied = await refusalOf(
    fetchDocument(
      url(peer, "/start"),
      { settings: allowHttp() },
      {
        ...depsFor(peer),
        lookup: (_host, _options, callback) => {
          deniedLookups += 1;
          callback(null, [{ address: deniedLookups === 1 ? LOOPBACK : "127.0.0.2", family: 4 }]);
        },
      },
    ),
  );
  return {
    allowedText: allowed.text,
    allowedLookups,
    allowedConnections,
    allowedRequests,
    denied,
    deniedLookups,
    deniedConnections: peer.connections() - allowedConnections,
    deniedRequests: peer.requests.length - allowedRequests,
  };
});

await record("redirect-private", async () => {
  const internal = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("secret");
  }, "127.0.0.2");
  const front = await httpPeer((_req, res) => {
    res.writeHead(302, { location: `http://internal.test:${internal.port}/secret` });
    res.end();
  });
  const lookup = (hostname, _options, callback) => {
    callback(null, [{ address: hostname === "internal.test" ? "127.0.0.2" : LOOPBACK, family: 4 }]);
  };
  const refusal = await refusalOf(
    fetchDocument(
      url(front, "/start"),
      { settings: allowHttp() },
      {
        ...depsFor(front, { ports: [front.port, internal.port] }),
        lookup,
      },
    ),
  );
  return {
    refusal,
    internalConnections: internal.connections(),
    frontRequests: front.requests.length,
  };
});

await record("redirect-scheme", async () => {
  const results = [];
  for (const location of ["file:///etc/passwd", "javascript:alert(1)", "ftp://peer.test/x"]) {
    const peer = await httpPeer((_req, res) => {
      res.writeHead(302, { location });
      res.end();
    });
    results.push({
      location,
      refusal: await refusalOf(
        fetchDocument(url(peer, "/start"), { settings: allowHttp() }, depsFor(peer)),
      ),
      connections: peer.connections(),
    });
  }
  return { results };
});

await record("downgrade", async () => {
  const plain = await httpPeer((req, res) => {
    if (req.url === "/up") {
      res.writeHead(302, { location: `https://peer.test:${secure.port}/end` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("cleartext");
  });
  const secure = await httpsPeer((req, res) => {
    if (req.url === "/down") {
      res.writeHead(302, { location: `http://peer.test:${plain.port}/cleartext` });
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("secure");
  });
  const downgrade = await refusalOf(
    fetchDocument(
      url(secure, "/down", "https"),
      { settings: allowHttp() },
      depsFor(secure, { ports: [secure.port, plain.port], tlsCa: certificate }),
    ),
  );
  const plainConnectionsAfterDowngrade = plain.connections();
  const upgrade = await fetchDocument(
    url(plain, "/up"),
    { settings: allowHttp() },
    {
      ...depsFor(plain, { ports: [plain.port, secure.port] }),
      tlsCa: certificate,
    },
  );
  return {
    downgrade,
    plainConnectionsAfterDowngrade,
    upgrade: { status: upgrade.status, text: upgrade.text, finalUrl: upgrade.finalUrl },
  };
});

await record("redirect-no-location", async () => {
  const peer = await httpPeer((_req, res) => {
    res.writeHead(302, { "content-type": "text/plain" });
    res.end("no target");
  });
  const result = await fetchDocument(url(peer, "/start"), { settings: allowHttp() }, depsFor(peer));
  return { status: result.status, text: result.text, requestCount: peer.requests.length };
});

await record("redirect-stream", async () => {
  const peer = await httpPeer((req, res) => {
    if (req.url === "/stream") {
      res.writeHead(302, { location: "/target" });
      res.write("an unfinished redirect body");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("target");
  });
  const result = await fetchDocument(
    url(peer, "/stream"),
    { settings: allowHttp() },
    depsFor(peer, { deadlineMs: 500 }),
  );
  const abortDeadline = Date.now() + 1000;
  while (peer.abortedResponses() === 0 && Date.now() < abortDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return {
    text: result.text,
    requestCount: peer.requests.length,
    abortedResponses: peer.abortedResponses(),
  };
});

await record("encoded-cap", async () => {
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const peer = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    let sent = 0;
    // Write well past the cap: the client stops reading part-way, so this
    // writer cannot finish.
    const pump = () => {
      while (sent <= MAX_BODY_BYTES * 4) {
        sent += chunk.length;
        if (!res.write(chunk)) {
          res.once("drain", pump);
          return;
        }
      }
      res.end();
    };
    pump();
  });
  const refusal = await refusalOf(
    fetchDocument(url(peer), { settings: allowHttp() }, depsFor(peer)),
  );
  // The socket teardown reaches the peer a turn later; wait for it, bounded.
  const deadline = Date.now() + 2000;
  while (peer.abortedResponses() === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { refusal, cap: MAX_BODY_BYTES, abortedResponses: peer.abortedResponses() };
});

await record("decoded-cap", async () => {
  const body = gzipSync(Buffer.alloc(MAX_BODY_BYTES + 1024 * 1024, 0x61));
  const peer = await httpPeer((_req, res) => {
    res.writeHead(200, {
      "content-type": "text/plain",
      "content-encoding": "gzip",
      "content-length": String(body.length),
    });
    res.end(body);
  });
  const refusal = await refusalOf(
    fetchDocument(url(peer), { settings: allowHttp() }, depsFor(peer)),
  );
  return {
    refusal,
    cap: MAX_BODY_BYTES,
    encodedLength: body.length,
    abortedResponses: peer.abortedResponses(),
  };
});

await record("content-encoding", async () => {
  const unsupported = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "content-encoding": "zstd" });
    res.end("compressed somehow");
  });
  const unsupportedRefusal = await refusalOf(
    fetchDocument(url(unsupported), { settings: allowHttp() }, depsFor(unsupported)),
  );
  const corrupt = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
    res.end("this is not gzip");
  });
  const corruptRefusal = await refusalOf(
    fetchDocument(url(corrupt), { settings: allowHttp() }, depsFor(corrupt)),
  );
  return { unsupportedRefusal, corruptRefusal };
});

await record("content-type", async () => {
  const pdf = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "application/pdf" });
    res.end("%PDF-1.4");
  });
  const pdfRefusal = await refusalOf(
    fetchDocument(url(pdf), { settings: allowHttp() }, depsFor(pdf)),
  );
  const none = await httpPeer((_req, res) => {
    res.writeHead(200, {});
    res.end("no type at all");
  });
  const noneRefusal = await refusalOf(
    fetchDocument(url(none), { settings: allowHttp() }, depsFor(none)),
  );
  return { pdfRefusal, noneRefusal };
});

await record("content-type-stream", async () => {
  const peer = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "application/pdf" });
    res.write("an unfinished rejected body");
  });
  const refusal = await refusalOf(
    fetchDocument(url(peer), { settings: allowHttp() }, depsFor(peer, { deadlineMs: 500 })),
  );
  const abortDeadline = Date.now() + 1000;
  while (peer.abortedResponses() === 0 && Date.now() < abortDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return { refusal, abortedResponses: peer.abortedResponses() };
});

await record("allowed-types", async () => {
  const bodies = [
    ["text/plain", "plain text"],
    ["text/markdown", "# heading\n\nbody"],
    ["application/json", '{"a":1}'],
    ["application/xml", "<a>1</a>"],
    ["text/xml", "<b>2</b>"],
    ["application/rss+xml", "<rss/>"],
    ["application/atom+xml", "<feed/>"],
    ["text/html; charset=utf-8", "<p>html body</p>"],
  ];
  const observed = [];
  for (const [type, body] of bodies) {
    const peer = await httpPeer((_req, res) => {
      res.writeHead(200, { "content-type": type });
      res.end(body);
    });
    const result = await fetchDocument(url(peer), { settings: allowHttp() }, depsFor(peer));
    observed.push({ type, contentType: result.contentType, text: result.text });
  }
  return { observed };
});

await record("text-limit", async () => {
  const peer = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("x".repeat(5000));
  });
  const settings = resolveWebSettings({ allow_http: true, fetch_max_chars: 1000 });
  const ceiling = await fetchDocument(url(peer), { settings }, depsFor(peer));
  const lower = await fetchDocument(url(peer), { settings, maxChars: 20 }, depsFor(peer));
  const raised = await fetchDocument(url(peer), { settings, maxChars: 5000 }, depsFor(peer));
  return {
    ceiling: { length: ceiling.text.length, truncated: ceiling.truncated },
    lower: { text: lower.text, truncated: lower.truncated },
    raised: { length: raised.text.length, truncated: raised.truncated },
    resolved: {
      undefined: resolveMaxChars(undefined, 20_000),
      zero: resolveMaxChars(0, 20_000),
      negative: resolveMaxChars(-5, 20_000),
      fractional: resolveMaxChars(1.9, 20_000),
      lowerThanCeiling: resolveMaxChars(500, 100),
      aboveAbsoluteCeiling: resolveMaxChars(999_999, 200_000),
      nan: resolveMaxChars(Number.NaN, 20_000),
      infinity: resolveMaxChars(Number.POSITIVE_INFINITY, 20_000),
    },
  };
});

await record("deadline", async () => {
  const peer = await httpPeer(() => {
    // Never respond.
  });
  const refusal = await refusalOf(
    fetchDocument(url(peer), { settings: allowHttp() }, depsFor(peer, { deadlineMs: 300 })),
  );
  return { refusal, totalDeadlineMs: TOTAL_DEADLINE_MS };
});

await record("proxy-env", async () => {
  const proxy = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("i am not a proxy");
  });
  const peer = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("direct");
  });
  const saved = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
    NO_PROXY: process.env.NO_PROXY,
  };
  process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
  process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`;
  process.env.ALL_PROXY = `http://127.0.0.1:${proxy.port}`;
  delete process.env.NO_PROXY;
  try {
    const result = await fetchDocument(url(peer), { settings: allowHttp() }, depsFor(peer));
    return { text: result.text, proxyConnections: proxy.connections() };
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

await record("global-dispatcher", async () => {
  const peer = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("owned dispatcher");
  });
  const previous = getGlobalDispatcher();
  let used = false;
  setGlobalDispatcher({
    dispatch() {
      used = true;
      throw new Error("the global dispatcher was used");
    },
  });
  try {
    const result = await fetchDocument(url(peer), { settings: allowHttp() }, depsFor(peer));
    return { text: result.text, globalDispatcherUsed: used };
  } finally {
    setGlobalDispatcher(previous);
  }
});

await record("network-failure", async () => {
  const peer = await httpPeer(() => {});
  const failure = new Error("dns says no");
  failure.code = "ENOTFOUND";
  const lookupRefusal = await refusalOf(
    fetchDocument(
      url(peer),
      { settings: allowHttp() },
      {
        ...depsFor(peer),
        lookup: (_hostname, _options, callback) => callback(failure),
      },
    ),
  );
  const closed = await httpPeer(() => {});
  const closedPort = closed.port;
  await closed.close();
  const closedRefusal = await refusalOf(
    fetchDocument(
      `http://peer.test:${closedPort}/`,
      { settings: allowHttp() },
      {
        addressPolicy: testPolicy([LOOPBACK]),
        ports: [closedPort],
        lookup: cannedLookup([{ address: LOOPBACK, family: 4 }]),
      },
    ),
  );
  return { lookupRefusal, closedRefusal };
});

await record("body-reset", async () => {
  const peer = await httpPeer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain", "content-length": "100" });
    res.write("partial body", () => res.socket?.destroy());
  });
  const refusal = await refusalOf(
    fetchDocument(url(peer), { settings: allowHttp() }, depsFor(peer)),
  );
  return { refusal, requestCount: peer.requests.length, connections: peer.connections() };
});

// ── report ─────────────────────────────────────────────────────────────────

process.stdout.write(`${JSON.stringify({ caseNames: Object.keys(cases), cases })}\n`);
