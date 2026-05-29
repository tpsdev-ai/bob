// Mail consumer — poll a TPS mail inbox and dispatch each message
// through the agent's launcher (bin/<name>).
//
// Inbox layout (TPS convention):
//   ~/.tps/mail/<name>/new/<timestamp>-<uuid>.json   — unread
//   ~/.tps/mail/<name>/cur/                          — processed
//
// Mail format (per ~/.tps/mail/flint/new/*.json on rockit):
//   { id, from, to, body, timestamp, read, headers: { X-TPS-* } }
//
// The consumer is intentionally dumb: it doesn't know about pi-coding-agent
// or Claude or anything — it just shells out to bin/<name> with the mail
// body as the prompt. The agent's launcher decides how to interpret it.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface MailMessage {
  id: string;
  from: string;
  to: string;
  body: string;
  timestamp: string;
  read?: boolean;
  headers?: Record<string, string>;
}

export interface MailConsumerOptions {
  name: string;
  // Inbox root. Defaults to ~/.tps/mail/<name>/. Tests override.
  inboxRoot?: string;
  // Launcher path. Defaults to ~/agents/<name>/bin/<name>.
  launcherPath?: string;
  // Polling interval in ms. Default 2000.
  pollIntervalMs?: number;
  // Lock file location. Defaults to ~/.bob/<name>.lock.
  lockFile?: string;
  // Custom dispatch handler. Tests inject; defaults to spawning the launcher.
  dispatch?: (msg: MailMessage) => Promise<void>;
}

export interface MailConsumerStats {
  processed: number;
  failed: number;
  startedAt: number;
}

const AGENT_NAME = /^[a-z0-9-]+$/;

export class MailConsumer {
  private readonly opts: Required<Omit<MailConsumerOptions, "dispatch">> & {
    dispatch?: MailConsumerOptions["dispatch"];
  };
  private readonly seenFiles = new Set<string>();
  private running = false;
  private timer?: ReturnType<typeof setInterval>;
  private inFlight = false;
  readonly stats: MailConsumerStats;

  constructor(opts: MailConsumerOptions) {
    if (!AGENT_NAME.test(opts.name)) {
      throw new Error(`invalid agent name: ${opts.name} (must match ${AGENT_NAME})`);
    }
    const inboxRoot = opts.inboxRoot ?? join(homedir(), ".tps", "mail", opts.name);
    const launcherPath =
      opts.launcherPath ?? join(homedir(), "agents", opts.name, "bin", opts.name);
    this.opts = {
      name: opts.name,
      inboxRoot,
      launcherPath,
      pollIntervalMs: opts.pollIntervalMs ?? 2000,
      lockFile: opts.lockFile ?? join(homedir(), ".bob", `${opts.name}.lock`),
      dispatch: opts.dispatch,
    };
    this.stats = { processed: 0, failed: 0, startedAt: 0 };
  }

  // Acquire the lock. We deliberately do NOT pre-populate seenFiles —
  // openclaw-tps-mail did and stranded mail written before its watcher
  // started (see reference_tps_mail_watcher_startup_race in flint's
  // memory). Bob processes whatever's in new/ on the first poll;
  // seenFiles only guards against re-processing within the same run.
  start(): void {
    if (this.running) return;
    this.acquireLock();
    mkdirSync(join(this.opts.inboxRoot, "new"), { recursive: true });
    mkdirSync(join(this.opts.inboxRoot, "cur"), { recursive: true });
    this.stats.startedAt = Date.now();
    this.running = true;
    this.timer = setInterval(() => {
      this.poll().catch(() => {
        /* swallow — recoverable; see stats.failed */
      });
    }, this.opts.pollIntervalMs);
  }

  stop(): void {
    if (!this.running) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.running = false;
    this.releaseLock();
  }

  // Pull current new files, drop any we've already seen, dispatch the rest.
  // Runs serially to keep the launcher lane single-threaded.
  async poll(): Promise<void> {
    if (this.inFlight) return; // serial — one dispatch at a time
    this.inFlight = true;
    try {
      const newDir = join(this.opts.inboxRoot, "new");
      const files = readdirSync(newDir).filter(
        (f) => !this.seenFiles.has(f) && f.endsWith(".json"),
      );
      for (const file of files) {
        this.seenFiles.add(file);
        const path = join(newDir, file);
        try {
          const msg = JSON.parse(readFileSync(path, "utf8")) as MailMessage;
          await this.handle(msg);
          this.moveToCur(file);
          this.stats.processed += 1;
        } catch (_err) {
          this.stats.failed += 1;
          // Leave the file in new/ but keep it in seenFiles so we don't
          // hot-loop on a poison message. Re-deliver after restart.
        }
      }
    } finally {
      this.inFlight = false;
    }
  }

  private async handle(msg: MailMessage): Promise<void> {
    if (this.opts.dispatch) {
      return this.opts.dispatch(msg);
    }
    // Default: spawn the agent's launcher with body as stdin prompt arg.
    // TODO(phase1): migrate to SDK — route mail through runAgent's embedded
    // pi session (run.ts) instead of spawning the generated launcher.
    return new Promise<void>((resolve, reject) => {
      const child = spawn(this.opts.launcherPath, [msg.body], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.on("error", reject);
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`launcher exited ${code}`));
      });
    });
  }

  private moveToCur(file: string): void {
    const from = join(this.opts.inboxRoot, "new", file);
    const to = join(this.opts.inboxRoot, "cur", file);
    renameSync(from, to);
  }

  private acquireLock(): void {
    mkdirSync(join(this.opts.lockFile, ".."), { recursive: true });
    if (existsSync(this.opts.lockFile)) {
      // Stale lock check — if pid file is older than 5 min and the pid
      // isn't alive, take it. Otherwise fail loud.
      const ageMs = Date.now() - statSync(this.opts.lockFile).mtimeMs;
      const existing = parseInt(readFileSync(this.opts.lockFile, "utf8").trim(), 10);
      if (ageMs < 5 * 60_000 && isAlive(existing)) {
        throw new Error(`mail consumer for ${this.opts.name} already running (pid ${existing})`);
      }
    }
    writeFileSync(this.opts.lockFile, String(process.pid));
  }

  private releaseLock(): void {
    try {
      unlinkSync(this.opts.lockFile);
    } catch {
      // best effort
    }
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
