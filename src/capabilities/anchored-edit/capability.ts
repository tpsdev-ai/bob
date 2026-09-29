// The testable core of the anchored-edit capability, decoupled from pi's real
// ExtensionAPI so it can be unit-tested with a fake (no live model). `index.ts`
// is the thin pi extension factory.
//
// What this wires — four tools via pi.registerTool:
//   read_lines   — fingerprint + anchor-per-line body for a file
//   edit_lines   — replace lines from..to inclusive (empty text deletes)
//   insert_after — insert after an anchor line, or L0 for before line 1
//   write_file   — exclusive creation only; takes no fingerprint
//
// The WORKSPACE ROOT is pi's tool execution context `cwd` (the 5th `execute`
// argument, ExtensionContext.cwd). Neither a tool argument nor bob.yaml can name
// it. See core.ts for the byte rules and README.md for the documented gaps.

import { type TSchema, Type } from "typebox";
import {
  AnchoredEditSession,
  clampUtf8,
  MAX_OUTPUT_BYTES,
  Refusal,
  type ToolOutput,
  type WriteChunk,
} from "./core.js";

// The minimal slice of pi's ExtensionAPI this core needs. Declared structurally
// so a tiny test fake and the real ExtensionAPI both satisfy it.
export interface PiLike {
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
      ctx?: { cwd: string },
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void;
}

export interface WireOptions {
  pi: PiLike;
  // Logger seam — defaults to console.error.
  log?: (msg: string) => void;
  // Writer seam — lets a test force a short write; defaults to node writeSync.
  writeChunk?: WriteChunk;
}

const ANCHOR_DOC =
  "An anchor token is `L<n>#<h>`: line number n, and h = 8 lowercase hex of FNV-1a 32 over the line's UTF-8 bytes with its terminator and a trailing CR stripped. `L0` addresses the position before line 1. The token is stable and unseeded; a line number is never folded into h.";

function ok(text: string, details: Record<string, unknown>): ToolOutput {
  return { content: [{ type: "text", text }], details };
}

// Enforce the output cap on every result, including errors. The truncation is
// UTF-8-byte-safe and reserves room for its own marker, so the result never
// exceeds the cap.
function capped(text: string): string {
  return clampUtf8(text, MAX_OUTPUT_BYTES);
}

export function wireAnchoredEdit(opts: WireOptions): AnchoredEditSession {
  const { pi } = opts;
  const log = opts.log ?? ((m: string) => console.error(m));
  const session = new AnchoredEditSession(opts.writeChunk);

  // Run one tool body with the shared result shape: every result (success or
  // refusal) is capped, and a refusal records its signals in the structured
  // details so the run log carries them.
  async function run(fn: () => ToolOutput | Promise<ToolOutput>): Promise<ToolOutput> {
    try {
      const out = await fn();
      return {
        content: [{ type: "text", text: capped(out.content[0].text) }],
        details: out.details,
      };
    } catch (err) {
      if (err instanceof Refusal) {
        return ok(capped(`REFUSED: ${err.message}`), {
          refused: true,
          signals: [...err.signals],
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      return ok(capped(`ERROR: ${message}`), { refused: true, signals: [] });
    }
  }

  const ctxCwd = (ctx: { cwd: string } | undefined): string => {
    if (!ctx || typeof ctx.cwd !== "string" || ctx.cwd === "") {
      throw new Refusal(
        "no workspace root: pi did not supply a tool execution context cwd. The root comes from pi's context only.",
      );
    }
    return ctx.cwd;
  };

  pi.registerTool({
    name: "read_lines",
    label: "Read Lines",
    description:
      `Read a file as a fingerprint header plus one anchored line per line. ` +
      `${ANCHOR_DOC} The header is F#<16 hex> (first 16 hex of SHA-256 over the raw bytes), the line count, the dominant line ending and whether a BOM is present. ` +
      `Pages show at most ${200} lines and ${MAX_OUTPUT_BYTES} bytes; the header says when a page was cut. ` +
      `Pass the F# from the latest read (or edit) to every mutating call.`,
    parameters: Type.Object({
      path: Type.String({ minLength: 1, description: "Path relative to the workspace root." }),
      start: Type.Optional(
        Type.Integer({ minimum: 1, description: "First line to show (1-based)." }),
      ),
      end: Type.Optional(
        Type.Integer({ minimum: 1, description: "Last line to show (1-based, inclusive)." }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        session.readLines(
          ctxCwd(ctx),
          params.path as string,
          params.start as number | undefined,
          params.end as number | undefined,
        ),
      );
    },
  });

  pi.registerTool({
    name: "edit_lines",
    label: "Edit Lines",
    description:
      `Replace the range from the 'from' anchor to the 'to' anchor INCLUSIVE with new_text, or delete it when new_text is empty. ` +
      `${ANCHOR_DOC} BOTH ends are anchors from read_lines; every call also needs the current F# (a fingerprint). A stale anchor or fingerprint is refused as stale, naming the expected and observed tokens and a re-read window. ` +
      `new_text is split into logical lines on LF or CRLF; a trailing separator's final empty segment is discarded, so "\\n" is one blank line. ` +
      `If any line of new_text still begins with a read_lines anchor prefix (L<n>#<8 hex> ), the call is refused, naming the first offending line: strip the copied prefixes. Pass allow_anchor_prefixes: true ONLY for a file whose real content genuinely begins lines with that shape. ` +
      `A line longer than 2000 characters cannot be edited. A call that would remove or replace more than half the file is refused by the rewrite tripwire.`,
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      from: Type.String({
        minLength: 1,
        description: "The L<n>#<h> anchor of the FIRST line to replace.",
      }),
      to: Type.String({
        minLength: 1,
        description: "The L<n>#<h> anchor of the LAST line to replace (inclusive).",
      }),
      new_text: Type.String(),
      fingerprint: Type.String({
        minLength: 1,
        description: "The current F#<16 hex> for the file.",
      }),
      allow_anchor_prefixes: Type.Optional(
        Type.Boolean({
          description:
            "Default false. Set true ONLY for a file whose real content genuinely begins lines with the read_lines anchor shape (L<n>#<8 hex> ); it turns off the anchor-prefix guard for this call.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        session.editLines(
          ctxCwd(ctx),
          params.path as string,
          params.from as string,
          params.to as string,
          params.new_text as string,
          params.fingerprint as string,
          params.allow_anchor_prefixes === true,
        ),
      );
    },
  });

  pi.registerTool({
    name: "insert_after",
    label: "Insert After",
    description:
      `Insert text after an existing line anchor, or use L0 to insert before line 1 (valid for any existing file, including an empty one). ` +
      `${ANCHOR_DOC} Every call needs the current F#. text is split like edit_lines; empty text is refused. ` +
      `If any line of text still begins with a read_lines anchor prefix (L<n>#<8 hex> ), the call is refused, naming the first offending line: strip the copied prefixes. Pass allow_anchor_prefixes: true ONLY for a file whose real content genuinely begins lines with that shape. ` +
      `Pure insertions are NOT counted by the rewrite tripwire (they destroy no existing content).`,
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      anchor: Type.String({ minLength: 1, description: "A line anchor L<n>#<h>, or L0." }),
      text: Type.String({ minLength: 1 }),
      fingerprint: Type.String({ minLength: 1 }),
      allow_anchor_prefixes: Type.Optional(
        Type.Boolean({
          description:
            "Default false. Set true ONLY for a file whose real content genuinely begins lines with the read_lines anchor shape (L<n>#<8 hex> ); it turns off the anchor-prefix guard for this call.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        session.insertAfter(
          ctxCwd(ctx),
          params.path as string,
          params.anchor as string,
          params.text as string,
          params.fingerprint as string,
          params.allow_anchor_prefixes === true,
        ),
      );
    },
  });

  pi.registerTool({
    name: "write_file",
    label: "Write File",
    description:
      "Create a NEW file, exclusively. Takes no fingerprint. Refuses if any directory entry already exists at the path (including a dangling symlink); this tool never replaces an existing file. " +
      "If any line of content still begins with a read_lines anchor prefix (L<n>#<8 hex> ), the call is refused, naming the first offending line: strip the copied prefixes. Pass allow_anchor_prefixes: true ONLY for a file whose real content genuinely begins lines with that shape.",
    parameters: Type.Object({
      path: Type.String({ minLength: 1 }),
      content: Type.String(),
      allow_anchor_prefixes: Type.Optional(
        Type.Boolean({
          description:
            "Default false. Set true ONLY for a file whose real content genuinely begins lines with the read_lines anchor shape (L<n>#<8 hex> ); it turns off the anchor-prefix guard for this call.",
        }),
      ),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      return run(() =>
        session.writeFile(
          ctxCwd(ctx),
          params.path as string,
          params.content as string,
          params.allow_anchor_prefixes === true,
        ),
      );
    },
  });

  log("anchored-edit capability: registered read_lines / edit_lines / insert_after / write_file");
  return session;
}
