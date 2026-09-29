// The tps-mail inbox consumer (bob#200) — run by the persistent runtime.
//
// For each accepted mail it runs ONE turn in a FRESH session through the
// agent's launcher (bin/<name> → `bob launch`, BOB_MAIL_TURN=1, the verified
// fields on stdin), so a reply can only draw on what that turn read: no
// cross-sender carry-over and no trigger-to-turn correlation in a shared
// session (§1, F5, Kern 1). The launcher is where the tool policy binds, so a
// mail turn starts from the agent's role policy and bob.yaml — narrowed to the
// reviewed mail allowlist (the Flair memory tools) — and never from anything
// the mail says.
//
// Inbox layout (TPS maildir, plus three directories this consumer owns):
//   <inbox>/new/<file>.json      unread — the durable queue
//   <inbox>/cur/<file>.json      answered (a settled turn, replied or silent)
//   <inbox>/refused/<file>.json  refused before any session, + <file>.reason
//   <inbox>/replied/<messageId>  the turn for this signed id has settled
//
// One message at a time, oldest first by an explicit filename sort (Kern 6):
//   1. accept (envelope.ts): verify the inner signature against the sender's
//      registered key, bind it to the record's from + X-TPS-Sender, allow-list
//      the VERIFIED id. Refused → refused/ with a counted reason, never a turn,
//      never a reply (§2, F1/F2/F9, Kern 7). Flair unreachable → stays in new/.
//   2. an existing replied/<messageId> marker → ack, no turn, no reply (§5).
//   3. the turn, bounded by a wall-clock timeout that kills the launcher's whole
//      process group (Kern 4). Failed / timed out → counted, stays in new/,
//      retried with backoff. Silent (tool-only / empty) → marker, ack, NO reply.
//   4. final text → capped → `tps mail send` (reply.ts). Exit 0 → marker, then
//      ack. A failed send is counted and logged and the mail stays in new/ for
//      a retry with backoff (the composed reply is kept for it).
//
// The marker is DURABLE and comes BEFORE the ack (Gauge round 4, blocker 2):
// written to a temp file, fsynced, renamed into place, directory fsynced. If it
// cannot be written the mail is NOT acked and NOT counted: it stays in new/
// with backoff, and a retry in this run writes the marker again WITHOUT a new
// turn or a new send.
//
// At-least-once, stated (Kern 5): the ack follows the marker, which follows the
// CLI's exit 0. A crash mid-turn re-delivers and the reply is sent once; a
// crash after the marker acks without replying again. A second reply can be
// sent only when the process dies between the CLI's success and a durable
// marker — a crash, or a restart while a marker write keeps failing — and it is
// threaded to the same signed messageId: the accepted duplicate.

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  expandHome,
  TPS_AGENT_ID,
  type TpsMailCapabilityConfig,
  validateTpsMailConfig,
} from "../capabilities/tps-mail/config.js";
import {
  decideInbound,
  type KeyResolver,
  REFUSAL_REASONS,
  type RefusalReason,
} from "../capabilities/tps-mail/envelope.js";
import { createFlairKeyResolver } from "../capabilities/tps-mail/keys.js";
import {
  MAIL_TURN_ENV,
  type MailTurnInput,
  parseMailTurnResult,
  serializeMailTurnInput,
} from "../capabilities/tps-mail/prompt.js";
import {
  capReply,
  type ReplyFailure,
  type ReplySender,
  tpsCliReplySender,
} from "../capabilities/tps-mail/reply.js";
import { readBlock } from "./bob-yaml.js";
import { ORIGIN_FIELD_LIMITS } from "./origin-limits.js";

// A maildir record as TPS writes it. Every field is an unsigned claim; the
// consumer trusts only the verified inner envelope (envelope.ts).
export interface MailMessage {
  id?: string;
  from: string;
  to?: string;
  body: string;
  timestamp?: string;
  read?: boolean;
  headers?: Record<string, string>;
}

// ─── The turn ───────────────────────────────────────────────────────────────

export type TurnFailure = "timeout" | "stopped" | "launcher-missing" | "exit" | "no-result";

export type TurnOutcome =
  | { kind: "final"; text: string }
  | { kind: "silent" }
  | { kind: "failed"; reason: TurnFailure; detail: string };

// Runs one mail turn. MUST stop its work when `signal` aborts (the consumer
// also stops waiting for it then, so a runner that ignores the signal cannot
// stall the queue — but it would leak the work).
export type TurnRunner = (input: MailTurnInput, signal: AbortSignal) => Promise<TurnOutcome>;

const TURN_STDOUT_MAX_BYTES = 1024 * 1024;
const TURN_KILL_GRACE_MS = 5000;

// The default runner: spawn the agent's launcher with NO argument, BOB_MAIL_TURN=1
// and the input on stdin, as the leader of its OWN process group (detached).
// On abort (the timeout, or a shutdown) the WHOLE group — the launcher, which
// `exec`s bob, and anything bob started — gets SIGTERM, then SIGKILL after a
// grace, so no descendant outlives a killed turn. (Being its own group, the
// turn is not taken down with the runtime's process group on a crash; the
// mail-turn child watches its parent and exits when it goes — run.ts.)
export function launcherTurnRunner(opts: {
  launcherPath: string;
  // Absolute bob for the launcher's `exec "${BOB_BIN:-bob}"` when the
  // environment does not name one (a service unit's PATH may not reach bob).
  bobBin?: string;
  env?: NodeJS.ProcessEnv;
  killGraceMs?: number;
}): TurnRunner {
  return (input, signal) =>
    new Promise<TurnOutcome>((resolve) => {
      const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env), [MAIL_TURN_ENV]: "1" };
      if (!env.BOB_BIN && opts.bobBin) env.BOB_BIN = opts.bobBin;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: TurnOutcome) => {
        if (settled) return;
        settled = true;
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const child = spawn(opts.launcherPath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        env,
        shell: false,
        detached: true,
      });
      const signalGroup = (sig: NodeJS.Signals) => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, sig); // the whole group: descendants included
        } catch {
          try {
            child.kill(sig);
          } catch {
            // already gone
          }
        }
      };
      const onAbort = () => {
        signalGroup("SIGTERM");
        killTimer = setTimeout(
          () => signalGroup("SIGKILL"),
          opts.killGraceMs ?? TURN_KILL_GRACE_MS,
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();

      let stdout = "";
      let stdoutBytes = 0;
      let stderr = "";
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes <= TURN_STDOUT_MAX_BYTES) stdout += chunk.toString("utf8");
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-4096);
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        finish({
          kind: "failed",
          reason: err.code === "ENOENT" ? "launcher-missing" : "exit",
          detail: `${opts.launcherPath}: ${err.message}`,
        });
      });
      child.on("close", (code, sig) => {
        if (signal.aborted) {
          const reason = signal.reason === "timeout" ? "timeout" : "stopped";
          finish({ kind: "failed", reason, detail: `launcher killed (${reason})` });
          return;
        }
        if (code !== 0) {
          const tail = stderr.replace(/\s+/g, " ").trim().slice(-300);
          finish({
            kind: "failed",
            reason: "exit",
            detail: `launcher exited ${code ?? sig}${tail ? `: ${tail}` : ""}`,
          });
          return;
        }
        const result = parseMailTurnResult(stdout);
        if (!result) {
          finish({ kind: "failed", reason: "no-result", detail: "launcher wrote no result line" });
          return;
        }
        finish(
          result.outcome === "final" ? { kind: "final", text: result.text } : { kind: "silent" },
        );
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(serializeMailTurnInput(input), "utf8");
    });
}

// The running bob, when it was started through its `bob` entry point.
function selfBobBin(): string | undefined {
  const argv1 = process.argv[1];
  if (argv1 && isAbsolute(argv1) && basename(argv1) === "bob" && existsSync(argv1)) return argv1;
  return undefined;
}

// ─── The consumer ───────────────────────────────────────────────────────────

export interface MailConsumerOptions {
  // Agent name (its directory under ~/agents).
  name: string;
  // The agent's own TPS id: the mailbox owner the envelope must be addressed
  // to, and TPS_AGENT_ID for the reply. Never taken from a mail.
  identity: string;
  // Inbox root (holds new/ and cur/).
  inboxRoot: string;
  // The allow-list: exact verified sender ids. Required, non-empty.
  senders: readonly string[];
  // The sender's registered key (keys.ts). Required: no mail is accepted unverified.
  resolveKey: KeyResolver;
  // Defaults to ~/agents/<name>/bin/<name>.
  launcherPath?: string;
  // Defaults to ~/.bob/<name>.lock.
  lockFile?: string;
  // Where stats are written for `bob doctor`. Defaults to
  // ~/.bob/<name>.tps-mail-stats.json.
  statsFile?: string;
  pollIntervalMs?: number;
  turnTimeoutMs?: number;
  maxReplyChars?: number;
  // Seams. Default: the launcher runner and the TPS CLI.
  runTurn?: TurnRunner;
  sendReply?: ReplySender;
  // Retry backoff for a mail left in new/: base * 2^(attempts-1), capped.
  retryBaseMs?: number;
  retryMaxMs?: number;
  now?: () => number;
  log?: (msg: string) => void;
  // Seam (tests): how a replied/ marker is written. Defaults to durableWrite.
  writeMarkerFile?: (path: string, content: string) => void;
  // Seams (tests): a hook right after a lock's holder is judged dead, and how
  // long to wait for another process's takeover to finish.
  lockHooks?: { afterStaleCheck?: () => void };
  lockWaitMs?: number;
}

export interface MailConsumerStats {
  startedAt: number;
  // Mail acked after a settled turn (replied + noReply).
  processed: number;
  replied: number;
  // Settled with no final message (tool-only / empty): no reply sent.
  noReply: number;
  // Acked on an existing replied/ marker, with no turn and no reply.
  duplicates: number;
  refused: Record<RefusalReason, number>;
  // Turns that failed (timeouts included) — the mail stays in new/.
  dispatchFailed: number;
  timeouts: number;
  // Replies the CLI did not take — the mail stays in new/.
  replyFailed: Record<ReplyFailure, number>;
  // Key lookups Flair could not answer — the mail stays in new/.
  verifyUnavailable: number;
  // replied/ markers that could not be written durably — the mail stays in
  // new/, un-acked and uncounted, and the marker write is retried.
  markerFailed: number;
}

const AGENT_NAME = /^[a-z0-9-]+$/;
const DEFAULT_TURN_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_MAX_REPLY_CHARS = 4000;

function emptyStats(): MailConsumerStats {
  return {
    startedAt: 0,
    processed: 0,
    replied: 0,
    noReply: 0,
    duplicates: 0,
    refused: Object.fromEntries(REFUSAL_REASONS.map((r) => [r, 0])) as Record<
      RefusalReason,
      number
    >,
    dispatchFailed: 0,
    timeouts: 0,
    replyFailed: { "cli-missing": 0, "no-signing-key": 0, exit: 0, timeout: 0 },
    verifyUnavailable: 0,
    markerFailed: 0,
  };
}

// Liveness only (Kern 2): a pid we may not signal (EPERM) is alive.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, path);
}

// Write `content` to `path` DURABLY and atomically: an exclusive temp file,
// fsynced, renamed over `path`, then the directory fsynced so the rename itself
// survives a crash. Throws on any failure, leaving no temp file behind; a
// reader sees either the old state or the whole new file, never a torn one.
export function durableWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  let fd: number | undefined;
  try {
    fd = openSync(tmp, "wx", 0o600);
    const bytes = Buffer.from(content, "utf8");
    let off = 0;
    while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(tmp, path);
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // the write error is the one that matters
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      // never created, or already renamed
    }
    throw err;
  }
  let dirFd: number | undefined;
  try {
    dirFd = openSync(dirname(path), "r");
    fsyncSync(dirFd);
  } catch (err) {
    // Some filesystems cannot fsync a directory; the rename is still atomic.
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "EINVAL" && code !== "ENOTSUP" && code !== "EBADF" && code !== "EPERM") throw err;
  } finally {
    if (dirFd !== undefined) closeSync(dirFd);
  }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// A pid file's pid, or why there is none. "empty" is a file another process has
// created but not yet written (an O_EXCL create and its write are two steps).
type PidRead = { kind: "pid"; pid: number } | { kind: "missing" } | { kind: "empty" };

function readPidFile(path: string, name: string): PidRead {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw new Error(
      `tps-mail: ${path} cannot be read (${(err as Error).message}); its holder cannot be shown dead`,
    );
  }
  if (raw === "") return { kind: "empty" };
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) <= 0) {
    throw new Error(
      `tps-mail: ${path} does not name a pid, so its holder cannot be shown dead. Remove it if no consumer for ${name} is running.`,
    );
  }
  return { kind: "pid", pid: Number(raw) };
}

export class MailConsumer {
  readonly stats: MailConsumerStats = emptyStats();
  private readonly name: string;
  private readonly identity: string;
  private readonly inboxRoot: string;
  private readonly senders: ReadonlySet<string>;
  private readonly resolveKey: KeyResolver;
  private readonly lockFile: string;
  private readonly statsFile: string;
  private readonly pollIntervalMs: number;
  private readonly turnTimeoutMs: number;
  private readonly maxReplyChars: number;
  private readonly runTurn: TurnRunner;
  private readonly sendReply: ReplySender;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  // Per-file retry state for mail left in new/ (no hot loop on a failure).
  private readonly retry = new Map<string, { attempts: number; nextAt: number }>();
  // A reply composed by a settled turn whose send failed: a retry resends it
  // instead of running the turn again. Keyed by the signed messageId.
  private readonly pendingReplies = new Map<string, string>();
  // A settled turn (replied or silent) whose marker could not be written: a
  // retry in this run writes the marker only — no new turn, no new send.
  private readonly awaitingMarker = new Map<
    string,
    { outcome: "replied" | "no-reply"; to?: string }
  >();
  private readonly writeMarkerFile: (path: string, content: string) => void;
  private readonly lockHooks: { afterStaleCheck?: () => void };
  private readonly lockWaitMs: number;
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private stopped = false;
  private holdsLock = false;
  private current?: Promise<void>;
  private turnController?: AbortController;

  constructor(opts: MailConsumerOptions) {
    if (!AGENT_NAME.test(opts.name)) {
      throw new Error(`invalid agent name: ${opts.name} (must match ${AGENT_NAME})`);
    }
    if (opts.name.length > ORIGIN_FIELD_LIMITS.mailFrom) {
      throw new Error(`invalid agent name: exceeds ${ORIGIN_FIELD_LIMITS.mailFrom} characters`);
    }
    if (!TPS_AGENT_ID.test(opts.identity)) {
      throw new Error(`tps-mail: invalid agent identity ${JSON.stringify(opts.identity)}`);
    }
    // The schema already refuses an empty allow-list at load; the consumer
    // refuses it too, so no construction path can run with none (F2).
    if (opts.senders.length === 0) {
      throw new Error("tps-mail: refusing to consume mail with an empty senders allow-list");
    }
    for (const sender of opts.senders) {
      if (!TPS_AGENT_ID.test(sender)) {
        throw new Error(`tps-mail: senders entry ${JSON.stringify(sender)} is not an exact TPS id`);
      }
    }
    const home = homedir();
    this.name = opts.name;
    this.identity = opts.identity;
    this.inboxRoot = opts.inboxRoot;
    this.senders = new Set(opts.senders);
    this.resolveKey = opts.resolveKey;
    this.lockFile = opts.lockFile ?? join(home, ".bob", `${opts.name}.lock`);
    this.statsFile = opts.statsFile ?? tpsMailStatsPath(home, opts.name);
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.turnTimeoutMs = opts.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.maxReplyChars = opts.maxReplyChars ?? DEFAULT_MAX_REPLY_CHARS;
    this.runTurn =
      opts.runTurn ??
      launcherTurnRunner({
        launcherPath: opts.launcherPath ?? join(home, "agents", opts.name, "bin", opts.name),
        bobBin: selfBobBin(),
      });
    this.sendReply = opts.sendReply ?? tpsCliReplySender({ identity: opts.identity });
    this.retryBaseMs = opts.retryBaseMs ?? 30_000;
    this.retryMaxMs = opts.retryMaxMs ?? 30 * 60_000;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? ((m: string) => console.error(m));
    this.writeMarkerFile = opts.writeMarkerFile ?? durableWrite;
    this.lockHooks = opts.lockHooks ?? {};
    this.lockWaitMs = opts.lockWaitMs ?? 5000;
  }

  // Take the lock (only from a dead pid), create the directories, start polling.
  // Throws when a live consumer holds the lock.
  start(): void {
    if (this.running) return;
    this.acquireLock();
    for (const dir of ["new", "cur", "refused", "replied"]) {
      mkdirSync(join(this.inboxRoot, dir), { recursive: true });
    }
    this.stats.startedAt = this.now();
    this.running = true;
    this.persistStats();
    this.timer = setInterval(() => {
      this.poll().catch((err) => {
        this.log(`tps-mail: poll failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, this.pollIntervalMs);
  }

  // Stop polling, kill an in-flight turn (its mail stays in new/), wait for the
  // poll to settle, release the lock. Idempotent.
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.turnController?.abort("stopped");
    try {
      await this.current;
    } catch {
      // the poll logs its own failures
    }
    this.running = false;
    this.releaseLock();
    this.persistStats();
  }

  // One pass over new/, oldest first. Serial: a poll while one is running is a
  // no-op, and so is a poll after stop().
  poll(): Promise<void> {
    if (this.current || this.stopped) return this.current ?? Promise.resolve();
    this.current = this.pass().finally(() => {
      this.current = undefined;
      this.persistStats();
    });
    return this.current;
  }

  private async pass(): Promise<void> {
    let files: string[];
    try {
      files = readdirSync(join(this.inboxRoot, "new"))
        .filter((f) => f.endsWith(".json"))
        // readdir order is not chronological by contract; TPS filenames lead
        // with the delivery timestamp, so a filename sort is oldest first.
        .sort();
    } catch (err) {
      this.log(`tps-mail: cannot read ${join(this.inboxRoot, "new")}: ${(err as Error).message}`);
      return;
    }
    const present = new Set(files);
    for (const file of this.retry.keys()) if (!present.has(file)) this.retry.delete(file);
    for (const file of files) {
      if (this.stopped) return;
      const retry = this.retry.get(file);
      if (retry && this.now() < retry.nextAt) continue;
      try {
        await this.handle(file);
      } catch (err) {
        this.log(
          `tps-mail: ${file}: unexpected failure (${err instanceof Error ? err.message : String(err)}); left in new/`,
        );
        this.scheduleRetry(file);
      }
    }
  }

  private async handle(file: string): Promise<void> {
    const path = join(this.inboxRoot, "new", file);
    let record: unknown;
    try {
      record = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      this.refuse(file, "malformed", "the file is not JSON");
      return;
    }

    // 1. Accept — before any session exists.
    const decision = await decideInbound(record, {
      identity: this.identity,
      senders: this.senders,
      resolveKey: this.resolveKey,
    });
    if (decision.kind === "refuse") {
      this.refuse(file, decision.reason, decision.detail);
      return;
    }
    if (decision.kind === "unavailable") {
      this.stats.verifyUnavailable += 1;
      this.log(`tps-mail: ${file}: verification unavailable (${decision.detail}); left in new/`);
      this.scheduleRetry(file);
      return;
    }
    const { sender, messageId, body } = decision;

    // 2. Already answered (a crash after the marker, or a re-delivery of the
    //    same signed message): ack without a turn and without a reply.
    if (existsSync(this.markerPath(messageId))) {
      if (!this.ack(file)) {
        this.scheduleRetry(file);
        return;
      }
      this.awaitingMarker.delete(messageId);
      this.stats.duplicates += 1;
      this.log(`tps-mail: ${messageId} from ${sender} already answered (replied/ marker); acked`);
      return;
    }

    // 2b. Settled earlier in THIS run, but its marker could not be written:
    //     write the marker only — never a new turn, never a new send.
    const unmarked = this.awaitingMarker.get(messageId);
    if (unmarked) {
      this.settle(file, messageId, unmarked);
      return;
    }

    // 3. The turn — unless an earlier attempt already composed the reply.
    let replyText = this.pendingReplies.get(messageId);
    if (replyText === undefined) {
      this.log(`tps-mail: ${messageId} from ${sender}: running one fresh-session turn`);
      const outcome = await this.runBoundedTurn({ sender, messageId, body });
      // A stopped consumer never acks, marks or replies for a cut turn: the
      // mail stays in new/ and the next runtime re-delivers it.
      if (this.stopped) return;
      if (outcome.kind === "failed") {
        this.stats.dispatchFailed += 1;
        if (outcome.reason === "timeout") this.stats.timeouts += 1;
        this.log(
          `tps-mail: ${messageId} turn FAILED (${outcome.reason}: ${outcome.detail}); no reply, left in new/`,
        );
        this.scheduleRetry(file);
        return;
      }
      if (outcome.kind === "silent") {
        this.log(`tps-mail: ${messageId} settled with no final message; no reply sent`);
        this.settle(file, messageId, { outcome: "no-reply" });
        return;
      }
      replyText = capReply(outcome.text, this.maxReplyChars);
    }

    // 4. The reply: exit 0, then the marker, then the ack (post-before-ack).
    const sent = await this.sendReply({ to: sender, inReplyTo: messageId, body: replyText });
    if (!sent.ok) {
      this.stats.replyFailed[sent.reason] += 1;
      this.pendingReplies.set(messageId, replyText);
      this.log(
        `tps-mail: reply to ${sender} for ${messageId} FAILED (${sent.reason}: ${sent.detail}); left in new/ for a retry`,
      );
      this.scheduleRetry(file);
      return;
    }
    this.pendingReplies.delete(messageId);
    this.log(
      `tps-mail: replied to ${sender} (in reply to ${messageId}, ${replyText.length} chars)`,
    );
    // The reply went out: record it durably and ack, even if a stop arrived.
    this.settle(file, messageId, { outcome: "replied", to: sender });
  }

  // A settled turn: the DURABLE marker, THEN the ack, THEN the count. A marker
  // that cannot be written leaves the mail in new/ — not acked, not counted —
  // with backoff, and is remembered so a retry in this run writes the marker
  // without resending. Only if the process dies before a marker lands can the
  // reply be sent again, threaded to the same messageId (the stated
  // at-least-once case).
  private settle(
    file: string,
    messageId: string,
    what: { outcome: "replied" | "no-reply"; to?: string },
  ): void {
    try {
      mkdirSync(join(this.inboxRoot, "replied"), { recursive: true });
      this.writeMarkerFile(
        this.markerPath(messageId),
        `${JSON.stringify({ inboundId: messageId, ...what, at: new Date(this.now()).toISOString() })}\n`,
      );
    } catch (err) {
      this.awaitingMarker.set(messageId, what);
      this.stats.markerFailed += 1;
      this.log(
        `tps-mail: could not durably write the replied/ marker for ${messageId} (${(err as Error).message}); NOT acked, left in new/ — a retry writes the marker without resending`,
      );
      this.scheduleRetry(file);
      return;
    }
    this.awaitingMarker.delete(messageId);
    // The marker is down: if the ack fails, the retry sees the marker and acks.
    if (!this.ack(file)) {
      this.scheduleRetry(file);
      return;
    }
    this.stats.processed += 1;
    if (what.outcome === "replied") this.stats.replied += 1;
    else this.stats.noReply += 1;
  }

  // Run the turn under the wall-clock bound. The race makes the bound hold even
  // for a runner that ignores its signal.
  private async runBoundedTurn(input: MailTurnInput): Promise<TurnOutcome> {
    const controller = new AbortController();
    this.turnController = controller;
    const timer = setTimeout(() => controller.abort("timeout"), this.turnTimeoutMs);
    const aborted = new Promise<TurnOutcome>((resolve) => {
      const onAbort = () => {
        const reason: TurnFailure = controller.signal.reason === "timeout" ? "timeout" : "stopped";
        resolve({ kind: "failed", reason, detail: `turn aborted (${reason})` });
      };
      if (controller.signal.aborted) onAbort();
      else controller.signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([
        this.runTurn(input, controller.signal).catch(
          (err): TurnOutcome => ({
            kind: "failed",
            reason: "exit",
            detail: err instanceof Error ? err.message : String(err),
          }),
        ),
        aborted,
      ]);
    } finally {
      clearTimeout(timer);
      if (this.turnController === controller) this.turnController = undefined;
    }
  }

  private scheduleRetry(file: string): void {
    const prior = this.retry.get(file)?.attempts ?? 0;
    const attempts = prior + 1;
    const delay = Math.min(this.retryBaseMs * 2 ** (attempts - 1), this.retryMaxMs);
    this.retry.set(file, { attempts, nextAt: this.now() + delay });
  }

  private refuse(file: string, reason: RefusalReason, detail: string): void {
    this.stats.refused[reason] += 1;
    const refusedDir = join(this.inboxRoot, "refused");
    try {
      mkdirSync(refusedDir, { recursive: true });
      renameSync(join(this.inboxRoot, "new", file), join(refusedDir, file));
      writeFileSync(
        join(refusedDir, `${file}.reason`),
        `reason: ${reason}\n${detail}\nrefused at ${new Date(this.now()).toISOString()}\n`,
        { mode: 0o600 },
      );
    } catch (err) {
      this.log(`tps-mail: could not move ${file} to refused/: ${(err as Error).message}`);
      this.scheduleRetry(file);
    }
    this.log(`tps-mail: REFUSED ${file} (${reason}: ${detail}); no turn, no reply`);
  }

  private markerPath(messageId: string): string {
    return join(this.inboxRoot, "replied", messageId);
  }

  private ack(file: string): boolean {
    try {
      mkdirSync(join(this.inboxRoot, "cur"), { recursive: true });
      renameSync(join(this.inboxRoot, "new", file), join(this.inboxRoot, "cur", file));
      return true;
    } catch (err) {
      this.log(`tps-mail: could not ack ${file} (move to cur/): ${(err as Error).message}`);
      return false;
    }
  }

  // The consumer lock (Kern 2; Gauge round 4, blocker 3). Exclusive by
  // construction, with no unlink-then-create window:
  //   * a free lock is created with O_EXCL (`wx`): exactly one creator wins;
  //   * a lock naming a LIVE pid is never taken, however old it is;
  //   * a lock naming a DEAD pid is taken over only through an exclusive claim
  //     keyed on that pid (`<lock>.takeover-<pid>`, O_EXCL). The claimant
  //     re-reads the lock and replaces it (temp + rename, so the lock path never
  //     disappears) ONLY if it still names that dead pid, then drops the claim.
  //     A racer that loses the claim waits and re-reads; a racer that takes the
  //     claim late finds the lock changed and re-reads. Racing restarts end with
  //     exactly one holder.
  //   * a claim whose claimant is DEAD (killed inside those few synchronous
  //     steps) cannot be broken without reopening the race, so it fails closed
  //     naming the file to remove.
  private acquireLock(): void {
    mkdirSync(dirname(this.lockFile), { recursive: true });
    const deadline = Date.now() + this.lockWaitMs;
    for (;;) {
      try {
        writeFileSync(this.lockFile, String(process.pid), { flag: "wx", mode: 0o600 });
        this.holdsLock = true;
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      const lock = readPidFile(this.lockFile, this.name);
      if (lock.kind === "missing") continue; // released meanwhile: create it
      if (lock.kind === "pid" && pidAlive(lock.pid)) {
        throw new Error(
          `mail consumer for ${this.name} already running (pid ${lock.pid}, lock ${this.lockFile})`,
        );
      }
      if (lock.kind === "pid") {
        this.lockHooks.afterStaleCheck?.();
        const outcome = this.takeOverDeadLock(lock.pid);
        if (outcome === "held") {
          this.holdsLock = true;
          return;
        }
        if (outcome === "changed") continue;
      }
      // "empty" (being written) or "busy" (another takeover in progress): wait.
      if (Date.now() > deadline) {
        throw new Error(
          `tps-mail: the consumer lock ${this.lockFile} did not settle within ${this.lockWaitMs}ms (another process is creating or taking it over)`,
        );
      }
      sleepSync(20);
    }
  }

  private takeOverDeadLock(dead: number): "held" | "changed" | "busy" {
    const claim = `${this.lockFile}.takeover-${dead}`;
    try {
      writeFileSync(claim, String(process.pid), { flag: "wx", mode: 0o600 });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const claimant = readPidFile(claim, this.name);
      if (claimant.kind !== "pid" || pidAlive(claimant.pid)) return "busy";
      throw new Error(
        `tps-mail: a takeover of the consumer lock ${this.lockFile} (dead pid ${dead}) by pid ${claimant.pid} was interrupted, leaving ${claim}. Remove that file (and the lock, if no consumer for ${this.name} is running) to continue.`,
      );
    }
    try {
      // Only the claimant is here. Replace the lock ONLY if it still names the
      // dead pid: anything else means someone else already moved it on.
      const current = readPidFile(this.lockFile, this.name);
      if (current.kind !== "pid" || current.pid !== dead) return "changed";
      atomicWrite(this.lockFile, String(process.pid));
      this.log(`tps-mail: took over the consumer lock from dead pid ${dead}`);
      return "held";
    } finally {
      try {
        unlinkSync(claim);
      } catch {
        // already gone
      }
    }
  }

  private releaseLock(): void {
    if (!this.holdsLock) return;
    this.holdsLock = false;
    try {
      if (readFileSync(this.lockFile, "utf8").trim() === String(process.pid)) {
        unlinkSync(this.lockFile);
      }
    } catch {
      // best effort
    }
  }

  private persistStats(): void {
    try {
      mkdirSync(dirname(this.statsFile), { recursive: true });
      atomicWrite(
        this.statsFile,
        `${JSON.stringify(
          {
            agent: this.name,
            identity: this.identity,
            inbox: this.inboxRoot,
            pid: process.pid,
            updatedAt: new Date(this.now()).toISOString(),
            pendingRetry: this.retry.size,
            ...this.stats,
          },
          null,
          2,
        )}\n`,
      );
    } catch {
      // stats are for doctor; never let them stop the consumer
    }
  }
}

// ─── Wiring from bob.yaml (the persistent runtime) ──────────────────────────

export function tpsMailStatsPath(home: string, name: string): string {
  return join(home, ".bob", `${name}.tps-mail-stats.json`);
}

export interface TpsMailIdentity {
  url: string;
  agentId: string;
  keyFile: string;
}

// The agent's Flair identity (bob.yaml `flair:` url/agentId/keyFile). tps-mail
// needs it twice: to look up each sender's registered key, signed as this
// agent, and as the identity replies are signed with. Throws with the fix.
export function readTpsMailIdentity(yamlText: string): TpsMailIdentity {
  const block = readBlock(yamlText, "flair");
  const url = block?.url;
  const agentId = block?.agentId;
  const keyFile = block?.keyFile;
  if (typeof url !== "string" || typeof agentId !== "string" || typeof keyFile !== "string") {
    throw new Error(
      "tps-mail needs the agent's Flair identity — bob.yaml flair: url, agentId and keyFile. " +
        "It verifies each sender against the key registered in Flair and signs replies as the agent. " +
        "Onboard with Flair (bob onboard <name>) or add the flair: block.",
    );
  }
  if (!TPS_AGENT_ID.test(agentId)) {
    throw new Error(
      `tps-mail: bob.yaml flair.agentId ${JSON.stringify(agentId)} is not a TPS agent id`,
    );
  }
  return { url, agentId, keyFile };
}

export interface TpsMailRuntimeOptions {
  name: string;
  agentDir: string;
  // The block resolveCapabilities validated (re-validated here).
  config: unknown;
  home?: string;
  log?: (msg: string) => void;
  // Test seams.
  overrides?: Partial<MailConsumerOptions>;
}

export function createTpsMailConsumer(opts: TpsMailRuntimeOptions): MailConsumer {
  const home = opts.home ?? homedir();
  const config: TpsMailCapabilityConfig = validateTpsMailConfig(opts.config);
  const identity = readTpsMailIdentity(readFileSync(join(opts.agentDir, "bob.yaml"), "utf8"));
  return new MailConsumer({
    name: opts.name,
    identity: identity.agentId,
    inboxRoot: expandHome(config.inbox, home),
    senders: config.senders,
    turnTimeoutMs: config.turnTimeoutMs,
    maxReplyChars: config.maxReplyChars,
    launcherPath: join(opts.agentDir, "bin", opts.name),
    lockFile: join(home, ".bob", `${opts.name}.lock`),
    statsFile: tpsMailStatsPath(home, opts.name),
    resolveKey: createFlairKeyResolver({
      flairUrl: identity.url,
      agentId: identity.agentId,
      keyFile: expandHome(identity.keyFile, home),
    }),
    ...(opts.log ? { log: opts.log } : {}),
    ...opts.overrides,
  });
}
