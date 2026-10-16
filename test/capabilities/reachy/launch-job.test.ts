import { afterAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLaunchJob } from "../../../scripts/check-reachy-isolation.mjs";

const DARWIN = process.platform === "darwin";
const scratch = mkdtempSync(join(tmpdir(), "rv-launch-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const tool = realpathSync(join(import.meta.dirname, "../../../sidecar/reachy-voice/launch.py"));
const env = { DEVELOPER_DIR: "/Library/Developer/CommandLineTools" };
const fixture = `
import importlib.util,json,os,plistlib,sys
spec = importlib.util.spec_from_file_location("launch", sys.argv[1])
launch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launch)
launch.INSTALL = sys.argv[2] + "/install"
launch.PIPER_DIR = sys.argv[2] + "/piper"
launch.STATE = sys.argv[2] + "/state"
os.makedirs(launch.PIPER_DIR, exist_ok=True)
with open(launch.PIPER_DIR + "/voice.onnx", "wb") as model:
    model.write(b"fixture model")
job = launch.launch_spec()
print(json.dumps(job), flush=True)
mutation = json.loads(sys.argv[3])
args = job["ProgramArguments"]
if mutation == "interpreter":
    args[args.index("-I") - 1] = "/usr/bin/true"
elif mutation == "isolation":
    args.remove("-I")
elif mutation == "program":
    job["Program"] = "/usr/bin/true"
elif mutation == "environment":
    job["EnvironmentVariables"] = {"PYTHONHOME": sys.argv[2]}
elif mutation == "alias":
    alias = sys.argv[2] + "/python-alias"
    if os.path.lexists(alias): os.unlink(alias)
    os.symlink(args[args.index("-I") - 1], alias)
    args[args.index("-I") - 1] = alias
elif isinstance(mutation, int):
    args[mutation] = "/different"
path = sys.argv[2] + "/job.plist"
with open(path, "wb") as output:
    plistlib.dump(job, output, fmt=plistlib.FMT_BINARY)
launch.check_job(path)
`;
function check(mutation: string | number | null, poison = false) {
  return spawnSync(
    "/usr/bin/python3",
    ["-I", "-c", fixture, tool, scratch, JSON.stringify(mutation)],
    {
      encoding: "utf8",
      env: poison
        ? {
            ...env,
            PYTHON_REAL: "/usr/bin/true",
            PYTHON_PREFIX: scratch,
            INSTALL: scratch,
            STATE: scratch,
            PYTHONPATH: scratch,
            PYTHONHOME: scratch,
          }
        : env,
    },
  );
}

describe("P7 fixture plist comparison through checkLaunchJob", () => {
  const launchPath = join(scratch, "fixture-launch.py");
  const plist = join(scratch, "fixture.plist");
  const expected = { ProgramArguments: ["/fixture/python3", "-I", "/fixture/sidecar.py"] };
  writeFileSync(
    launchPath,
    `${readFileSync(tool, "utf8")}\ndef launch_spec():\n    return ${JSON.stringify(expected)}\n`,
  );

  it("accepts a matching plist and refuses a changed fixture interpreter", () => {
    for (const interpreter of ["/fixture/python3", "/different/python3"]) {
      const result = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          'import json,plistlib,sys; job=json.loads(sys.argv[2]); plistlib.dump(job,open(sys.argv[1],"wb"),fmt=plistlib.FMT_BINARY)',
          plist,
          JSON.stringify({
            ...expected,
            ProgramArguments: [interpreter, "-I", "/fixture/sidecar.py"],
          }),
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      const check = () => checkLaunchJob({ python: "/usr/bin/python3", launchPath, plist });
      if (interpreter === "/fixture/python3") {
        expect(check()).toEqual({ interpreter });
      } else {
        expect(check).toThrow("deployed LaunchDaemon differs");
      }
    }
  });
});

describe.skipIf(!DARWIN)("macOS fixture plist comparison", () => {
  it("accepts the derived plist despite shell path overrides", () => {
    const result = check(null, true);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).ProgramArguments).toContain("-I");
  });

  it("compares the fixture plist interpreter when proof.py reports the expected interpreter", () => {
    const proof = join(import.meta.dirname, "../../../sidecar/reachy-voice/proof.py");
    const report = spawnSync("/usr/bin/python3", ["-I", proof, "interp"], {
      encoding: "utf8",
      env,
    });
    expect(report.status, report.stderr).toBe(0);
    const result = check("interpreter");
    const expected = JSON.parse(result.stdout).ProgramArguments as string[];
    expect(expected[expected.indexOf("-I") - 1]).toBe(JSON.parse(report.stdout).real);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("deployed LaunchDaemon differs");
  });

  it("resolves interpreter aliases before comparison", () => {
    const result = check("alias");
    expect(result.status, result.stderr).toBe(0);
  });

  it.each(["isolation", "program", "environment"])("refuses a changed %s", (mutation) => {
    const result = check(mutation);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("deployed LaunchDaemon differs");
  });

  it("refuses each changed profile parameter and sidecar path argument", () => {
    const result = check(null);
    expect(result.status, result.stderr).toBe(0);
    const args = JSON.parse(result.stdout).ProgramArguments as string[];
    const positions = args.flatMap((value, index) =>
      value.startsWith("/") || /^[A-Z_]+=/.test(value) ? [index] : [],
    );
    for (const index of positions) {
      const changed = check(index);
      expect(changed.status, `${index}: ${changed.stderr}`).toBe(1);
      expect(changed.stderr).toContain("deployed LaunchDaemon differs");
    }
  });
});
