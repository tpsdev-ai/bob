// bob#356 round 3 — RUNBOOK step 3's failure orders, on real temporary
// directories. The block is extracted from the RUNBOOK itself and run with a
// `sudo` stand-in that drops `-o root -g wheel` and the root chown, simulates
// the pip install, and injects the failure each case names. The layout and
// PIPER_INSTALL state are asserted for every order.
import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { join, sep } from "node:path";
import { piperInstallProblems } from "../../../scripts/check-reachy-isolation.mjs";

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
    if [ -n "\${SHIM_REAL_PYTHON:-}" ]; then
      # Real pip with the block's own arguments, except -r, which names the
      # fixture requirements; the bytecode cache is forced outside the target.
      args=()
      while [ $# -gt 0 ]; do
        case "$1" in
          -r) args+=(-r "$SHIM_PIP_REQUIREMENTS"); shift 2 ;;
          *) args+=("$1"); shift ;;
        esac
      done
      exec "$SHIM_REAL_PYTHON" -I -X "pycache_prefix=$SHIM_PYCACHE_PREFIX" -m pip "\${args[@]}"
    fi
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

function run(
  inject: Injection = {},
  seed: { libOld?: boolean } = {},
  opts: { block?: string; env?: Record<string, string> } = {},
) {
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
    ...opts.env,
  };
  const r = spawnSync(
    "bash",
    [
      "-c",
      `${opts.block ?? BLOCK}\nstatus=$?\nprintf '\\nPIPER_INSTALL=%s\\n' "$PIPER_INSTALL"\nexit $status`,
    ],
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
    piper,
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

// RUNBOOK step 3's block with REAL pip: the `sudo` stand-in hands the pip call
// to a python3 that has pip, with the block's own flags. Only `-r` is
// redirected, to a requirements file pinning a wheel built here (one Python
// module), and `-X pycache_prefix` puts any compiled bytecode in a cache
// outside the target (`-I` ignores PYTHON* variables, `-X` still applies).
// pip reads no index, config file or cache. The block's own renames leave the
// install in `$PIPER_DIR/lib`, and piperInstallProblems verifies it.
function pythonWithPip(): string | undefined {
  const probe = join(tmpdir(), "rv-pip-probe-prefix");
  for (const py of ["/usr/bin/python3", "python3"]) {
    const r = spawnSync(
      py,
      [
        "-I",
        "-B",
        "-X",
        `pycache_prefix=${probe}`,
        "-c",
        `import sys, pip; assert sys.pycache_prefix == ${JSON.stringify(probe)}`,
      ],
      { encoding: "utf8", timeout: 30_000 },
    );
    if (r.status === 0) return py;
  }
  return undefined;
}

const PY = pythonWithPip();
const NO_PY =
  " (skipped: neither /usr/bin/python3 nor python3 on PATH imports pip and honours -X pycache_prefix)";
const ME = process.getuid?.() ?? -1;

// A wheel holding one module, its METADATA, WHEEL and a hashed RECORD.
const WHEEL_PY = `
import base64, hashlib, sys, zipfile
info = "fixture_pkg-1.0.dist-info"
files = {
    "fixture_pkg/__init__.py": b"VALUE = 1\\n",
    info + "/METADATA": b"Metadata-Version: 2.1\\nName: fixture-pkg\\nVersion: 1.0\\n",
    info + "/WHEEL": b"Wheel-Version: 1.0\\nGenerator: bob-test\\nRoot-Is-Purelib: true\\nTag: py3-none-any\\n",
}
def digest(b):
    return "sha256=" + base64.urlsafe_b64encode(hashlib.sha256(b).digest()).rstrip(b"=").decode()
record = "".join("%s,%s,%d\\n" % (p, digest(b), len(b)) for p, b in files.items())
record += info + "/RECORD,,\\n"
with zipfile.ZipFile(sys.argv[1], "w") as z:
    for p, b in files.items():
        z.writestr(p, b)
    z.writestr(info + "/RECORD", record)
`;

function realPip() {
  const f = realpathSync(mkdtempSync(join(tmpdir(), "rv-pip-")));
  scratch.push(f);
  for (const sub of ["wheels", "pycache", "tmp", "home"]) mkdirSync(join(f, sub));
  const wheel = join(f, "wheels/fixture_pkg-1.0-py3-none-any.whl");
  const built = spawnSync(PY as string, ["-I", "-B", "-c", WHEEL_PY, wheel], {
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(built.status).toBe(0);
  const sha = createHash("sha256").update(readFileSync(wheel)).digest("hex");
  const requirements = join(f, "requirements.txt");
  writeFileSync(
    requirements,
    `--no-index\n--find-links ${join(f, "wheels")}\nfixture-pkg==1.0 \\\n    --hash=sha256:${sha}\n`,
  );
  const env = {
    SHIM_REAL_PYTHON: PY as string,
    SHIM_PIP_REQUIREMENTS: requirements,
    SHIM_PYCACHE_PREFIX: join(f, "pycache"),
    PIP_NO_INDEX: "1",
    PIP_CONFIG_FILE: "/dev/null",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_CACHE_DIR: "1",
    TMPDIR: join(f, "tmp"),
    HOME: join(f, "home"),
  };
  return { requirements, env };
}

describe("bob#356 — RUNBOOK step 3 with real pip, verified by piperInstallProblems", () => {
  it.skipIf(!PY)(
    `the block's install passes the verifier${PY ? "" : NO_PY}`,
    () => {
      const { requirements, env } = realPip();
      const r = run({}, {}, { env });
      expect(r.state).toBe("ok");
      expect(r.status).toBe(0);
      expect(piperInstallProblems({ piperDir: r.piper, requirements, owners: [ME] })).toEqual([]);
    },
    120_000,
  );

  it.skipIf(!PY)(
    `without --no-compile the external bytecode is refused as a hashless RECORD line outside lib${PY ? "" : NO_PY}`,
    () => {
      const { requirements, env } = realPip();
      const block = BLOCK.replace(/[ \t]--no-compile\b/g, "");
      expect(block).not.toContain("--no-compile");
      const r = run({}, {}, { block, env });
      expect(r.state).toBe("ok");
      expect(r.status).toBe(0);
      const lib = join(r.piper, "lib");
      const problems = piperInstallProblems({ piperDir: r.piper, requirements, owners: [ME] });
      expect(problems).toHaveLength(1);
      const m = /^(.+) is listed in (.+) without a hash$/.exec(problems[0] ?? "");
      expect(m?.[1]).toEndWith(".pyc");
      expect(m?.[1].startsWith(lib + sep)).toBe(false);
      expect(m?.[2]).toBe(join(lib, "fixture_pkg-1.0.dist-info/RECORD"));
    },
    120_000,
  );

  it.skipIf(!PY)(
    `an installed source file changed after the install is refused by its RECORD hash${PY ? "" : NO_PY}`,
    () => {
      const { requirements, env } = realPip();
      const r = run({}, {}, { env });
      expect(r.state).toBe("ok");
      const source = join(r.piper, "lib/fixture_pkg/__init__.py");
      writeFileSync(source, readFileSync(source, "utf8").replace("VALUE = 1", "VALUE = 2"));
      expect(piperInstallProblems({ piperDir: r.piper, requirements, owners: [ME] })).toEqual([
        `${source} does not match the hash in ${join(r.piper, "lib/fixture_pkg-1.0.dist-info/RECORD")}`,
      ]);
    },
    120_000,
  );
});
