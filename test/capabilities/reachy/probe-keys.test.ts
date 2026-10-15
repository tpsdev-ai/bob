import { expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assertConfinementProbeKeys, MACH_SERVICES } from "./probe-keys.js";

it("P1/P3 probe key checks reject missing or extra results in either run", () => {
  const source = readFileSync(
    join(import.meta.dirname, "../../../sidecar/reachy-voice/egress-probe.py"),
    "utf8",
  );
  const result = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      source,
      JSON.stringify({
        tcp4: 9,
        tcp6: 9,
        udp4: 9,
        unixOther: "/nonexistent/reachy.sock",
        mdns: "/nonexistent/mdns.sock",
        mach: MACH_SERVICES,
        childTcp4: 9,
        exec: "/usr/bin/true",
        readOutside: "/nonexistent/read",
        writeOutside: "/nonexistent/write",
      }),
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  const complete = JSON.parse(result.stdout);
  assertConfinementProbeKeys(complete, complete);
  for (const key of Object.keys(complete)) {
    const missing = { ...complete };
    delete missing[key];
    expect(() => assertConfinementProbeKeys(missing, complete)).toThrow();
    expect(() => assertConfinementProbeKeys(complete, missing)).toThrow();
  }
  const extra = { ...complete, unexpected: { ok: true, err: "" } };
  expect(() => assertConfinementProbeKeys(extra, complete)).toThrow();
  expect(() => assertConfinementProbeKeys(complete, extra)).toThrow();
});
