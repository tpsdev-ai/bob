import { beforeEach, expect, it } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trackedTempRoots } from "./tracked-temp-roots.js";

const createRoot = trackedTempRoots();
let sandbox: string;
beforeEach(() => {
  sandbox = createRoot("bob-root-tests-");
  mkdirSync(join(sandbox, "home"));
});

function fixture(body: string, beforeReport = ""): string {
  const file = join(sandbox, "case.test.ts");
  writeFileSync(
    file,
    `import { afterAll, beforeEach, it } from "bun:test";
import { closeSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { trackedTempRoots } from ${JSON.stringify(new URL("./tracked-temp-roots.ts", import.meta.url).href)};
let root;
afterAll(() => { ${beforeReport} });
const createRoot = trackedTempRoots();
beforeEach(() => {
  root = createRoot("bob-mailturn-");
  writeFileSync(${JSON.stringify(join(sandbox, "root"))}, root);
});
${body}
`,
  );
  return file;
}

function options() {
  return {
    cwd: sandbox,
    env: { ...process.env, HOME: join(sandbox, "home"), TMPDIR: sandbox },
  };
}

function root(): string {
  return readFileSync(join(sandbox, "root"), "utf8");
}

it("afterEach removes a case's root before afterAll", () => {
  const file = fixture(
    'it("case", () => {});',
    `writeFileSync(${JSON.stringify(join(sandbox, "remaining"))}, String(existsSync(root)));`,
  );
  const run = spawnSync(process.execPath, ["test", file], {
    ...options(),
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  expect(run.status).toBe(0);
  expect(readFileSync(join(sandbox, "remaining"), "utf8")).toBe("false");
  expect(existsSync(root())).toBe(false);
});

it("afterAll releases its signal handlers", () => {
  const file = fixture(`it("case", () => {});
afterAll(() => {
  writeFileSync(${JSON.stringify(join(sandbox, "listeners"))}, JSON.stringify(
    ["SIGTERM", "SIGINT"].flatMap(signal => process.listeners(signal).map(listener => listener.name))
  ));
});`);
  const run = spawnSync(process.execPath, ["test", file], {
    ...options(),
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  expect(run.status).toBe(0);
  expect(JSON.parse(readFileSync(join(sandbox, "listeners"), "utf8"))).toEqual([]);
});

it("a timed out case removes its root before afterAll", () => {
  const file = fixture(
    'it("timeout case", async () => { await new Promise(() => {}); }, 20);',
    `writeFileSync(${JSON.stringify(join(sandbox, "remaining"))}, String(existsSync(root)));`,
  );
  const run = spawnSync(process.execPath, ["test", file], {
    ...options(),
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  expect(run.status).toBe(1);
  expect(run.stderr).toContain("timed out");
  expect(readFileSync(join(sandbox, "remaining"), "utf8")).toBe("false");
  expect(existsSync(root())).toBe(false);
});

it("process exit removes a root without afterEach", () => {
  const file = fixture('it("exit case", () => { process.exit(0); });');
  const run = spawnSync(process.execPath, ["test", file], {
    ...options(),
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  expect(run.status).toBe(0);
  expect(existsSync(root())).toBe(false);
});

for (const [signal, code] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
] as const) {
  it(`${signal} removes a root while a case is running`, async () => {
    const file = fixture(
      'it("signal case", async () => { console.log("CASE_READY"); await new Promise(() => {}); }, 10000);',
    );
    const child = spawn(process.execPath, ["test", file], options());
    let stdout = "";
    let stderr = "";
    let sent = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (!sent && stdout.includes("CASE_READY")) {
        sent = true;
        child.kill(signal);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    try {
      const result = await new Promise<{ code: number | null; signal: string | null }>(
        (resolve, reject) => {
          child.on("error", reject);
          child.on("close", (code, signal) => resolve({ code, signal }));
        },
      );
      expect(sent, stderr).toBe(true);
      expect(existsSync(root()), `${signal} left the root ${root()}`).toBe(false);
      expect(result).toEqual({ code, signal: null });
    } finally {
      clearTimeout(timer);
      child.kill("SIGKILL");
    }
  }, 15_000);
}

it("afterAll reports a planted leftover and its largest entries on stderr", () => {
  const file = fixture(
    'it("case", () => {});',
    `mkdirSync(join(root, "cache"), { recursive: true });
writeFileSync(join(root, "cache", "data"), "x".repeat(9000));
for (let n = 1; n <= 6; n++) writeFileSync(join(root, "entry-" + n), "x".repeat(n * 100));
symlinkSync(root, join(root, "loop"));`,
  );
  const run = spawnSync(process.execPath, ["test", file], {
    ...options(),
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  expect(run.status).toBe(0);
  const inventory = run.stderr.split("\n").filter((line) => line.startsWith("  "));
  expect(run.stderr).toContain(`leftover test root: ${root()}`);
  expect(inventory).toEqual([
    `  9000 bytes\t${join(root(), "cache")}`,
    ...[6, 5, 4, 3].map((n) => `  ${n * 100} bytes\t${join(root(), `entry-${n}`)}`),
  ]);
  expect(run.stdout).not.toContain("leftover test root:");
  expect(existsSync(root())).toBe(false);
});

it("afterAll tolerates closed stderr with a planted leftover", () => {
  const file = fixture(
    'it("case", () => {});',
    `mkdirSync(root, { recursive: true });
writeFileSync(join(root, "leftover"), "data");
closeSync(2);`,
  );
  const run = spawnSync(process.execPath, ["test", file], {
    ...options(),
    encoding: "utf8",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  expect(run.status).toBe(0);
  expect(existsSync(root())).toBe(false);
});

for (const [signal, code] of [
  ["SIGTERM", 143],
  ["SIGINT", 130],
] as const) {
  for (const mode of ["preload", "two files"] as const) {
    it(`${signal} removes roots with ${mode}`, async () => {
      const preload = new URL("./state-root.setup.ts", import.meta.url).pathname;
      const files = [];
      for (let index = 0; index < (mode === "two files" ? 2 : 1); index++) {
        const file = join(sandbox, `${index}.test.ts`);
        files.push(file);
        writeFileSync(
          file,
          `import { it } from "bun:test";
import { writeFileSync } from "node:fs";
${
  mode === "two files"
    ? `import { trackedTempRoots } from ${JSON.stringify(new URL("./tracked-temp-roots.ts", import.meta.url).href)};
const createRoot = trackedTempRoots();`
    : ""
}
it("state root", async () => {
  ${
    mode === "two files"
      ? `const root = createRoot("bob-cross-file-");
  writeFileSync(${JSON.stringify(join(sandbox, `root-${index}`))}, root);`
      : ""
  }
  ${mode === "preload" ? `writeFileSync(${JSON.stringify(join(sandbox, `state-${index}`))}, process.env.BOB_STATE_DIR);` : ""}
  ${index === (mode === "two files" ? 1 : 0) ? 'console.log("CASE_READY"); await new Promise(() => {});' : ""}
}, 10000);
`,
        );
      }
      const child = spawn(
        process.execPath,
        ["test", ...(mode === "preload" ? ["--preload", preload] : []), ...files],
        options(),
      );
      let stdout = "";
      let stderr = "";
      let sent = false;
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (!sent && stdout.includes("CASE_READY")) {
          sent = true;
          child.kill(signal);
        }
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      try {
        const result = await new Promise<{ code: number | null; signal: string | null }>(
          (resolve, reject) => {
            child.on("error", reject);
            child.on("close", (code, signal) => resolve({ code, signal }));
          },
        );
        expect(sent, stderr).toBe(true);
        for (let index = 0; index < files.length; index++) {
          for (const kind of mode === "two files" ? ["root"] : ["state"]) {
            const path = readFileSync(join(sandbox, `${kind}-${index}`), "utf8");
            expect(existsSync(path), `${signal} left the ${kind} root ${path}`).toBe(false);
          }
        }
        expect(result).toEqual({ code, signal: null });
      } finally {
        clearTimeout(timer);
        child.kill("SIGKILL");
      }
    }, 15_000);
  }
}
