// bob#356 round 3 — [P7]'s trust rules, on fixture trees. On the release host
// P7 checks the pinned /usr/bin/python3, what it resolves to (as reported
// through sudo), the installed proof and sidecar files, the Piper directory and
// the deployment record along their FULL path chains: every component
// root-owned, not group- or other-writable, with no write-granting ACL entry.
// Here a fixture tree stands in (its owner plays root via the `owners` seam,
// and the walk starts at the fixture via `from`), and each rule is shown to
// refuse what it must.
import { afterAll, describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  ACL_UNCHECKED,
  pinnedPiperVersion,
  piperInstallProblems,
  readDeploymentRecord,
  releaseTrustProblems,
  writeGrantingAcls,
} from "../../../scripts/check-reachy-isolation.mjs";

const DARWIN = process.platform === "darwin";
const ME = process.getuid?.() ?? -1;
const INSTALLED = ["sidecar.py", "reachy-voice.sb", "proof.py", "egress-probe.py"];
const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) {
    if (DARWIN) {
      try {
        execFileSync("/bin/chmod", ["-R", "-N", d], { stdio: "ignore" });
      } catch {}
    }
    rmSync(d, { recursive: true, force: true });
  }
});

/** A clean release-host stand-in: every directory 0755, every file 0644/0755. */
function fixture() {
  const f = realpathSync(mkdtempSync(join(tmpdir(), "rv-trust-")));
  scratch.push(f);
  chmodSync(f, 0o755);
  const file = (p: string, mode = 0o644, body = "x") => {
    mkdirSync(dirname(p), { recursive: true, mode: 0o755 });
    writeFileSync(p, body);
    chmodSync(p, mode);
  };
  file(join(f, "usr/bin/python3"), 0o755);
  file(join(f, "base/bin/python3.9"), 0o755);
  file(join(f, "base/lib/python3.9/os.py"));
  file(join(f, "base/Resources/Python"), 0o755); // in the base tree, on no sys.path entry
  mkdirSync(join(f, "base/lib/python3.9/site-packages"), { mode: 0o755 });
  mkdirSync(join(f, "clt/usr/bin"), { recursive: true, mode: 0o755 });
  symlinkSync("../../../base/bin/python3.9", join(f, "clt/usr/bin/python3"));
  for (const n of INSTALLED) file(join(f, "install", n));
  file(join(f, "piper/piper"), 0o755);
  file(join(f, "source/piper-entry.py"));
  file(
    join(f, "piper/lib/piper_tts-1.8.0.dist-info/METADATA"),
    0o644,
    "Metadata-Version: 2.1\nName: piper-tts\nVersion: 1.8.0\n",
  );
  file(join(f, "state/agent-user"), 0o644, "bob\n");
  // mkdir's mode is masked by umask: set every directory explicitly
  for (const d of [
    "usr",
    "usr/bin",
    "base",
    "base/bin",
    "base/lib",
    "base/lib/python3.9",
    "base/lib/python3.9/site-packages",
    "base/Resources",
    "clt",
    "clt/usr",
    "clt/usr/bin",
    "install",
    "piper",
    "piper/lib",
    "piper/lib/piper_tts-1.8.0.dist-info",
    "source",
    "state",
  ]) {
    chmodSync(join(f, d), 0o755);
  }
  const interp = {
    executable: join(f, "clt/usr/bin/python3"),
    real: join(f, "base/bin/python3.9"),
    base: join(f, "base"),
    prefix: join(f, "base"),
    isolated: 1,
    path: [
      join(f, "base/lib/python39.zip"), // missing, inside the base tree
      join(f, "base/lib/python3.9"),
      join(f, "base/lib/python3.9/site-packages"),
    ],
  };
  const args = {
    interp,
    installDir: join(f, "install"),
    installedFiles: INSTALLED,
    piperDir: join(f, "piper"),
    record: join(f, "state/agent-user"),
    pinnedPython: join(f, "usr/bin/python3"),
    xcodeSelectLink: null,
    developerDir: null,
    owners: [0, ME],
    from: f,
  };
  return { f, interp, args };
}

/** The findings, without the fail-closed line non-macOS hosts always add. */
const real = (problems: string[]) => problems.filter((p) => p !== ACL_UNCHECKED);
const addAcl = (path: string, entry: string) =>
  execFileSync("/bin/chmod", ["+a", entry, path], { stdio: "ignore" });
const myName = () => execFileSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).trim();

describe("bob#356 [P7] — the release host's trusted paths, on fixture trees", () => {
  it("the real proof command reports an isolated interpreter despite PYTHONPATH", () => {
    const { f } = fixture();
    const tool = join(import.meta.dirname, "../../../sidecar/reachy-voice/proof.py");
    const r = spawnSync(DARWIN ? "/usr/bin/python3" : "python3", ["-I", tool, "interp"], {
      encoding: "utf8",
      env: { ...process.env, PYTHONPATH: f, PYTHONHOME: f },
    });
    expect(r.status, r.stderr).toBe(0);
    const interp = JSON.parse(r.stdout);
    expect(interp.isolated).toBe(1);
    expect(interp.path).not.toContain(f);
    expect(interp.path).not.toContain(dirname(tool));
    expect(realpathSync(interp.executable)).toBe(interp.real);
  });

  it("a clean tree is trusted (and off macOS the ACL check fails closed)", () => {
    const { args } = fixture();
    const problems = releaseTrustProblems(args);
    expect(real(problems)).toEqual([]);
    if (!DARWIN) expect(problems).toContain(ACL_UNCHECKED);
  });

  it("an interpreter with an untrusted owner is refused", () => {
    const { f, args } = fixture();
    const problems = releaseTrustProblems({ ...args, owners: [ME + 1] });
    expect(problems).toContain(`${f}/base/bin/python3.9 is not root-owned (uid ${ME})`);
    expect(problems).toContain(`${f}/usr/bin/python3 is not root-owned (uid ${ME})`);
    // and every entry of the base tree, not only the chains
    expect(problems).toContain(`${f}/base/Resources/Python is not root-owned (uid ${ME})`);
  });

  it("a GROUP-WRITABLE parent anywhere is refused: the stdlib tree, the install directory, Piper, the record", () => {
    const { f, args } = fixture();
    chmodSync(join(f, "base/lib"), 0o775);
    chmodSync(join(f, "install"), 0o775);
    chmodSync(join(f, "piper/piper"), 0o775);
    chmodSync(join(f, "state"), 0o775);
    chmodSync(join(f, "install/proof.py"), 0o664); // the installed proof command itself
    const problems = releaseTrustProblems(args);
    expect(problems).toContain(`${f}/base/lib is writable by group or other`);
    expect(problems).toContain(`${f}/install is writable by group or other`);
    expect(problems).toContain(`${f}/piper/piper is writable by group or other`);
    expect(problems).toContain(`${f}/state is writable by group or other`);
    expect(problems).toContain(`${f}/install/proof.py is writable by group or other`);
  });

  it("a writable ancestor above otherwise protected install files is refused", () => {
    const { f, args } = fixture();
    chmodSync(f, 0o777);
    expect(releaseTrustProblems(args)).toContain(`${f} is writable by group or other`);
  });

  it("a deep FILE in the base tree that is other-writable is refused (the whole tree is walked)", () => {
    const { f, args } = fixture();
    chmodSync(join(f, "base/lib/python3.9/os.py"), 0o646);
    chmodSync(join(f, "base/Resources/Python"), 0o757);
    const problems = releaseTrustProblems(args);
    expect(problems).toContain(`${f}/base/lib/python3.9/os.py is writable by group or other`);
    expect(problems).toContain(`${f}/base/Resources/Python is writable by group or other`);
  });

  it("a WRITE ACL on a parent, or deep in the stdlib tree, is refused", () => {
    const { f, args } = fixture();
    if (!DARWIN) {
      expect(releaseTrustProblems(args)).toContain(ACL_UNCHECKED);
      return;
    }
    addAcl(join(f, "install"), `user:${myName()} allow add_file,delete_child`);
    addAcl(join(f, "base/lib/python3.9/os.py"), "group:everyone allow write");
    writeFileSync(join(f, "external.py"), "x");
    chmodSync(join(f, "external.py"), 0o644);
    symlinkSync(join(f, "external.py"), join(f, "base/external.py"));
    addAcl(join(f, "external.py"), "group:everyone allow append");
    addAcl(join(f, "piper"), "group:everyone deny delete"); // a DENY entry is fine
    const problems = releaseTrustProblems(args);
    expect(
      problems.some(
        (p) =>
          p.startsWith(`${f}/install: a write-granting ACL entry (`) &&
          p.endsWith(" allow add_file,delete_child)"),
      ),
    ).toBe(true);
    expect(problems.some((p) => p.endsWith(" allow write)"))).toBe(true);
    expect(
      problems.some((p) => p.startsWith(`${f}/external.py:`) && p.endsWith(" allow append)")),
    ).toBe(true);
    expect(problems.some((p) => p.includes("deny"))).toBe(false);
  });

  it("a symlinked interpreter is checked at its TARGET: a target in a writable directory is refused", () => {
    const { f, args } = fixture();
    mkdirSync(join(f, "drop"), { mode: 0o755 });
    chmodSync(join(f, "drop"), 0o777);
    writeFileSync(join(f, "drop/python3"), "x");
    chmodSync(join(f, "drop/python3"), 0o755);
    rmSync(join(f, "clt/usr/bin/python3"));
    symlinkSync(join(f, "drop/python3"), join(f, "clt/usr/bin/python3"));
    expect(releaseTrustProblems(args)).toContain(`${f}/drop is writable by group or other`);
  });

  it("a symlink INSIDE the base tree is checked at its target outside it", () => {
    const { f, args } = fixture();
    mkdirSync(join(f, "drop"), { mode: 0o755 });
    chmodSync(join(f, "drop"), 0o777);
    writeFileSync(join(f, "drop/evil.py"), "x");
    chmodSync(join(f, "drop/evil.py"), 0o644);
    symlinkSync(join(f, "drop/evil.py"), join(f, "base/lib/python3.9/evil.py"));
    expect(releaseTrustProblems(args)).toContain(`${f}/drop is writable by group or other`);
  });

  it("intermediate symlink targets retain their writable ancestors", () => {
    const { f, args } = fixture();
    mkdirSync(join(f, "drop"), { mode: 0o777 });
    chmodSync(join(f, "drop"), 0o777);
    symlinkSync(join(f, "base/bin/python3.9"), join(f, "drop/bridge"));
    rmSync(join(f, "clt/usr/bin/python3"));
    symlinkSync(join(f, "drop/bridge"), join(f, "clt/usr/bin/python3"));
    expect(releaseTrustProblems(args)).toContain(`${f}/drop is writable by group or other`);
  });

  it("external directory symlink cycles terminate and check both trees", () => {
    const { f, args } = fixture();
    mkdirSync(join(f, "external"), { mode: 0o755 });
    chmodSync(join(f, "external"), 0o755);
    symlinkSync(join(f, "external"), join(f, "base/external"));
    symlinkSync(join(f, "base"), join(f, "external/back"));
    writeFileSync(join(f, "external/evil.py"), "x");
    chmodSync(join(f, "external/evil.py"), 0o666);
    expect(releaseTrustProblems(args)).toContain(
      `${f}/external/evil.py is writable by group or other`,
    );
  });

  it("the selected interpreter chain and execution prefix are checked independently of base", () => {
    const { f, args, interp } = fixture();
    chmodSync(join(f, "clt/usr/bin"), 0o775);
    chmodSync(join(f, "piper/piper"), 0o777);
    const problems = releaseTrustProblems({
      ...args,
      developerDir: join(f, "clt"),
      piperDir: null,
      interp: { ...interp, prefix: join(f, "piper") },
    });
    expect(problems).toContain(`${f}/clt/usr/bin is writable by group or other`);
    expect(problems).toContain(`${f}/piper/piper is writable by group or other`);
  });

  it("an interpreter report naming another executable is refused", () => {
    const { f, args, interp } = fixture();
    expect(
      releaseTrustProblems({
        ...args,
        developerDir: join(f, "clt"),
        interp: { ...interp, real: join(f, "usr/bin/python3") },
      }),
    ).toContain("the proof interpreter differs from the selected Command Line Tools interpreter");
  });

  it("an interpreter directory and a base-prefix regular file are refused", () => {
    const { f, args, interp } = fixture();
    const problems = releaseTrustProblems({
      ...args,
      pinnedPython: join(f, "usr/bin"),
      interp: { ...interp, real: join(f, "base/bin"), base: join(f, "base/Resources/Python") },
    });
    expect(problems).toContain(`${f}/usr/bin is not a regular file`);
    expect(problems).toContain(`${f}/base/bin is not a regular file`);
    expect(problems).toContain(`${f}/base/Resources/Python is not a directory`);
  });

  it("a MISSING sys.path entry outside the base tree is checked at its nearest ancestor", () => {
    const { f, args, interp } = fixture();
    mkdirSync(join(f, "scratch"), { mode: 0o755 });
    chmodSync(join(f, "scratch"), 0o777); // anyone could create the entry later
    const problems = releaseTrustProblems({
      ...args,
      interp: { ...interp, path: [...interp.path, join(f, "scratch/later/lib")] },
    });
    expect(problems).toContain(`${f}/scratch is writable by group or other`);
  });

  it("an interpreter that did not run isolated (-I) is refused", () => {
    const { args, interp } = fixture();
    expect(releaseTrustProblems({ ...args, interp: { ...interp, isolated: 0 } })).toContain(
      "the proof interpreter did not run isolated (-I)",
    );
  });

  it("an installed proof file that is not a regular file is refused", () => {
    const { f, args } = fixture();
    rmSync(join(f, "install/proof.py"));
    mkdirSync(join(f, "install/proof.py"), { mode: 0o755 });
    chmodSync(join(f, "install/proof.py"), 0o755);
    expect(releaseTrustProblems(args)).toContain(`${f}/install/proof.py is not a regular file`);
  });

  it("the deployment record applies the same chain rule: a write ACL or a group-writable parent is untrusted", () => {
    const { f } = fixture();
    const record = join(f, "state/agent-user");
    const seams = { owners: [0, ME], from: f };
    if (DARWIN) expect(readDeploymentRecord(record, seams)).toEqual({ user: "bob" });
    chmodSync(join(f, "state"), 0o775);
    expect(readDeploymentRecord(record, seams).reason).toContain(
      `${f}/state is writable by group or other, so the deployment record is untrusted`,
    );
    chmodSync(join(f, "state"), 0o755);
    if (DARWIN) {
      addAcl(join(f, "state"), `user:${myName()} allow add_file`);
      expect(readDeploymentRecord(record, seams).reason).toContain("a write-granting ACL entry");
    }
  });

  it("a deployment-record FIFO with no writer is promptly refused as not a regular file", () => {
    const f = mkdtempSync(join(tmpdir(), "rv-record-fifo-"));
    scratch.push(f);
    const record = join(f, "agent-user");
    execFileSync("mkfifo", [record], { timeout: 2_000 });
    const reader = new URL("../../../scripts/check-reachy-isolation.mjs", import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `import { readDeploymentRecord } from ${JSON.stringify(reader)};
console.log(JSON.stringify(readDeploymentRecord(process.argv[1])));`,
        record,
      ],
      { encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL" },
    );
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      reason: `the deployment record ${record} is not a regular file`,
    });
  });

  it.skipIf(!DARWIN).each(["file", "symlink", "directory"])(
    "the deployment record refuses a replacement %s between open and the final path check",
    (kind) => {
      const { f } = fixture();
      const record = join(f, "state/agent-user");
      const replacement = join(f, "state/replacement");
      const seams = { owners: [0, ME], from: f };
      expect(readDeploymentRecord(record, seams)).toEqual({ user: "bob" });
      writeFileSync(join(f, "state/other-user"), "other\n", { mode: 0o644 });
      if (kind === "file") {
        writeFileSync(replacement, "other\n", { mode: 0o644 });
      } else if (kind === "symlink") {
        symlinkSync("other-user", replacement);
      } else {
        mkdirSync(replacement, { mode: 0o755 });
      }
      seams.owners[Symbol.iterator] = function* () {
        renameSync(record, join(f, "state/original"));
        renameSync(replacement, record);
        yield 0;
        yield ME;
        return undefined;
      };
      const result = readDeploymentRecord(record, seams);
      expect(result).toEqual({
        reason:
          kind === "symlink"
            ? `${record} (on the deployment record's path) is a symlink`
            : `the deployment record ${record} ${
                kind === "file" ? "changed while checked" : "is not a regular file"
              }`,
      });
    },
  );

  it("writeGrantingAcls reads only ALLOW entries that grant a write permission", () => {
    const ls = [
      "drwxr-xr-x+ 3 root  wheel  96 Oct 13 19:51 /x",
      " 0: group:everyone deny delete",
      " 1: user:bob allow read,execute",
      " 2: user:bob allow add_file,file_inherit",
      " 3: group:staff inherited allow write",
      " 4: user:eve allow writesecurity",
      " 5: user:Full Name allow write",
      " 6: unrecognized",
    ].join("\n");
    expect(writeGrantingAcls(ls)).toEqual([
      "user:bob allow add_file",
      "group:staff allow write",
      "user:eve allow writesecurity",
      "user:Full Name allow write",
      "unrecognized ACL entry",
    ]);
  });
});

describe("bob#356 [P7] — the installed Piper entry and its pinned version", () => {
  const args = (f: string) => ({
    piperDir: join(f, "piper"),
    entrySource: join(f, "source/piper-entry.py"),
    owners: [0, ME],
  });

  it("the reviewed entry script and the pinned distribution pass", () => {
    const { f } = fixture();
    expect(piperInstallProblems(args(f))).toEqual([]);
    expect(pinnedPiperVersion()).toBe("1.8.0");
  });

  it("an entry that differs from the reviewed script is refused", () => {
    const { f } = fixture();
    writeFileSync(join(f, "piper/piper"), "other");
    expect(piperInstallProblems(args(f))).toContain(
      `${f}/piper/piper is not byte-identical to ${f}/source/piper-entry.py`,
    );
  });

  it("an entry that is not root-owned is refused", () => {
    const { f } = fixture();
    expect(piperInstallProblems({ ...args(f), owners: [ME + 1] })).toContain(
      `${f}/piper/piper is not root-owned (uid ${ME})`,
    );
  });

  it("a distribution that is not the pinned version is refused", () => {
    const { f } = fixture();
    writeFileSync(
      join(f, "piper/lib/piper_tts-1.8.0.dist-info/METADATA"),
      "Name: piper-tts\nVersion: 1.7.0\n",
    );
    expect(piperInstallProblems(args(f)).join("\n")).toContain(
      "the installed piper-tts 1.7.0 is not the pinned 1.8.0",
    );
  });

  it("a missing lib tree is refused", () => {
    const { f } = fixture();
    rmSync(join(f, "piper/lib"), { recursive: true, force: true });
    expect(piperInstallProblems(args(f)).join("\n")).toContain(`${f}/piper/lib cannot be listed`);
  });
});
