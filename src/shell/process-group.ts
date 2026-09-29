// Process-group operations — the one place bob signals or probes a child's
// process group. Two owners use it: the tps-mail consumer's turn reaper
// (mail-consumer.ts) and the `work` capability's `run` tool
// (src/capabilities/work/). Both start their child DETACHED (its own session and
// process group, pgid = the child's pid) and act on that recorded group id only,
// never on a name or a command line.
//
// Why bob has its own copy rather than importing pi's: pi 0.84.3 has a
// process-tree kill (`killProcessTree` in utils/shell.js), but it is not exported
// from the package root and pi's `exports` map forbids a deep import. It is also
// SIGKILL-only, while both owners here need SIGTERM first and SIGKILL after a
// grace. These few lines were already bob's (mail-consumer.ts); they moved here
// so the second owner shares them instead of copying them.

// Process-group operations (a seam: tests fake a group that never dies).
export interface GroupOps {
  // Does the group still have a member? (EPERM counts: a member we may not signal.)
  exists(pgid: number): boolean;
  signal(pgid: number, sig: NodeJS.Signals): void;
}

// A group id bob may act on. `process.kill(-0, …)` signals the CALLER's own group
// and `process.kill(-1, …)` signals every process the user may signal, so 0, 1
// and anything that is not a positive integer are refused before any syscall.
// This process's own pid is refused too: a group led by bob itself is never one
// of its children's groups.
export function isOwnedGroupId(pgid: unknown): pgid is number {
  return typeof pgid === "number" && Number.isSafeInteger(pgid) && pgid > 1 && pgid !== process.pid;
}

// What a probe of a group found.
//   members        — at least one process is in the group (and we may signal it)
//   empty          — no process is in the group (ESRCH)
//   unsignallable  — a member exists that we may not signal (EPERM)
//   unknown        — the probe could not answer (an invalid id or another error)
export type GroupProbe = "members" | "empty" | "unsignallable" | "unknown";

export function probeGroup(pgid: number): GroupProbe {
  if (!isOwnedGroupId(pgid)) return "unknown";
  try {
    process.kill(-pgid, 0);
    return "members";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "empty";
    if (code === "EPERM") return "unsignallable";
    return "unknown";
  }
}

export const NODE_GROUP_OPS: GroupOps = {
  exists(pgid) {
    const probe = probeGroup(pgid);
    return probe === "members" || probe === "unsignallable";
  },
  signal(pgid, sig) {
    if (!isOwnedGroupId(pgid)) return;
    try {
      process.kill(-pgid, sig); // the whole group: descendants included
    } catch {
      // gone between the probe and the signal
    }
  },
};
