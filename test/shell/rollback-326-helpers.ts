// Shared helpers for the bob#326 rollback tests: a real scratch tree, the real
// hire/adoption transactions, and reads that never stat a path and then read it.

import {
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BindStep,
  DEFAULT_POSITIONS_ROOT,
  hireAgent,
  initAgent,
  type SessionRunner,
} from "../../src/shell/index.js";

export interface Scratch {
  base: string;
  agentsRoot: string;
  hostRoot: string;
}

// Under realpath(tmpdir()): macOS's tmpdir sits under the /var -> /private/var
// link, and write_soul refuses a symlink in any component.
export function newScratch(prefix: string): Scratch {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const agentsRoot = join(base, "agents");
  mkdirSync(agentsRoot, { recursive: true });
  return { base, agentsRoot, hostRoot: join(base, "host") };
}

// A file's identity and text from ONE open descriptor (never a stat of the path
// followed by a read of it).
export function readEntry(path: string): { ino: bigint; text: string } {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return { ino: fstatSync(fd, { bigint: true }).ino, text: readFileSync(fd, "utf8") };
  } finally {
    closeSync(fd);
  }
}

// Every entry under `dir`, relative to it, sorted (readdir only). A symlink is
// listed, never followed.
export function entriesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (at: string, rel: string): void => {
    for (const d of readdirSync(at, { withFileTypes: true })) {
      const childRel = rel === "" ? d.name : `${rel}/${d.name}`;
      out.push(childRel);
      if (d.isDirectory()) walk(join(at, d.name), childRel);
    }
  };
  walk(dir, "");
  return out.sort();
}

// Another writer replaces `path` with a new file of its own (a distinct inode).
export function replaceWithForeignFile(path: string, text: string): void {
  const tmp = `${path}.writer-tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export async function refusalOf(fn: () => Promise<unknown> | unknown): Promise<string> {
  try {
    await fn();
  } catch (e) {
    return String((e as Error)?.message);
  }
  throw new Error("expected a refusal, but the call succeeded");
}

export function injectedFailure(step: string): Error {
  return new Error(`injected failure at ${step}`);
}

// The real hire of the packaged builder position into the scratch tree. `act`
// runs after the step `at` (default: `failAt`); with `failAt`, the hire then
// fails after that step.
export function hire(
  s: Scratch,
  name: string,
  opts: {
    failAt?: BindStep;
    at?: BindStep;
    act?: (agentDir: string) => void;
    interview?: SessionRunner;
  } = {},
) {
  const at = opts.at ?? opts.failAt;
  return hireAgent({
    name,
    positionName: "builder",
    agentsRoot: s.agentsRoot,
    hostRoot: s.hostRoot,
    positionsRoot: DEFAULT_POSITIONS_ROOT,
    skipFlair: true,
    contextWindow: 200_000,
    interview: opts.interview ?? (async () => 0),
    commitHook: (step) => {
      if (step === at) opts.act?.(join(s.agentsRoot, name));
      if (step === opts.failAt) throw injectedFailure(step);
    },
  });
}

// A complete, adoptable EXISTING agent (the coder role with exactly the builder
// position's tool set), as positions-195.test.ts builds it.
export function adoptReadyAgent(s: Scratch, name: string): void {
  initAgent({
    name,
    role: "coder",
    provider: "exe-dev-gateway",
    model: "claude-sonnet-4-6",
    agentsRoot: s.agentsRoot,
    capabilities: [],
    toolAllow: ["read", "bash", "write", "edit", "grep", "find"],
    skipFlair: true,
  });
}
