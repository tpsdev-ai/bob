import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { installBaseUrlTransport } from "../../src/shell/base-url-transport.js";
import { initAgent } from "../../src/shell/init.js";
import {
  loadProviderRegistry,
  PROVIDER_RECORDS,
  ProviderRegistry,
} from "../../src/shell/provider-registry.js";
import { resolveRunConfig } from "../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../src/shell/session.js";
import { memoryServer } from "./provider-timeout-fixture.js";

describe("bob#185 item 1 — the selected provider row carries the policy", () => {
  it("every local row declares its timeout limits and zero request retries", () => {
    const registry = new ProviderRegistry();
    for (const id of ["ollama", "ollama-newton", "omlx"]) {
      const row = registry.find(id);
      expect(row?.request).toEqual({
        idleTimeoutMs: 120_000,
        totalTimeoutMs: 1_800_000,
        maxRetries: 0,
      });
      expect(row?.request?.totalTimeoutMs ?? 0).toBeGreaterThanOrEqual(900_000);
      expect(row?.request?.maxRetries).toBe(0);
    }
  });

  it("cloud rows declare no request policy", () => {
    const registry = new ProviderRegistry();
    for (const id of ["ollama-cloud", "anthropic", "openai", "openrouter"]) {
      expect(registry.find(id)?.request).toBeUndefined();
    }
    expect(PROVIDER_RECORDS.find((row) => row.id === "ollama-cloud")?.request).toBeUndefined();
  });

  it("the row's policy is frozen with the record", () => {
    const policy = new ProviderRegistry().find("ollama")?.request;
    expect(policy).toBeDefined();
    expect(Object.isFrozen(policy)).toBe(true);
  });

  it.each([
    {
      name: "a non-mapping request",
      request: "request: invalid",
      message: /row "acme" request must be a mapping/,
    },
    {
      name: "a nonzero total cap below the minimum",
      request: "request: {idleTimeoutMs: 2000, totalTimeoutMs: 60000, maxRetries: 0}",
      message: /totalTimeoutMs must be 0 or an integer within/,
    },
    {
      name: "an idle timeout below the minimum",
      request: "request: {idleTimeoutMs: 100, totalTimeoutMs: 1800000, maxRetries: 0}",
      message: /idleTimeoutMs must be an integer within/,
    },
    {
      name: "a retry count above the maximum",
      request: "request: {idleTimeoutMs: 2000, totalTimeoutMs: 1800000, maxRetries: 9}",
      message: /maxRetries must be an integer within/,
    },
    {
      name: "a non-integer field",
      request: "request: {idleTimeoutMs: 2000.5, totalTimeoutMs: 1800000, maxRetries: 0}",
      message: /idleTimeoutMs must be an integer within/,
    },
    {
      name: "a missing field",
      request: "request: {idleTimeoutMs: 2000, maxRetries: 0}",
      message: /must declare idleTimeoutMs, totalTimeoutMs and maxRetries/,
    },
    {
      name: "an unknown field",
      request: "request: {idleTimeoutMs: 2000, totalTimeoutMs: 1800000, maxRetries: 0, extra: 1}",
      message: /request has an unknown field/,
    },
  ])("an operator row with $name refuses at load by name", ({ request, message }) => {
    const dir = mkdtempSync(join(tmpdir(), "bob-185t-"));
    try {
      const path = join(dir, "providers.yaml");
      writeFileSync(
        path,
        `version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    auth: bob/none\n    ${request}\n`,
      );
      expect(() => loadProviderRegistry({ path })).toThrow(message);
      expect(() => loadProviderRegistry({ path })).toThrow(/row "acme"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a policy on a non-keyless row refuses, because bob does not enforce it there", () => {
    const shipped = new ProviderRegistry().find("openrouter");
    if (shipped === undefined) throw new Error("no openrouter row");
    expect(
      () =>
        new ProviderRegistry([
          {
            ...shipped,
            request: { idleTimeoutMs: 1_000, totalTimeoutMs: 1_800_000, maxRetries: 0 },
          } as never,
        ]),
    ).toThrow(/request policy but bob only enforces it on a bob\/none row/);
  });

  it("an operator row may declare a policy within bounds", () => {
    const dir = mkdtempSync(join(tmpdir(), "bob-185t-"));
    try {
      const path = join(dir, "providers.yaml");
      writeFileSync(
        path,
        "version: 1\nproviders:\n  - id: acme\n    aliases: []\n    runtime: acme\n    auth: bob/none\n    request: {idleTimeoutMs: 1000, totalTimeoutMs: 900000, maxRetries: 0}\n",
      );
      const registry = loadProviderRegistry({ path });
      expect(registry.find("acme")?.request).toEqual({
        idleTimeoutMs: 1_000,
        totalTimeoutMs: 900_000,
        maxRetries: 0,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("bob#185 item 1 — selected-row transport and real sessions", () => {
  let root: string;
  let keysRoot: string;
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "bob-185t-e2e-"));
    keysRoot = mkdtempSync(join(tmpdir(), "bob-185t-keys-"));
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    rmSync(root, { recursive: true, force: true });
    rmSync(keysRoot, { recursive: true, force: true });
  });

  function scaffold(maxRetries: number | undefined) {
    const row = {
      id: "fake-local",
      aliases: [],
      runtime: "fake-local",
      auth: { kind: "none" as const },
      endpoint: "http://fake.local/v1",
      api: "openai-completions" as const,
      override: {},
      ...(maxRetries !== undefined
        ? {
            request: { idleTimeoutMs: 1_000, totalTimeoutMs: 1_800_000, maxRetries },
          }
        : {}),
    };
    const registry = new ProviderRegistry([...PROVIDER_RECORDS, row]);
    const result = initAgent({
      name: "fakebot",
      role: "ea",
      provider: "fake-local",
      model: "m",
      contextWindow: 262_144,
      agentsRoot: root,
      flairKeysDir: keysRoot,
      skipFlair: true,
      registry,
    });
    const selected = registry.find(row.id);
    if (selected === undefined) throw new Error("no selected row");
    return { registry, row: selected, agentDir: result.agentDir };
  }

  async function sessionFor(maxRetries: number | undefined) {
    const { registry, agentDir } = scaffold(maxRetries);
    writeFileSync(
      join(agentDir, ".pi-agent", "auth.json"),
      JSON.stringify({
        "fake-local": { type: "api_key", key: "fixture-placeholder" },
      }),
    );
    const { config, policy } = resolveRunConfig({ name: "fakebot", agentsRoot: root, registry });
    return createBobRuntimeFactory({ config, policy, registry })({
      sessionManager: SessionManager.inMemory(config.cwd),
    });
  }

  async function transportFor(maxRetries: number | undefined) {
    const { row, agentDir } = scaffold(maxRetries);
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, ".pi-agent", "auth.json"),
      modelsPath: join(agentDir, ".pi-agent", "models.json"),
    });
    if (row.endpoint === undefined) throw new Error("no endpoint");
    installBaseUrlTransport(runtime, row.runtime, row.endpoint, row.request);
    const model = runtime.getModel(row.runtime, "m");
    if (model === undefined) throw new Error("no model");
    return { runtime, model };
  }

  const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 0 }] };

  it("a real session without a row policy retains pi's retry settings", async () => {
    const { session } = await sessionFor(undefined);
    try {
      expect(session.settingsManager.getRetrySettings().enabled).toBe(true);
      expect(session.settingsManager.getProviderRetrySettings().maxRetries).toBeUndefined();
    } finally {
      session.dispose();
    }
  });

  it("a real session honours the row retry cap on provider errors", async () => {
    const server = memoryServer({ status: 503 });
    globalThis.fetch = server.fetch;
    const { session } = await sessionFor(1);
    try {
      await session.prompt("hi");
      expect(server.requests).toBe(2);
    } finally {
      session.dispose();
    }
  });

  it.each([false, true])(
    "preserves no-policy timeoutMs through streamSimple=%s",
    async (simple) => {
      const server = memoryServer({ headersDelayMs: 200 });
      globalThis.fetch = server.fetch;
      const { runtime, model } = await transportFor(undefined);
      const stream = simple ? runtime.streamSimple.bind(runtime) : runtime.stream.bind(runtime);
      const reply = await stream(model, context, { timeoutMs: 50, maxRetries: 0 }).result();
      expect(reply.stopReason).toBe("error");
      expect(reply.errorMessage).toContain("timed out");
      expect(server.requests).toBe(1);
    },
  );

  it.each([0, 1, 2])("preserves no-policy maxRetries=%s", async (maxRetries) => {
    const server = memoryServer({ status: 503 });
    globalThis.fetch = server.fetch;
    const { runtime, model } = await transportFor(undefined);
    const reply = await runtime.streamSimple(model, context, { maxRetries }).result();
    expect(reply.stopReason).toBe("error");
    expect(server.requests).toBe(1 + maxRetries);
  });

  it.each([0, 1, 2])("honours row maxRetries=%s without extra SDK attempts", async (maxRetries) => {
    const server = memoryServer({ status: 503 });
    globalThis.fetch = server.fetch;
    const { runtime, model } = await transportFor(maxRetries);
    const reply = await runtime.streamSimple(model, context, { maxRetries: 5 }).result();
    expect(reply.stopReason).toBe("error");
    expect(server.requests).toBe(1 + maxRetries);
  });

  it.each([0, 1])(
    "real session leaves a before-headers timeout terminal with row retries=%s",
    async (maxRetries) => {
      const server = memoryServer({ headersDelayMs: 2_000 });
      globalThis.fetch = server.fetch;
      const { session } = await sessionFor(maxRetries);
      try {
        expect(session.settingsManager.getRetrySettings().enabled).toBe(false);
        const events: string[] = [];
        session.subscribe((event) => {
          events.push(event.type);
        });
        await session.prompt("hi");
        const reply = session.messages.at(-1);
        expect(reply?.role).toBe("assistant");
        if (reply?.role !== "assistant") throw new Error("no assistant message");
        expect(reply.stopReason).toBe("error");
        expect(reply.errorMessage).toContain("ProviderStreamIdleTimeoutError");
        expect(reply.errorMessage).toContain('provider "fake-local"');
        expect(reply.errorMessage).toContain("1 s");
        expect(reply.errorMessage).toContain("Remedy:");
        expect(events).not.toContain("auto_retry_start");
        expect(server.requests).toBe(1);
      } finally {
        session.dispose();
      }
    },
    10_000,
  );

  it("real session applies the selected row's idle limit after headers", async () => {
    const server = memoryServer({ stall: true });
    globalThis.fetch = server.fetch;
    const { session } = await sessionFor(0);
    const deadline = setTimeout(() => {
      void session.abort();
    }, 2_500);
    try {
      await session.prompt("hi");
      const reply = session.messages.at(-1);
      if (reply?.role !== "assistant") throw new Error("no assistant message");
      expect(reply.stopReason).toBe("error");
      expect(reply.errorMessage).toContain("ProviderStreamIdleTimeoutError");
      expect(reply.errorMessage).toContain("Remedy:");
      expect(server.requests).toBe(1);
    } finally {
      clearTimeout(deadline);
      session.dispose();
    }
  }, 10_000);
});
