// bob#356 round 3 — RUNBOOK step 3's failure orders, on real temporary
// directories. The block is extracted from the RUNBOOK itself and run with a
// `sudo` stand-in that drops `-o root -g wheel` and the root chown, simulates
// the pip install, and injects the failure each case names. The layout and
// PIPER_INSTALL state are asserted for every order.
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = realpathSync(join(import.meta.dirname, "../../.."));
const RUNBOOK = join(ROOT, "sidecar/reachy-voice/RUNBOOK.md");
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

/** Section 3's first sh block, exactly as the RUNBOOK holds it. */
function step3Block(text: string): string {
  const start = /^## 3\. .*$/m.exec(text);
  if (!start) throw new Error("RUNBOOK has no section 3");
  const rest = text.slice(start.index + start[0].length);
  const end = /^## /m.exec(rest);
  const section = end ? rest.slice(0, end.index) : rest;
  const block = /^```sh\n([\s\S]*?)^```$/m.exec(section);
  if (!block) throw new Error("RUNBOOK section 3 has no sh block");
  return block[1];
}

const BLOCK = step3Block(readFileSync(RUNBOOK, "utf8"));

// A `sudo` stand-in. It drops the ownership flags and the root chown; the pip
// install becomes a directory with one file; and the SHIM_FAIL_* variables
// fail the inspection or one of the renames, instead of moving anything.
const SHIM = `#!/bin/bash
set -u
while [ $# -gt 0 ]; do
  case "$1" in
    -o|-g|-u) shift 2 ;;
    -n|-E|-H|-S|-k) shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
[ $# -gt 0 ] || exit 0
if [ "$1" = chown ]; then exit 0; fi
if [ "$1" = install ]; then
  args=()
  skip=0
  for arg in "$@"; do
    case "$arg" in
      -o|-g) skip=1 ;;
      *) if [ "$skip" = 1 ]; then skip=0; else args+=("$arg"); fi ;;
    esac
  done
  exec "\${args[@]}"
fi
if [ "$1" = /usr/bin/python3 ]; then
  if [ "\${2:-}" = "-I" ] && [ "\${3:-}" = "-m" ] && [ "\${4:-}" = pip ]; then
    shift 4
    target=
    while [ $# -gt 0 ]; do
      case "$1" in
        --target) target=$2; shift 2 ;;
        *) shift ;;
      esac
    done
    if [ "\${SHIM_FAIL_PIP:-0}" = 1 ]; then exit 1; fi
    mkdir -p "$target"
    printf "installed\\n" > "$target/installed.txt"
    exit 0
  fi
  if [ "\${2:-}" = "-I" ] && [ "\${3:-}" = "-c" ]; then
    script=\${4:-}
    case "$script" in
      *os.lstat*)
        if [ "\${SHIM_FAIL_INSPECT:-0}" = 1 ]; then exit 1; fi ;;
      *os.rename*)
        src=\${5:-}
        dst=\${6:-}
        if [ "$(basename "$src")" = lib.new ] && [ "$(basename "$dst")" = lib ] &&
          [ "\${SHIM_FAIL_SWAP:-0}" = 1 ]; then
          if [ "\${SHIM_SWAP_TARGET:-0}" = occupied ]; then mkdir -p "$dst/inside"; fi
          exit 1
        fi
        if [ "$(basename "$src")" = lib.old ] && [ "$(basename "$dst")" = lib ] &&
          [ "\${SHIM_FAIL_RESTORE:-0}" = 1 ]; then
          mkdir -p "$dst/inside"
          exit 1
        fi ;;
    esac
  fi
  exec "$@"
fi
exec "$@"
`;

type Injection = {
  pip?: boolean;
  inspect?: boolean;
  swap?: "fail" | "occupied";
  restore?: boolean;
};

function run(inject: Injection = {}, seed: { libOld?: boolean } = {}) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "rv-step3-")));
  scratch.push(d);
  const piper = join(d, "piper");
  mkdirSync(join(piper, "lib"), { recursive: true, mode: 0o755 });
  writeFileSync(join(piper, "lib/old.txt"), "old\n");
  if (seed.libOld) {
    mkdirSync(join(piper, "lib.old"), { mode: 0o755 });
    writeFileSync(join(piper, "lib.old/old.txt"), "old\n");
  }
  const bin = join(d, "bin");
  mkdirSync(bin, { mode: 0o755 });
  writeFileSync(join(bin, "sudo"), SHIM);
  chmodSync(join(bin, "sudo"), 0o755);
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    PIPER_DIR: piper,
    INSTALL: join(d, "install"),
    REPO: ROOT,
    SHIM_FAIL_PIP: inject.pip ? "1" : "0",
    SHIM_FAIL_INSPECT: inject.inspect ? "1" : "0",
    SHIM_FAIL_SWAP: inject.swap ? "1" : "0",
    SHIM_FAIL_RESTORE: inject.restore ? "1" : "0",
    SHIM_SWAP_TARGET: inject.swap === "occupied" ? "occupied" : "0",
  };
  const r = spawnSync(
    "bash",
    ["-c", `${BLOCK}\nprintf '\\nPIPER_INSTALL=%s\\n' "$PIPER_INSTALL"`],
    { cwd: d, env, encoding: "utf8", timeout: 60_000 },
  );
  expect(r.error).toBeUndefined();
  const state = /^PIPER_INSTALL=(.+)$/m.exec(r.stdout)?.[1];
  return {
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    state,
    lib: existsSync(join(piper, "lib/old.txt")),
    libNew: existsSync(join(piper, "lib.new/installed.txt")),
    libOld: existsSync(join(piper, "lib.old/old.txt")),
    entry: existsSync(join(piper, "piper")),
    nestedInLib: existsSync(join(piper, "lib/lib")),
    nestedInOld: existsSync(join(piper, "lib.old/lib")),
  };
}

describe("bob#356 — RUNBOOK step 3's failure orders", () => {
  it("runs the block the RUNBOOK holds, not a copy", () => {
    expect(BLOCK).toContain("PIPER_INSTALL=failed");
    expect(BLOCK).toContain("swap-dir-present");
    expect(BLOCK).toContain("inspect-failed");
    expect(BLOCK).toContain("restore-failed");
  });

  it("a failed pip install leaves lib and the entry install alone", () => {
    const r = run({ pip: true });
    expect(r.state).toBe("failed");
    expect(r.lib).toBe(true);
    expect(r.libNew).toBe(false);
    expect(r.libOld).toBe(false);
    expect(r.entry).toBe(false);
    expect(r.nestedInLib || r.nestedInOld).toBe(false);
    expect(r.output).toContain("the Piper install did not complete (failed)");
  });

  it("a lib.old left after cleanup refuses to start the swap, before pip", () => {
    const r = run({}, { libOld: true });
    expect(r.state).toBe("swap-dir-present");
    expect(r.lib).toBe(true);
    expect(r.libNew).toBe(false);
    expect(r.libOld).toBe(true);
    expect(r.entry).toBe(false);
    expect(r.nestedInLib || r.nestedInOld).toBe(false);
    expect(r.output).toContain("refusing to start the swap");
  });

  it("a swap rename that fails restores the old lib", () => {
    const r = run({ swap: "fail" });
    expect(r.state).toBe("swap-failed");
    expect(r.lib).toBe(true);
    expect(r.libNew).toBe(true);
    expect(r.libOld).toBe(false);
    expect(r.entry).toBe(false);
    expect(r.nestedInLib || r.nestedInOld).toBe(false);
  });

  it("an occupied lib fails the swap instead of nesting one directory inside another", () => {
    const r = run({ swap: "occupied" });
    expect(r.state).toBe("restore-failed");
    expect(r.lib).toBe(false);
    expect(r.libNew).toBe(true);
    expect(r.libOld).toBe(true);
    expect(r.entry).toBe(false);
    expect(r.nestedInLib || r.nestedInOld).toBe(false);
  });

  it("a failed restore reports the state and what the operator must do", () => {
    const r = run({ swap: "fail", restore: true });
    expect(r.state).toBe("restore-failed");
    expect(r.lib).toBe(false);
    expect(r.libNew).toBe(true);
    expect(r.libOld).toBe(true);
    expect(r.entry).toBe(false);
    expect(r.nestedInLib || r.nestedInOld).toBe(false);
    expect(r.output).toContain("could not be moved back");
    expect(r.output).toContain("move the good one to");
  });

  it("an inspection that fails is not read as an absent lib", () => {
    const r = run({ inspect: true });
    expect(r.state).toBe("inspect-failed");
    expect(r.lib).toBe(true);
    expect(r.libNew).toBe(true);
    expect(r.libOld).toBe(false);
    expect(r.entry).toBe(false);
    expect(r.nestedInLib || r.nestedInOld).toBe(false);
    expect(r.output).toContain("the Piper install did not complete (inspect-failed)");
  });
});
