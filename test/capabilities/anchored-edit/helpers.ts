// Shared harness for the anchored-edit tests. A fake pi that records the tool
// definitions `wireAnchoredEdit` registers, so tests drive the REAL registered
// tools (the same objects pi would call), not the core functions directly.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type PiLike,
  wireAnchoredEdit,
} from "../../../src/capabilities/anchored-edit/capability.js";
import {
  type AnchoredEditSession,
  anchorToken,
  parseFile,
  type WriteChunk,
} from "../../../src/capabilities/anchored-edit/core.js";

export interface RegisteredTool {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    id: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: unknown,
    ctx?: { cwd: string },
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
}

export interface Harness {
  root: string;
  tools: Map<string, RegisteredTool>;
  session: AnchoredEditSession;
  call(
    name: string,
    params: Record<string, unknown>,
    cwd?: string,
  ): Promise<{
    text: string;
    details: Record<string, unknown>;
  }>;
  cleanup(): void;
  // The anchor token for a 1-based line of a file in the scratch root.
  anchor(name: string, line: number): string;
}

export function makeHarness(opts: { writeChunk?: WriteChunk } = {}): Harness {
  const root = mkdtempSync(join(tmpdir(), "bob-anchored-edit-"));
  const tools = new Map<string, RegisteredTool>();
  const pi: PiLike = {
    registerTool(tool) {
      tools.set(tool.name, tool as unknown as RegisteredTool);
    },
  };
  const session = wireAnchoredEdit({ pi, log: () => {}, writeChunk: opts.writeChunk });
  return {
    root,
    tools,
    session,
    async call(name, params, cwd = root) {
      const tool = tools.get(name);
      if (!tool) throw new Error(`tool ${name} was not registered`);
      const res = await tool.execute("test-call", params, undefined, undefined, { cwd });
      return { text: res.content[0].text, details: (res.details ?? {}) as Record<string, unknown> };
    },
    anchor(name, line) {
      const { lines } = parseFile(readFileSync(join(root, name)));
      if (line < 1 || line > lines.length) throw new Error(`no line ${line} in ${name}`);
      return anchorToken(line, lines[line - 1]);
    },
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
