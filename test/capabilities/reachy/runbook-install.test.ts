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

/** Section 3's first sh block, with the `<voice>` placeholder filled as the
 *  operator fills it: the block must be the RUNBOOK's, not a copy. */
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

const BLOCK = step3Block(readFileSync(RUNBOOK, "utf8")).replaceAll("<voice>", "voice");

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
if [ "$1" = cp ]; then
  if [ "\${SHIM_FAIL_VOICE:-0}" = 1 ]; then exit 1; fi
  exec "$@"
fi
if [ "$1" = install ]; then
  if [ "\${SHIM_FAIL_ENTRY:-0}" = 1 ]; then exit 1; fi
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
    if [ -n "\${SHIM_PIP_ARGS:-}" ]; then printf "%s\\n" "$@" > "$SHIM_PIP_ARGS"; fi
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
        if [ "$(basename "$src")" = lib ] && [ "$(basename "$dst")" = lib.old ] &&
          [ "\${SHIM_FAIL_MOVE:-0}" = 1 ]; then
          exit 1
        fi
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
  move?: boolean;
  swap?: "fail" | "occupied";
  restore?: boolean;
  entry?: boolean;
  voice?: boolean;
};

function run(inject: Injection = {}, seed: { libOld?: boolean } = {}) {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "rv-step3-")));
  scratch.push(d);
  const piper = join(d, "piper");
  mkdirSync(join(piper, "lib"), { recursive: true, mode: 0o755 });
  writeFileSync(join(piper, "lib/old.txt"), "old\n");
  // A previous install's files, so a failure state can be told apart from an
  // install that overwrote them, and the hash command can succeed on its own.
  writeFileSync(join(piper, "piper"), "old entry\n");
  writeFileSync(join(piper, "voice.onnx"), "old voice\n");
  writeFileSync(join(piper, "voice.onnx.json"), "{}\n");
  writeFileSync(join(d, "voice.onnx"), "voice\n");
  writeFileSync(join(d, "voice.onnx.json"), "{}\n");
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
    SHIM_FAIL_MOVE: inject.move ? "1" : "0",
    SHIM_FAIL_SWAP: inject.swap ? "1" : "0",
    SHIM_FAIL_RESTORE: inject.restore ? "1" : "0",
    SHIM_FAIL_ENTRY: inject.entry ? "1" : "0",
    SHIM_FAIL_VOICE: inject.voice ? "1" : "0",
    SHIM_SWAP_TARGET: inject.swap === "occupied" ? "occupied" : "0",
    SHIM_PIP_ARGS: join(d, "pip-args"),
  };
  const r = spawnSync(
    "bash",
    ["-c", `${BLOCK}\nstatus=$?\nprintf '\\nPIPER_INSTALL=%s\\n' "$PIPER_INSTALL"\nexit $status`],
    { cwd: d, env, encoding: "utf8", timeout: 60_000 },
  );
  expect(r.error).toBeUndefined();
  const state = /^PIPER_INSTALL=(.+)$/m.exec(r.stdout)?.[1];
  const read = (p: string) => {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return null;
    }
  };
  return {
    status: r.status,
    output: `${r.stdout ?? ""}${r.stderr ?? ""}`,
    state,
    lib: existsSync(join(piper, "lib/old.txt")),
    installed: existsSync(join(piper, "lib/installed.txt")),
    libNew: existsSync(join(piper, "lib.new/installed.txt")),
    libOld: existsSync(join(piper, "lib.old/old.txt")),
    entry: read(join(piper, "piper")),
    voice: read(join(piper, "voice.onnx")),
    voiceJson: read(join(piper, "voice.onnx.json")),
    nestedInLib: existsSync(join(piper, "lib/lib")),
    nestedInOld: existsSync(join(piper, "lib.old/lib")),
    pipArgs: read(join(d, "pip-args"))?.split("\n") ?? null,
  };
}

describe("bob#356 — RUNBOOK step 3's failure orders", () => {
  it("runs the block the RUNBOOK holds, not a copy", () => {
    expect(BLOCK).toContain("PIPER_INSTALL=failed");
    expect(BLOCK).toContain("swap-dir-present");
    expect(BLOCK).toContain("inspect-failed");
    expect(BLOCK).toContain("restore-failed");
  });

  it("a successful install exits 0 and hashes the installed files", () => {
    const r = run();
    expect(r.state).toBe("ok");
    expect(r.status).toBe(0);
    expect(r.lib).toBe(false);
    expect(r.installed).toBe(true);
    expect(r.libOld).toBe(false);
    expect(r.entry).toBe(readFileSync(join(ROOT, "sidecar/reachy-voice/piper-entry.py"), "utf8"));
    expect(r.output).toMatch(/[0-9a-f]{64} {2}.*\/piper\/piper/);
  });

  it("runs pip with --no-compile", () => {
    expect(run().pipArgs).toContain("--no-compile");
  });

  it("a failed pip install leaves lib and the entry install alone", () => {
    const r = run({ pip: true });
    expect(r.state).toBe("failed");
    expect(r.status).not.toBe(0);
    expect(r.lib).toBe(true);
    expect(r.libNew).toBe(false);
    expect(r.libOld).toBe(false);
    expect(r.entry).toBe("old entry\n");
    expect(r.nestedInLib || r.nestedInOld).toBe(false);
    expect(r.output).toContain("the Piper install did not complete (failed)");
  });

  it("a lib.old left after cleanup refuses to start the swap, before pip", () => {
    const r = run({}, { libOld: true });
    expect(r.state).toBe("swap-dir-present");
    expect(r.status).not.toBe(0);
    expect(r.lib).toBe(true);
    expect(r.libNew).toBe(false);
    expect(r.libOld).toBe(true);
    expect(r.entry).toBe("old entry\n");
    expect(r.nestedInLib || r.nestedInOld).toBe(false);
    expect(r.output).toContain("refusing to start the swap");
  });

  it("a move-aside rename that fails leaves the old lib in place", () => {
    const r = run({ move: true });
    expect(r.state).toBe("move-failed");
    expect(r.status).not.toBe(0);
    expect(r.lib).toBe(true);
    expect(r.libNew).toBe(true);
    expect(r.libOld).toBe(false);
    expect(r.entry).toBe("old entry\n");
    expect(r.nestedInLib || r.nestedInOld).toBe(false);
  });

  it("a failed entry install sets install-failed and skips the rest of the install", () => {
    const r = run({ entry: true });
    expect(r.state).toBe("install-failed");
    expect(r.status).not.toBe(0);
    expect(r.installed).toBe(true);
    expect(r.entry).toBe("old entry\n");
    expect(r.voice).toBe("old voice\n");
    expect(r.voiceJson).toBe("{}\n");
    expect(r.output).toContain("PIPER_INSTALL=install-failed");
  });

  it("a failed voice copy sets voice-failed and fails the block", () => {
    const r = run({ voice: true });
    expect(r.state).toBe("voice-failed");
    expect(r.status).not.toBe(0);
    expect(r.entry).toBe(readFileSync(join(ROOT, "sidecar/reachy-voice/piper-entry.py"), "utf8"));
    expect(r.voice).toBe("old voice\n");
    expect(r.voiceJson).toBe("{}\n");
    expect(r.output).toContain("PIPER_INSTALL=voice-failed");
  });

  it("a swap rename that fails restores the old lib", () => {
    const r = run({ swap: "fail" });
    expect(r.state).toBe("swap-failed");
    expect(r.status).not.toBe(0);
    expect(r.lib).toBe(true);
    expect(r.libNew).toBe(true);
    expect(r.libOld).toBe(false);
    expect(r.entry).toBe("old entry\n");
    expect(r.nestedInLib || r.nestedInOld).toBe(false);
  });

  it("an occupied lib fails the swap instead of nesting one directory inside another", () => {
    const r = run({ swap: "occupied" });
    expect(r.state).toBe("restore-failed");
    expect(r.status).not.toBe(0);
    expect(r.lib).toBe(false);
    expect(r.libNew).toBe(true);
    expect(r.libOld).toBe(true);
    expect(r.entry).toBe("old entry\n");
    expect(r.nestedInLib || r.nestedInOld).toBe(false);
  });

  it("a failed restore reports the state and what the operator must do", () => {
    const r = run({ swap: "fail", restore: true });
    expect(r.state).toBe("restore-failed");
    expect(r.status).not.toBe(0);
    expect(r.lib).toBe(false);
    expect(r.libNew).toBe(true);
    expect(r.libOld).toBe(true);
    expect(r.entry).toBe("old entry\n");
    expect(r.nestedInLib || r.nestedInOld).toBe(false);
    expect(r.output).toContain("could not be moved back");
    expect(r.output).toContain("move the good one to");
  });

  it("an inspection that fails is not read as an absent lib", () => {
    const r = run({ inspect: true });
    expect(r.state).toBe("inspect-failed");
    expect(r.status).not.toBe(0);
    expect(r.lib).toBe(true);
    expect(r.libNew).toBe(true);
    expect(r.libOld).toBe(false);
    expect(r.entry).toBe("old entry\n");
    expect(r.nestedInLib || r.nestedInOld).toBe(false);
    expect(r.output).toContain("the Piper install did not complete (inspect-failed)");
  });
});
