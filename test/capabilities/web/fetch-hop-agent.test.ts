import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HARNESS = fileURLToPath(new URL("../../fixtures/web/fetch-hop-mock.mjs", import.meta.url));
const DIST_CORE = fileURLToPath(
  new URL("../../../dist/capabilities/web/index.js", import.meta.url),
);

test("a completed same-origin redirect destroys its Agent before a fresh hop", () => {
  if (!existsSync(DIST_CORE)) {
    throw new Error(`the harness runs the built core; ${DIST_CORE} is missing — run the build`);
  }
  const observed = JSON.parse(execFileSync("node", [HARNESS], { encoding: "utf8" })) as {
    result: { text: string; finalUrl: string };
    agents: number;
    previousDestroyedBeforeConstruction: boolean;
    allDestroyed: boolean;
    allHaveVettedLookup: boolean;
    requests: Array<{ agent: number; path: string }>;
  };
  expect(observed.result.text).toBe("done");
  expect(observed.result.finalUrl).toBe("http://peer.test/finish");
  expect(observed.agents).toBe(2);
  expect(observed.previousDestroyedBeforeConstruction).toBe(true);
  expect(observed.allDestroyed).toBe(true);
  expect(observed.allHaveVettedLookup).toBe(true);
  expect(observed.requests).toEqual([
    { agent: 1, path: "/start" },
    { agent: 2, path: "/finish" },
  ]);
});
