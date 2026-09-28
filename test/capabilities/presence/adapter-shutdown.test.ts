import { describe, expect, it } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import presenceExtension from "../../../src/capabilities/presence/index.js";

describe("presence extension shutdown", () => {
  it("stops its interval once when pi shuts the session down", async () => {
    const previousPersistent = process.env.BOB_PERSISTENT;
    const previousConfig = process.env.BOB_CAP_PRESENCE;
    const previousSet = globalThis.setInterval;
    const previousClear = globalThis.clearInterval;
    const handlers = new Map<string, () => void>();
    let active = false;
    let clearCount = 0;
    let ticks = 0;
    try {
      process.env.BOB_PERSISTENT = "1";
      process.env.BOB_CAP_PRESENCE = JSON.stringify({
        url: "http://127.0.0.1:9926",
        agentId: "pulse",
        keyFile: "/unused",
      });
      globalThis.setInterval = ((callback: () => void) => {
        active = true;
        handlers.set("beacon", callback);
        return { unref() {} } as ReturnType<typeof setInterval>;
      }) as typeof setInterval;
      globalThis.clearInterval = (() => {
        active = false;
        clearCount++;
      }) as typeof clearInterval;
      const pi = {
        on(event: string, handler: () => void) {
          handlers.set(event, handler);
        },
        events: { emit() {} },
        getAllTools: () => [],
      } as unknown as ExtensionAPI;
      await presenceExtension(pi);
      expect(active).toBe(true);
      const shutdown = handlers.get("session_shutdown");
      expect(shutdown).toBeDefined();
      shutdown?.();
      shutdown?.();
      if (active) {
        handlers.get("beacon")?.();
        ticks++;
      }
      expect(clearCount).toBe(1);
      expect(ticks).toBe(0);
    } finally {
      globalThis.setInterval = previousSet;
      globalThis.clearInterval = previousClear;
      if (previousPersistent === undefined) delete process.env.BOB_PERSISTENT;
      else process.env.BOB_PERSISTENT = previousPersistent;
      if (previousConfig === undefined) delete process.env.BOB_CAP_PRESENCE;
      else process.env.BOB_CAP_PRESENCE = previousConfig;
    }
  });
});
