import { describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../src/shell/argv.js";
import { initAgent } from "../src/shell/init.js";
import { type SpawnError, spawnNode, spawnNodeAsync } from "./cli-spawn.js";
import { operatorCredentialForms } from "./shell/flair-fake.js";

const CLI = join(import.meta.dir, "..", "dist", "cli.js");

describe("bob CLI", () => {
  it("hire keeps the agent name positional after a bare --flair", () => {
    expect(parseArgs(["hire", "--flair", "flagged", "--as", "builder"]).positional).toEqual([
      "flagged",
    ]);
  });
  it.each([
    ["--flair=true", "flagged"],
    ["--flair=false", "flagged"],
    ["--flair", "flagged"],
  ])("hire refuses unsupported %s before creating an agent", (flag, name) => {
    const home = mkdtempSync(join(tmpdir(), "bob-hire-flair-"));
    const args =
      flag === "--flair"
        ? [CLI, "hire", flag, name, "--as", "builder"]
        : [CLI, "hire", name, "--as", "builder", flag];
    try {
      spawnNode(args, { env: { ...process.env, HOME: home } });
      throw new Error("hire unexpectedly succeeded");
    } catch (err) {
      const e = err as SpawnError;
      expect(e.code).toBe(2);
      expect(e.stdout).toContain("--flair is not supported");
      expect(existsSync(join(home, "agents", name))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
  it("prints help on `bob help`", () => {
    const out = spawnNode([CLI, "help"]);
    expect(out).toContain("Bob — moldable office-agent shell");
    expect(out).toContain("Commands:");
    expect(out).toMatch(/^Roles:.*\bjarvis\b/m);
  });

  it.each(["ea", "jarvis"])(
    "onboard --role %s --dry-run shows the plan without writing",
    (role) => {
      const out = spawnNode([CLI, "onboard", "testbot", "--role", role, "--dry-run"]);
      expect(out).toContain("[bob onboard] PLAN (--dry-run)");
      expect(out).toContain("agent.id        = testbot");
      expect(out).toContain(`agent.role      = ${role}`);
    },
  );

  it("onboard fails for unknown role", () => {
    try {
      spawnNode([CLI, "onboard", "testbot", "--role", "nonexistent", "--dry-run"]);
      throw new Error("expected non-zero exit");
    } catch (err: any) {
      expect(err.stdout || err.message).toContain("unknown role");
    }
  });

  it("init is a soft alias for onboard (with deprecation hint)", () => {
    const out = spawnNode([CLI, "init", "testbot", "--role", "ea", "--dry-run"]);
    expect(out).toContain("renamed to `bob onboard`");
    expect(out).toContain("[bob onboard] PLAN (--dry-run)");
  });

  it("onboard --dry-run states that it will provision the Flair identity (#93/#94)", () => {
    const out = spawnNode([CLI, "onboard", "testbot", "--role", "ea", "--dry-run"]);
    expect(out).toContain("flair identity  = Agent record + soul at http://127.0.0.1:19926");
  });

  it("onboard --dry-run --no-flair states the identity is SKIPPED", () => {
    const out = spawnNode([CLI, "onboard", "testbot", "--role", "ea", "--dry-run", "--no-flair"]);
    expect(out).toContain("flair identity  = SKIPPED (--no-flair)");
  });

  it("onboard --dry-run honours --flair-url", () => {
    const out = spawnNode([
      CLI,
      "onboard",
      "testbot",
      "--role",
      "ea",
      "--dry-run",
      "--flair-url",
      "http://hub.example:19926",
    ]);
    expect(out).toContain("Agent record + soul at http://hub.example:19926");
  });

  it("help documents the admin credential file without accepting a password value flag", () => {
    const out = spawnNode([CLI, "help"]);
    expect(out).toContain("FLAIR_ADMIN_PASS");
    expect(out).toContain("never pass the");
    expect(out).toContain("--admin-pass-file");
    expect(out).toContain("--no-flair");
    // A file path is okay in argv; the password value is not.
    expect(out).not.toMatch(/--admin-pass(?:\s|=|$)/m);
  });

  it("onboard --no-interactive renders the plan with interview SKIPPED", () => {
    const out = spawnNode([
      CLI,
      "onboard",
      "testbot",
      "--role",
      "ea",
      "--dry-run",
      "--no-interactive",
    ]);
    expect(out).toContain("interview       = SKIPPED");
  });

  it("onboard --dry-run plans an interactive pi session by default", () => {
    const out = spawnNode([CLI, "onboard", "testbot", "--role", "ea", "--dry-run"]);
    expect(out).toContain("interview       = interactive pi session");
  });

  it("help advertises align flags", () => {
    const out = spawnNode([CLI, "help"]);
    expect(out).toContain("align <name>");
    expect(out).toContain("--agent-dir");
  });

  it("align refuses a URL that differs from bob.yaml before opening the setup session", () => {
    const home = mkdtempSync(join(tmpdir(), "bob-align-pin-cli-"));
    try {
      const agent = initAgent({
        name: "testbot",
        role: "reviewer",
        provider: "ollama-cloud",
        model: "kimi-k2.6",
        agentsRoot: join(home, "agents"),
        flairKeysDir: join(home, ".flair", "keys"),
      });
      let output = "";
      try {
        spawnNode(
          [
            CLI,
            "align",
            "testbot",
            "--agent-dir",
            agent.agentDir,
            "--flair-url",
            "https://attacker.example.test",
          ],
          {
            env: { ...process.env, HOME: home },
          },
        );
        throw new Error("expected align to refuse a mismatched Flair URL");
      } catch (err: unknown) {
        const e = err as SpawnError;
        output = e.stdout ?? e.message ?? "";
      }
      expect(output).toContain("bob.yaml flair.url differs from --flair-url");
      expect(output).not.toContain("starting alignment check");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("help advertises persistent run + lifecycle commands", () => {
    const out = spawnNode([CLI, "help"]);
    expect(out).toContain("run <name>");
    expect(out).toContain("PERSISTENTLY"); // run-with-no-prompt = persistent on-duty
    expect(out).not.toContain("serve <name>"); // serve is retired
    expect(out).toContain("install-service");
    expect(out).toContain("up <name>");
    expect(out).toContain("down <name>");
    expect(out).toContain("restart <name>");
  });

  // One case per command: each spawn costs ~1.2 s on a CI runner, and four of
  // them inside a single test raced bun's 5 s default budget (timed out at
  // 5075 ms on 2026-09-03). it.each gives every command its own budget and its
  // own name in the report — the shape test/shell/role-loader.test.ts uses.
  it.each(["up", "down", "restart", "install-service"] as const)("%s requires a <name>", (cmd) => {
    try {
      spawnNode([CLI, cmd]);
      throw new Error(`expected non-zero exit for bare '${cmd}'`);
    } catch (err) {
      const e = err as { stdout?: string; message?: string };
      expect(e.stdout || e.message).toContain(`bob ${cmd}: missing <name>`);
    }
  });
});

// The `--key=value` boolean-flag path, end to end (#173). The `--key=value` form
// (`--dry-run=true`) USED TO parse to the STRING "true", and the boolean consumers
// read it with `=== true`, which is false for a string — so `--dry-run=true`
// silently skipped the dry-run branch and scaffolded + provisioned the Flair
// identity for real (the opposite of the request); `--no-flair=true` likewise
// still registered. parseArgs now validates every declared boolean as it parses
// (bare / `=true` / `=false` only; anything else is a UsageError before any
// command runs) and yields booleans; `boolFlag` keeps the same whitelist as a
// second guard. These drive the CLI (not parseArgs alone), so the whole path is
// covered, with HOME isolated to a scratch dir so no test writes into a real
// agent tree.
describe("--key=value boolean flags (parser-to-CLI)", () => {
  function scratchHome(): string {
    return mkdtempSync(join(tmpdir(), "bob-boolflag-"));
  }
  // Run a CLI subcommand with HOME pointed at a scratch dir. `args` is an argv
  // array (no shell, no splitting) passed straight to spawnNode, so a value with
  // a space is one literal argument; spawnNode returns the merged stdout+stderr
  // on a clean exit and throws a SpawnError on a non-zero exit, a timeout/kill.
  function runCli(args: string[], home: string): string {
    try {
      return spawnNode([CLI, ...args], { env: { ...process.env, HOME: home } });
    } catch (err: unknown) {
      const e = err as SpawnError;
      return e.stdout || e.message || "";
    }
  }

  it("--dry-run=true takes the dry-run branch — prints the plan and creates no agent dir", () => {
    const home = scratchHome();
    const out = runCli(["onboard", "testbot", "--role", "ea", "--dry-run=true"], home);
    expect(out).toContain("PLAN (--dry-run)");
    // The dry-run branch returns before initAgent, so no agent dir was written:
    // `--dry-run=true` can no longer scaffold, let alone provision, for real.
    expect(existsSync(join(home, "agents", "testbot"))).toBe(false);
  });

  it("--dry-run=false does NOT take the dry-run branch — it scaffolds for real", () => {
    const home = scratchHome();
    // --no-flair + --no-interactive keep the real branch filesystem-only (no
    // network, no interview), so the assert is deterministic instead of a hang.
    const out = runCli(
      [
        "onboard",
        "testbot",
        "--role",
        "ea",
        "--dry-run=false",
        "--no-flair=true",
        "--no-interactive=true",
      ],
      home,
    );
    expect(out).not.toContain("PLAN (--dry-run)");
    expect(out).toContain("scaffolded testbot");
    expect(existsSync(join(home, "agents", "testbot"))).toBe(true);
    rmSync(home, { recursive: true, force: true });
  });

  it("--dry-run=yes fails with a usage error on a non-zero exit BEFORE any side effect", () => {
    const home = scratchHome();
    let out = "";
    let threw = false;
    // spawnNode throws on a non-zero exit, which is the signal we expect here.
    try {
      out = spawnNode([CLI, "onboard", "testbot", "--role", "ea", "--dry-run=yes"], {
        env: { ...process.env, HOME: home },
      });
    } catch (err: unknown) {
      threw = true;
      const e = err as { stdout?: string; message?: string };
      out = e.stdout || e.message || out || "";
    }
    expect(threw).toBe(true); // a non-zero exit
    expect(out).toContain("takes no value"); // names the flag + the accepted values
    expect(out).toContain("yes"); // names the offending value
    expect(out).not.toContain("    at "); // a usage error, never a stack trace
    // No side effect: the UsageError is thrown while parsing, before any
    // command runs, so no agent dir exists.
    expect(existsSync(join(home, "agents", "testbot"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("an empty --dry-run= is a usage error too, exit 2, before any side effect", () => {
    const home = scratchHome();
    let status = 0;
    let out = "";
    try {
      spawnNode([CLI, "onboard", "testbot", "--role", "ea", "--dry-run="], {
        env: { ...process.env, HOME: home },
      });
    } catch (err: unknown) {
      const e = err as SpawnError;
      status = e.code ?? -1;
      out = e.stdout ?? "";
    }
    expect(status).toBe(2);
    expect(out).toContain("--dry-run takes no value");
    expect(existsSync(join(home, "agents", "testbot"))).toBe(false);
    rmSync(home, { recursive: true, force: true });
  });

  it("an empty --model= / --provider= on onboard means the default, never an empty id in bob.yaml", () => {
    const home = scratchHome();
    const out = runCli(
      [
        "onboard",
        "testbot",
        "--role",
        "ea",
        "--model=",
        "--provider=",
        "--no-flair",
        "--no-interactive",
      ],
      home,
    );
    expect(out).toContain("scaffolded testbot");
    const yaml = readFileSync(join(home, "agents", "testbot", "bob.yaml"), "utf8");
    expect(yaml).toContain("name: ollama-cloud");
    expect(yaml).toContain("model: kimi-k2.6");
    expect(yaml).not.toMatch(/model:\s*$/m);
    rmSync(home, { recursive: true, force: true });
  });

  it("a bare --model on onboard means the default too — never the literal id 'true'", () => {
    const home = scratchHome();
    const out = runCli(
      ["onboard", "testbot", "--role", "ea", "--model", "--no-flair", "--no-interactive"],
      home,
    );
    expect(out).toContain("scaffolded testbot");
    const yaml = readFileSync(join(home, "agents", "testbot", "bob.yaml"), "utf8");
    expect(yaml).toContain("model: kimi-k2.6");
    expect(yaml).not.toContain("model: true");
    rmSync(home, { recursive: true, force: true });
  });

  it("bob align refuses a bad --no-flair spelling BEFORE its session can rewrite soul.md", () => {
    const home = scratchHome();
    // A real (filesystem-only) agent to align: no Flair, no interview.
    runCli(["onboard", "testbot", "--role", "ea", "--no-flair", "--no-interactive"], home);
    const soul = join(home, "agents", "testbot", "soul.md");
    expect(existsSync(soul)).toBe(true);
    const before = readFileSync(soul, "utf8");
    let status = 0;
    let out = "";
    try {
      spawnNode([CLI, "align", "testbot", "--no-flair=yes"], {
        env: { ...process.env, HOME: home },
      });
    } catch (err: unknown) {
      const e = err as SpawnError;
      status = e.code ?? -1;
      out = e.stdout ?? "";
    }
    expect(status).toBe(2);
    expect(out).toContain("--no-flair takes no value");
    expect(out).not.toContain("starting alignment check"); // no session was started
    expect(readFileSync(soul, "utf8")).toBe(before);
    rmSync(home, { recursive: true, force: true });
  });
});

// The real operator transports, end to end: the built CLI, its real fetch, and
// a local HTTP server. In "registration"/"soul" mode the server reflects the
// request's credential into that request's error body; in "none" mode every
// request succeeds. It records each request's method, path and Authorization.
async function localFlair(
  failAt: "registration" | "soul" | "none",
  reflect: "authorization" | "decoded-basic" = "authorization",
) {
  const served: string[] = [];
  const requests: { method: string; path: string; authorization: string }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
    });
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        path: req.url ?? "",
        authorization: req.headers.authorization ?? "",
      });
      const json = (status: number, body: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const fail = () => {
        const auth = req.headers.authorization ?? "";
        const echoed =
          reflect === "authorization"
            ? auth
            : Buffer.from(auth.replace(/^Basic /, ""), "base64").toString("utf8");
        const body = `{"error":"refused"} (request credential: ${echoed})`;
        served.push(body);
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(body);
      };
      if (req.method === "POST" && req.url === "/") {
        if (failAt === "registration") return fail();
        const op = JSON.parse(raw) as { operation: string; records?: { id: string }[] };
        if (op.operation === "search_by_id") return json(200, []);
        if (op.operation === "insert") {
          return json(200, {
            inserted_hashes: (op.records ?? []).map((r) => r.id),
            skipped_hashes: [],
          });
        }
        return json(400, { error: "unhandled operation" });
      }
      if (req.url?.startsWith("/Soul/") && req.method === "GET") {
        return json(404, { error: "not found" });
      }
      if (req.url?.startsWith("/Soul/") && req.method === "PUT") {
        return failAt === "soul" ? fail() : json(200, { ok: true });
      }
      return json(404, { error: "no route" });
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url, served, requests };
}

// A --preload module for the CLI's interpreter. It wraps fetch: at every call
// it records whether FLAIR_ADMIN_PASS is still in the CLI's process.env, and it
// makes the one operator request with `method` fail in TRANSPORT — "fetch"
// rejects, "text" answers `status` with a body reader that rejects — with the
// request's Authorization header in the exception's message and the decoded
// credential in its cause. Every other request goes to the real fetch.
function fetchPreload(
  dir: string,
  opts: { stage: "fetch" | "text" | "none"; method?: string; status?: number },
): { path: string; envAtFetch: string } {
  const path = join(dir, "fetch-preload.mjs");
  const envAtFetch = join(dir, "env-at-fetch.txt");
  writeFileSync(
    path,
    [
      `import { appendFileSync } from "node:fs";`,
      `const realFetch = globalThis.fetch;`,
      `globalThis.fetch = async (url, init = {}) => {`,
      `  appendFileSync(${JSON.stringify(envAtFetch)}, process.env.FLAIR_ADMIN_PASS === undefined ? "absent\\n" : "present\\n");`,
      `  const headers = init.headers ?? {};`,
      `  const auth = headers.Authorization ?? headers.authorization ?? "";`,
      `  if (${JSON.stringify(opts.stage)} === "none" || init.method !== ${JSON.stringify(opts.method ?? "")} || !auth.startsWith("Basic ")) return realFetch(url, init);`,
      `  const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");`,
      `  const boom = () => new Error("transport failed; request carried Authorization: " + auth, { cause: new Error("authenticated as " + decoded) });`,
      `  if (${JSON.stringify(opts.stage)} === "fetch") throw boom();`,
      `  const status = ${opts.status ?? 200};`,
      `  return { ok: status >= 200 && status < 300, status, text: async () => { throw boom(); } };`,
      `};`,
    ].join("\n"),
  );
  return { path, envAtFetch };
}

// `bob onboard <name> --no-interactive` against `flairUrl`, with HOME isolated,
// the admin-pass file holding `filePassword`, and FLAIR_ADMIN_PASS set only
// when `envPassword` is given.
async function onboardCli(opts: {
  home: string;
  flairUrl: string;
  filePassword: string;
  envPassword?: string;
  preload?: string;
}) {
  const passFile = join(opts.home, "admin-pass");
  writeFileSync(passFile, `${opts.filePassword}\n`, { mode: 0o600 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: opts.home,
    FLAIR_OPS_TARGET: opts.flairUrl,
  };
  delete env.FLAIR_ADMIN_PASS;
  if (opts.envPassword !== undefined) env.FLAIR_ADMIN_PASS = opts.envPassword;
  const run = await spawnNodeAsync(
    [
      ...(opts.preload ? ["--preload", opts.preload] : []),
      CLI,
      "onboard",
      "testbot",
      "--no-interactive",
      "--flair-url",
      opts.flairUrl,
      "--admin-pass-file",
      passFile,
    ],
    { env },
  );
  return { ...run, passFile };
}

describe("bob onboard against a Flair that reflects request headers", () => {
  const PLACEHOLDER = "placeholder-not-a-real-admin-credential";

  for (const reflect of ["authorization", "decoded-basic"] as const) {
    for (const failAt of ["registration", "soul"] as const) {
      it(`prints no operator credential when ${failAt} fails (${reflect})`, async () => {
        const home = mkdtempSync(join(tmpdir(), "bob-reflect-cli-"));
        const flair = await localFlair(failAt, reflect);
        try {
          const run = await onboardCli({ home, flairUrl: flair.url, filePassword: PLACEHOLDER });
          expect(run.code).toBe(1);
          expect(run.stderr).toContain(
            failAt === "registration"
              ? `bob: flair ops-API search_by_id Agent -> 500: operator request failed; check ${run.passFile}`
              : `bob: flair Soul PUT testbot:name -> 500: operator write failed; check ${run.passFile}`,
          );
          // The reflected credential really went back to bob on the wire.
          const [header, , decoded] = operatorCredentialForms(PLACEHOLDER);
          expect(flair.served.join("\n")).toContain(reflect === "authorization" ? header : decoded);
          for (const form of operatorCredentialForms(PLACEHOLDER)) {
            expect(run.stdout).not.toContain(form);
            expect(run.stderr).not.toContain(form);
          }
        } finally {
          flair.server.close();
          rmSync(home, { recursive: true, force: true });
        }
      }, 20_000);
    }
  }
});

describe("bob onboard when an operator request fails in transport", () => {
  const PLACEHOLDER = "placeholder-not-a-real-admin-credential";
  const cases = [
    {
      name: "registration fetch rejects",
      preload: { stage: "fetch", method: "POST" },
      expected: (origin: string) =>
        `bob: flair ops-API search_by_id Agent to ${origin}: the request failed before a response arrived`,
    },
    {
      name: "registration body read rejects",
      preload: { stage: "text", method: "POST", status: 200 },
      expected: (origin: string) =>
        `bob: flair ops-API search_by_id Agent to ${origin}: the response could not be read`,
    },
    {
      name: "Soul PUT fetch rejects",
      preload: { stage: "fetch", method: "PUT" },
      expected: (origin: string) =>
        `bob: flair Soul PUT testbot:name to ${origin}: the request failed before a response arrived`,
    },
    {
      name: "Soul PUT body read rejects on a 500",
      preload: { stage: "text", method: "PUT", status: 500 },
      expected: () => "bob: flair Soul PUT testbot:name -> 500: operator write failed",
    },
  ] as const;

  for (const c of cases) {
    it(`prints no operator credential when the ${c.name}`, async () => {
      const home = mkdtempSync(join(tmpdir(), "bob-transport-cli-"));
      const flair = await localFlair("none");
      try {
        const preload = fetchPreload(home, c.preload);
        const run = await onboardCli({
          home,
          flairUrl: flair.url,
          filePassword: PLACEHOLDER,
          preload: preload.path,
        });
        expect(run.code).toBe(1);
        expect(run.stderr).toContain(c.expected(flair.url));
        for (const form of operatorCredentialForms(PLACEHOLDER)) {
          expect(run.stdout).not.toContain(form);
          expect(run.stderr).not.toContain(form);
        }
      } finally {
        flair.server.close();
        rmSync(home, { recursive: true, force: true });
      }
    }, 20_000);
  }
});

describe("bob onboard takes FLAIR_ADMIN_PASS out of its environment", () => {
  const ENV_PASSWORD = "env-placeholder-not-a-real-admin-credential";
  const FILE_PASSWORD = "file-placeholder-not-a-real-admin-credential";

  it("before any request, and hands it to registration only", async () => {
    const home = mkdtempSync(join(tmpdir(), "bob-envpass-cli-"));
    const flair = await localFlair("none");
    try {
      const preload = fetchPreload(home, { stage: "none" });
      const run = await onboardCli({
        home,
        flairUrl: flair.url,
        filePassword: FILE_PASSWORD,
        envPassword: ENV_PASSWORD,
        preload: preload.path,
      });
      expect(run.code).toBe(0);
      // Registration used the environment value, passed explicitly; the Soul
      // writes used the password file.
      const basic = (password: string) => operatorCredentialForms(password)[0];
      const ops = flair.requests.filter((r) => r.method === "POST" && r.path === "/");
      const puts = flair.requests.filter((r) => r.method === "PUT");
      expect(ops.length).toBeGreaterThan(0);
      expect(puts.length).toBeGreaterThan(0);
      expect(ops.every((r) => r.authorization === basic(ENV_PASSWORD))).toBe(true);
      expect(puts.every((r) => r.authorization === basic(FILE_PASSWORD))).toBe(true);
      // At every request — the first registration request included — the
      // variable was already gone from the CLI's process environment.
      const seen = readFileSync(preload.envAtFetch, "utf8").trim().split("\n");
      expect(seen.length).toBe(flair.requests.length);
      expect(seen.every((line) => line === "absent")).toBe(true);
      for (const form of [
        ...operatorCredentialForms(ENV_PASSWORD),
        ...operatorCredentialForms(FILE_PASSWORD),
      ]) {
        expect(run.stdout).not.toContain(form);
        expect(run.stderr).not.toContain(form);
      }
    } finally {
      flair.server.close();
      rmSync(home, { recursive: true, force: true });
    }
  }, 20_000);
});
