// write-soul.ts - the bob-owned, soul-ONLY write tool for the setup sessions
// (`bob onboard`'s hiring interview and `bob align`). bob#204.
//
// WHY IT EXISTS. The setup sessions used to add pi's generic `write` so the
// interview could write the agent's refined persona to `soul.md` - the one
// documented exception to the role/grant ceiling. But pi's `write` accepts any
// absolute path the OS user can write, so a setup session could rewrite
// `bob.yaml`, capability overrides, grants, launcher scripts, or files outside
// the agent directory. It was never limited to `soul.md`.
//
// WHAT `write_soul` IS. A pi tool (registered as an inline extension) whose ONLY
// target is the agent's own `soul.md`, resolved by bob from the session config -
// NEVER from a tool argument. The tool takes CONTENT ONLY: its schema has a
// single `content` string and NO path parameter, so no caller can name a
// different file to write. Defenses, all at the one write:
//
//   - the target is bob's resolved `<agentDir>/soul.md`; a `path` argument (if a
//     caller invents one) is refused BY NAME, and the target is never read from
//     params;
//   - the parent directory and soul.md must NOT be symlinks - a symlinked
//     soul.md would let the write follow the link outside the agent directory;
//   - the content is size-capped (MAX_SOUL_BYTES, stated below);
//   - the write is ATOMIC: a temp file in the SAME directory, fsync, then rename
//     over the target, so a crash never leaves a half-written soul.md.
//
// LIMIT, STATED. An agent running as the operator's OS user with a shell or
// unrestricted read can still reach operator files directly. That needs an OS
// boundary (bob#189 nono), which this does not replace.

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";

/** The one tool name the setup policy grants (read + write_soul). */
export const WRITE_SOUL_TOOL = "write_soul";

/**
 * The size cap for a soul.md written through `write_soul`: 64 KiB of UTF-8.
 * A persona is prose; 64 KiB is a generous ceiling that still bounds what a
 * model can dump into the agent's directory in one call. A larger body is
 * refused with the observed size, never truncated.
 */
export const MAX_SOUL_BYTES = 64 * 1024;

export interface SoulToolOutput {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}

/** The pi ExtensionAPI slice `write_soul` needs. Structural, so a test fake and
 *  pi's real ExtensionAPI both satisfy it. */
export interface SoulWritePi {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
      onUpdate?: unknown,
      ctx?: unknown,
    ) => Promise<SoulToolOutput>;
  }): void;
}

export interface WireSoulWriteOptions {
  /** Logger seam; defaults to console.error. Refusals are returned to the model
   *  in the tool result, not logged, so this is only for unexpected errors. */
  log?: (msg: string) => void;
}

function ok(text: string, details: Record<string, unknown>): SoulToolOutput {
  return { content: [{ type: "text", text }], details };
}

function refuse(reason: string, extra: Record<string, unknown> = {}): SoulToolOutput {
  return ok(`REFUSED: ${reason}`, { refused: true, reason, ...extra });
}

/**
 * Register `write_soul` on `pi`, bound to `soulPath` (an absolute path bob
 * resolved). Returns nothing; the registered tool's only input is `content`.
 */
export function wireSoulWrite(
  pi: SoulWritePi,
  soulPath: string,
  opts: WireSoulWriteOptions = {},
): void {
  const log = opts.log ?? ((m: string) => console.error(m));

  const execute = async (_id: string, params: Record<string, unknown>): Promise<SoulToolOutput> => {
    // The tool takes CONTENT ONLY. A caller that invents a path-ish argument is
    // refused BY NAME - never "ignored" - because a silently ignored path reads
    // as a success while the write lands somewhere the caller did not intend.
    const pathKeys = ["path", "file", "filepath", "file_path", "filename", "target"];
    for (const key of pathKeys) {
      if (Object.hasOwn(params, key)) {
        return refuse(
          `write_soul takes no path - its only target is the agent's soul.md, resolved by bob. Drop the "${key}" argument.`,
        );
      }
    }

    const content = params.content;
    if (typeof content !== "string") {
      return refuse("write_soul requires a string `content`.");
    }
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > MAX_SOUL_BYTES) {
      return refuse(
        `soul content is ${bytes} bytes, over the ${MAX_SOUL_BYTES}-byte cap. Shorten it and retry.`,
        { bytes, cap: MAX_SOUL_BYTES },
      );
    }

    // Refuse a symlinked PARENT directory: a symlinked agent dir would redirect
    // the whole write outside the agent's tree.
    let dirLstat: Stats;
    try {
      dirLstat = lstatSync(dirname(soulPath));
    } catch {
      return refuse(`the agent directory ${dirname(soulPath)} does not exist.`);
    }
    if (dirLstat.isSymbolicLink()) {
      return refuse(
        `the agent directory ${dirname(soulPath)} is a symlink; refusing to follow it.`,
      );
    }
    if (!dirLstat.isDirectory()) {
      return refuse(`the agent directory ${dirname(soulPath)} is not a directory.`);
    }

    // Refuse a symlinked soul.md: pi's write (and this one) must never follow a
    // link to a file outside the agent's tree.
    if (existsSync(soulPath)) {
      const soulStat = lstatSync(soulPath);
      if (soulStat.isSymbolicLink()) {
        return refuse("soul.md is a symlink; refusing to write through it.");
      }
      if (!soulStat.isFile()) {
        return refuse("soul.md exists but is not a regular file.");
      }
    }

    // Atomic write: temp file in the SAME directory (same filesystem), fsync,
    // rename over the target. A crash leaves either the old soul.md or the new
    // one, never a truncated file.
    const tmp = join(
      dirname(soulPath),
      `.${basename(soulPath)}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    );
    let fd: number | undefined;
    try {
      fd = openSync(tmp, "wx", 0o600);
      writeSync(fd, content, null, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tmp, soulPath);
    } catch (err) {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* the write failure is the error that matters */
        }
      }
      try {
        unlinkSync(tmp);
      } catch {
        /* best effort */
      }
      const message = err instanceof Error ? err.message : String(err);
      log(`write_soul failed: ${message}`);
      return refuse(`the write to soul.md failed: ${message}`);
    }

    return ok(`Wrote ${bytes} bytes to ${soulPath}.`, { bytes, path: soulPath });
  };

  pi.registerTool({
    name: WRITE_SOUL_TOOL,
    label: "Write Soul",
    description:
      "Write the agent's persona to its own soul.md (OVERWRITING it). This is the ONLY file this tool can write: the target is resolved by bob, there is no path argument. Pass the full markdown persona as `content`.",
    parameters: Type.Object({
      content: Type.String({
        minLength: 1,
        description: "The full soul.md contents (markdown, first-person).",
      }),
    }),
    execute,
  });
}

/**
 * The inline pi extension that registers `write_soul` bound to `soulPath`. bob's
 * session factory adds it (and ONLY for a setup session, where `setupSoulPath`
 * is set), so the tool exists only where the setup policy grants it.
 */
export function createWriteSoulExtension(soulPath: string): InlineExtension {
  return {
    name: "bob-write-soul",
    factory: ((pi: SoulWritePi) => {
      wireSoulWrite(pi, soulPath);
    }) as (pi: unknown) => void,
    hidden: true,
  };
}
