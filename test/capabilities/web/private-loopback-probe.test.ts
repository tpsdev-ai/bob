import { expect, test } from "bun:test";
import {
  PRIVATE_LOOPBACK_SKIP_REASON,
  privateLoopbackSkipReason,
} from "./private-loopback-probe.js";

function bindError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`injected loopback probe error: ${code}`), { code });
}

test("an unavailable loopback alias produces the named skip reason", () => {
  expect(privateLoopbackSkipReason(bindError("EADDRNOTAVAIL"))).toBe(PRIVATE_LOOPBACK_SKIP_REASON);
});

test("an unexpected loopback bind error fails instead of producing a skip", () => {
  const error = bindError("EACCES");
  let caught: unknown;
  try {
    privateLoopbackSkipReason(error);
  } catch (cause) {
    caught = cause;
  }
  expect(caught).toBe(error);
  expect((caught as NodeJS.ErrnoException).code).toBe("EACCES");
});
