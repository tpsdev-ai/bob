// Socket-free check of the compiled fetch core's dispatcher lifetime under Node.
// Patch undici before importing the core so request() sees a MockAgent for each
// Agent construction. Both mocks can serve the final URL: a shared Agent can
// still return the right text, but the test detects its missing hop boundary.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const undici = require("undici");
const originalAgent = undici.Agent;
const agents = [];
const requests = [];
let previousDestroyedBeforeConstruction = true;

function MockedAgent(options) {
  if (agents.length > 0 && !agents.at(-1).wasDestroyed) {
    previousDestroyedBeforeConstruction = false;
  }
  const mock = new undici.MockAgent();
  mock.disableNetConnect();
  mock.wasDestroyed = false;
  mock.destroy = async () => {
    mock.wasDestroyed = true;
    await mock.close();
  };
  const dispatch = mock.dispatch.bind(mock);
  const agentNumber = agents.length + 1;
  mock.dispatch = (requestOptions, handler) => {
    requests.push({ agent: agentNumber, path: requestOptions.path });
    return dispatch(requestOptions, handler);
  };
  const pool = mock.get("http://peer.test");
  pool.intercept({ method: "GET", path: "/start" }).reply(302, "", {
    headers: { location: "/finish", "content-length": "0" },
  });
  pool.intercept({ method: "GET", path: "/finish" }).reply(200, "done", {
    headers: { "content-type": "text/plain" },
  });
  agents.push({
    mock,
    options,
    get wasDestroyed() {
      return mock.wasDestroyed;
    },
  });
  return mock;
}
undici.Agent = MockedAgent;

try {
  const { fetchDocument, resolveWebSettings } = await import(
    "../../../dist/capabilities/web/index.js"
  );
  const result = await fetchDocument("http://peer.test/start", {
    settings: resolveWebSettings({ allow_http: true }),
  });
  console.log(
    JSON.stringify({
      result,
      agents: agents.length,
      previousDestroyedBeforeConstruction,
      allDestroyed: agents.every((agent) => agent.wasDestroyed),
      allHaveVettedLookup: agents.every(
        (agent) => typeof agent.options.connect.lookup === "function",
      ),
      requests,
    }),
  );
} finally {
  undici.Agent = originalAgent;
}
