import { createServer } from "node:net";

export const PRIVATE_LOOPBACK_ALIAS = "127.0.0.2";
export const PRIVATE_LOOPBACK_SKIP_REASON = `missing loopback alias ${PRIVATE_LOOPBACK_ALIAS}`;

export function privateLoopbackSkipReason(error: NodeJS.ErrnoException): string {
  if (error.code === "EADDRNOTAVAIL") return PRIVATE_LOOPBACK_SKIP_REASON;
  throw error;
}

// macOS does not provide every address in 127/8 as a bindable alias by
// default. Only that specific absence makes the private-redirect case
// inapplicable; an unexpected bind failure must fail the suite.
export function probePrivateLoopbackAlias(): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", (error) => {
      probe.removeAllListeners();
      try {
        resolve(privateLoopbackSkipReason(error));
      } catch (unexpectedError) {
        reject(unexpectedError);
      }
    });
    probe.listen(0, PRIVATE_LOOPBACK_ALIAS, () => {
      probe.removeAllListeners();
      probe.close((error) => {
        if (error !== undefined) {
          reject(error);
          return;
        }
        resolve(undefined);
      });
    });
  });
}
