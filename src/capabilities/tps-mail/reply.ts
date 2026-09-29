// The reply transport (bob#200 §5; Kern 3/8, Sherlock F7/F8).
//
// bob owns the SEMANTICS (the recipient is the verified sender, the body is the
// turn's final text, the reply threads to the inbound messageId); the `tps` CLI
// owns the MECHANICS (signing, routing, branch relay, the outbox). bob never
// writes a maildir or an outbox itself.
//
// The process shape is fixed: `tps` with a CONSTANT argv — no shell, and no
// body in argv (argv is visible to every local user, and a body starting with
// "-" is a flag to the CLI's parser). The body goes on STDIN. TPS_AGENT_ID is
// the agent's own identity, never anything from the mail, so the CLI signs the
// reply as the agent. The exit code is authoritative: 0 is sent, anything else
// (or a missing CLI, or a timeout) is a counted failure and the inbound stays
// in new/ for a later retry. A timeout or a non-zero exit is AMBIGUOUS — the CLI
// may have handed the reply on before failing — so that retry can deliver a
// second reply, threaded to the same messageId (the stated at-least-once case).
//
// CLI CONTRACT: the argv below asks the CLI for the body on stdin (`--stdin`)
// and for threading (`--reply-to <messageId>`, signed inside the envelope as
// `replyToId`). tpsdev-ai/cli#431 added both, reads the PEM PKCS8 key `bob
// onboard` writes, and refuses a send it cannot sign. @tpsdev-ai/cli 0.7.0 and
// older take neither flag — the body is argv-only and there is no reply-to —
// so with them every reply FAILS CLOSED here (the usage error exits non-zero):
// counted, logged and retried, never sent unthreaded or with the body in argv.
// `bob doctor` FAILS a tps on PATH whose mail usage does not name both flags.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The one argv the reply is sent with. `to` and `inReplyTo` are validated ids
// (TPS_AGENT_ID / MESSAGE_ID), so neither can be read as a flag.
export function replyArgv(to: string, inReplyTo: string): string[] {
  return ["mail", "send", to, "--stdin", "--reply-to", inReplyTo];
}

export const DEFAULT_REPLY_TIMEOUT_MS = 60_000;

// Cap the reply like the Discord mirror caps its post (DISCORD_MAX_REPLY_CHARS):
// cut and mark with an ellipsis, the whole thing at most `max` characters.
export function capReply(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return text.slice(0, Math.max(0, max));
  let cut = text.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export interface ReplyRequest {
  // The VERIFIED sender of the inbound.
  to: string;
  // The inbound's signed messageId.
  inReplyTo: string;
  body: string;
}

export type ReplyFailure = "cli-missing" | "no-signing-key" | "exit" | "timeout";

export type ReplyResult = { ok: true } | { ok: false; reason: ReplyFailure; detail: string };

export type ReplySender = (reply: ReplyRequest) => Promise<ReplyResult>;

export interface TpsCliReplyOptions {
  // The agent's own TPS id — TPS_AGENT_ID for the send. Never from the mail.
  identity: string;
  // The CLI to run. Defaults to `tps` resolved on PATH.
  tpsBin?: string;
  // The directory the CLI reads the signing key from (`<dir>/<identity>.key`).
  // Defaults to ~/.flair/keys, the CLI's own default.
  keysDir?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

// The default reply sender: spawn the TPS CLI.
export function tpsCliReplySender(opts: TpsCliReplyOptions): ReplySender {
  const tpsBin = opts.tpsBin ?? "tps";
  const keysDir = opts.keysDir ?? join(homedir(), ".flair", "keys");
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REPLY_TIMEOUT_MS;

  return (reply) =>
    new Promise<ReplyResult>((resolve) => {
      // The CLI signs with <keysDir>/<from>.key. A tps before tpsdev-ai/cli#431
      // with NO key sends the body UNSIGNED and still exits 0 — a reply every
      // promote()-reading recipient dead-letters; a tps with that change
      // refuses the send itself. bob refuses first either way, rather than
      // record a dead letter as "sent".
      const keyPath = join(keysDir, `${opts.identity}.key`);
      if (!existsSync(keyPath)) {
        resolve({
          ok: false,
          reason: "no-signing-key",
          detail: `no signing key at ${keyPath} for ${opts.identity}; the CLI would send the reply unsigned`,
        });
        return;
      }

      const env: NodeJS.ProcessEnv = { ...(opts.env ?? process.env) };
      // An ambient inbound chain must never ride into this reply's signature.
      delete env.TPS_INBOUND_CHAIN_JSON;
      env.TPS_AGENT_ID = opts.identity;

      let settled = false;
      const finish = (result: ReplyResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      let stderr = "";
      const child = spawn(tpsBin, replyArgv(reply.to, reply.inReplyTo), {
        stdio: ["pipe", "ignore", "pipe"],
        env,
        shell: false,
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ ok: false, reason: "timeout", detail: `tps did not exit within ${timeoutMs}ms` });
      }, timeoutMs);
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.length < 4096) stderr += chunk.toString("utf8");
      });
      child.on("error", (err: NodeJS.ErrnoException) => {
        finish({
          ok: false,
          reason: err.code === "ENOENT" ? "cli-missing" : "exit",
          detail: err.code === "ENOENT" ? `${tpsBin} not found` : err.message,
        });
      });
      child.on("close", (code, signal) => {
        if (code === 0) {
          finish({ ok: true });
          return;
        }
        const tail = stderr.replace(/\s+/g, " ").trim().slice(-300);
        finish({
          ok: false,
          reason: "exit",
          detail: `tps exited ${code ?? signal}${tail ? `: ${tail}` : ""}`,
        });
      });
      // The body goes on stdin. A CLI that exits without reading it closes the
      // pipe; that EPIPE is the exit code's story, not a crash.
      child.stdin?.on("error", () => {});
      child.stdin?.end(reply.body, "utf8");
    });
}
