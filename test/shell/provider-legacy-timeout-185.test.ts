import { afterEach, beforeEach, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installBaseUrlTransport } from "../../src/shell/base-url-transport.js";
import { initAgent } from "../../src/shell/init.js";
import { ProviderRegistry } from "../../src/shell/provider-registry.js";
import { memoryServer } from "./provider-timeout-fixture.js";

let root: string;
let keysRoot: string;
const realFetch = globalThis.fetch;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-185-legacy-"));
  keysRoot = mkdtempSync(join(tmpdir(), "bob-185-legacy-keys-"));
});
afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(root, { recursive: true, force: true });
  rmSync(keysRoot, { recursive: true, force: true });
});

it("the old SDK deadline fires before headers; the row permits headers and a stream beyond it", async () => {
  const server = memoryServer({ headersDelayMs: 200, chunks: 8, chunkDelayMs: 50 });
  globalThis.fetch = server.fetch;
  const registry = new ProviderRegistry();
  const { agentDir } = initAgent({
    name: "legacybot",
    role: "ea",
    provider: "ollama",
    model: "m",
    baseUrl: "http://fake.local/v1",
    contextWindow: 262_144,
    agentsRoot: root,
    flairKeysDir: keysRoot,
    skipFlair: true,
    registry,
  });
  const runtimeFor = () =>
    ModelRuntime.create({
      authPath: join(agentDir, ".pi-agent", "auth.json"),
      modelsPath: join(agentDir, ".pi-agent", "models.json"),
    });
  const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };
  const legacy = await runtimeFor();
  installBaseUrlTransport(legacy, "ollama", "http://fake.local/v1");
  const oldModel = legacy.getModel("ollama", "m");
  if (oldModel === undefined) throw new Error("no legacy model");
  const oldReply = await legacy
    .streamSimple(oldModel, context, {
      timeoutMs: 50,
      maxRetries: 0,
    })
    .result();
  expect(oldReply.stopReason).toBe("error");
  expect(oldReply.errorMessage).toContain("timed out");
  const current = await runtimeFor();
  installBaseUrlTransport(
    current,
    "ollama",
    "http://fake.local/v1",
    registry.find("ollama")?.request,
  );
  const model = current.getModel("ollama", "m");
  if (model === undefined) throw new Error("no model");
  const reply = await current
    .streamSimple(model, context, {
      timeoutMs: 50,
      maxRetries: 0,
    })
    .result();
  expect(reply.stopReason).toBe("stop");
  expect(reply.content).toContainEqual({ type: "text", text: "tok0tok1tok2tok3tok4tok5tok6tok7" });
  expect(server.requests).toBe(2);
});
