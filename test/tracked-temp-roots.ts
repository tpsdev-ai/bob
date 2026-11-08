import { afterAll, afterEach } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots = new Set<string>();

function diagnostic(message: string): void {
  try {
    writeSync(2, message);
  } catch {}
}

function remove(root: string): void {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch (error) {
    diagnostic(`test root cleanup failed: ${root}: ${error}\n`);
  }
}

function cleanup(): void {
  for (const root of roots) remove(root);
}

let owners = 0;
function terminate(): void {
  cleanup();
  process.exit(143);
}
function interrupt(): void {
  cleanup();
  process.exit(130);
}
function register(): void {
  if (owners++ > 0) return;
  process.once("exit", cleanup);
  process.once("SIGTERM", terminate);
  process.once("SIGINT", interrupt);
}
function unregister(): void {
  if (--owners > 0) return;
  process.off("exit", cleanup);
  process.off("SIGTERM", terminate);
  process.off("SIGINT", interrupt);
}

function size(path: string): number {
  const stat = lstatSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((bytes, name) => bytes + size(join(path, name)), 0);
}

function report(root: string): void {
  if (!existsSync(root)) return;
  diagnostic(`leftover test root: ${root}\n`);
  try {
    const entries = readdirSync(root)
      .map((name) => ({ name, bytes: size(join(root, name)) }))
      .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
      .slice(0, 5);
    for (const { name, bytes } of entries) {
      diagnostic(`  ${bytes} bytes\t${join(root, name)}\n`);
    }
  } catch (error) {
    diagnostic(`  inventory failed: ${error}\n`);
  }
}

export function trackedTempRoots(): (prefix: string) => string {
  const created = new Set<string>();
  const active = new Set<string>();
  let registered = false;
  afterEach(() => {
    for (const root of active) remove(root);
    active.clear();
  });
  afterAll(() => {
    for (const root of created) {
      report(root);
      remove(root);
    }
    if (registered) unregister();
  });
  return (prefix) => {
    if (!registered) {
      register();
      registered = true;
    }
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.add(root);
    created.add(root);
    active.add(root);
    return root;
  };
}
