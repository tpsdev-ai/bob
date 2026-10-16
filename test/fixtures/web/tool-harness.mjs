// Node-side harness for the `web_fetch` tool over a REAL loopback HTTP server
// (bob#152, spec v3, slice R1c).
//
// WHY NODE. The tool calls the R1b fetch core, which builds an owned undici
// Agent and vets addresses in its connector's `lookup`; Bun resolves `undici`
// to its own implementation, whose Agent takes no dispatcher options, so the
// real transport only exists under Node — the runtime bob ships on. This
// harness wires the tool through wireWebCapability with a fake pi and an
// injected fetch that is the real fetchDocument pointed at a loopback peer, so
// a real GET crosses the socket. Every assertion lives in the bun test that
// drives this file. It prints ONE JSON line of what it observed.

import { createServer } from "node:http";
import {
  fetchDocument,
  publicUnicastPolicy,
  resolveWebSettings,
  wireWebCapability,
} from "../../../dist/capabilities/web/index.js";

const LOOPBACK = "127.0.0.1";

const requests = [];
let connections = 0;
const server = createServer((req, res) => {
  requests.push({ method: req.method ?? "", url: req.url ?? "", headers: { ...req.headers } });
  if (req.url === "/start") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end('<html><body><h1>Title</h1><p>see <a href="/next">next</a></p></body></html>');
    return;
  }
  if (req.url === "/next") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("linked page");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("not found");
});
server.on("connection", () => {
  connections += 1;
});

await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));
const port = server.address().port;

// The seams a loopback case needs: add 127.0.0.1 to public-unicast
// classification, use the peer's ephemeral port, and answer DNS with the
// loopback address so the connector's lookup vets and returns it.
const base = publicUnicastPolicy({ own: [] });
const addressPolicy = {
  version: base.version,
  classify: (address) => (address === LOOPBACK ? { allowed: true } : base.classify(address)),
};
const lookup = (_hostname, _options, callback) =>
  callback(null, [{ address: LOOPBACK, family: 4 }]);
const coreDeps = { addressPolicy, ports: [port], lookup, deadlineMs: 5000 };

// A fake pi: capture the handlers and the registered tool.
const handlers = new Map();
const tools = [];
const pi = {
  on(type, handler) {
    const list = handlers.get(type) ?? [];
    list.push(handler);
    handlers.set(type, list);
  },
  registerTool(tool) {
    tools.push(tool);
  },
};
const fire = (type, event = {}) => {
  for (const handler of handlers.get(type) ?? []) handler(event);
};

const settings = resolveWebSettings({
  allow_http: true,
  fetch_per_turn: 10,
  text_per_turn: 100_000,
});
wireWebCapability({
  pi,
  settings,
  admission: { readOrigin: () => ({ kind: "run" }) },
  fetch: (url, options) => fetchDocument(url, options, coreDeps),
});

const start = `http://peer.test:${port}/start`;
fire("before_agent_start", { prompt: `please read ${start}` });

const tool = tools[0];
const call = async (url) => {
  try {
    const out = await tool.execute("call", { url });
    return { ok: true, text: out.content[0].text, details: out.details };
  } catch (error) {
    return {
      ok: false,
      code: error?.code ?? error?.name ?? "unknown",
      detail: error?.detail ?? null,
    };
  }
};

const fetchStart = await call(start);
// Snapshot the peer state right after the first fetch, before the follow.
const startRequests = requests.map((r) => `${r.method} ${r.url}`);
const startConnections = connections;
const fetchLink = await call(`http://peer.test:${port}/next`);
const fetchUnrecorded = await call(`http://peer.test:${port}/other`);

const report = {
  cases: {
    fetch: {
      ...fetchStart,
      requests: startRequests,
      connections: startConnections,
    },
    follow: fetchLink,
    unrecorded: fetchUnrecorded,
  },
};

await new Promise((resolve) => server.close(resolve));
process.stdout.write(`${JSON.stringify(report)}\n`);
