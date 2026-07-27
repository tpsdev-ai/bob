#!/usr/bin/env node
// scripts/verify-pack.mjs
//
// Proves the PUBLISHED artifact works, by building one and using it.
//
// Every defect this repo has hit around packaging (an uninstallable
// `workspace:` spec, a capability catalog pointing at a path that only exists
// in a checkout, capability packages resolved through a name that would never
// be published) shared one property: the monorepo was green the whole time.
// The only thing that catches that class is packing a tarball, installing it
// somewhere with nothing else in it, and running the result. So this script
// does exactly that, and CI runs it on every PR.
//
//   npm pack  →  npm install the tarball into a scratch dir  →
//   run the installed `bob` binary  →  resolve + LOAD every blessed capability
//   through the installed package  →  assert the tools are registered  →
//   break the install on purpose and assert the failure is a named, clean,
//   exit-1 error rather than a silent under-equipped agent.
//
// npm, not bun, on purpose: npm is what a user runs and what the release
// pipeline publishes with, and npm is the one that does NOT rewrite specs when
// it builds a tarball. A bun-based check passes on artifacts npm would break.
//
// Usage: node scripts/verify-pack.mjs [--keep]
//   --keep   leave the scratch dir in place for inspection

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = process.argv.includes("--keep");

// Capability → a tool it must register once loaded. The point of the whole
// exercise: resolving is not loading, and loading is not registering.
const CAPABILITY_TOOLS = {
  fixture: "bob_fixture_noop",
  discord: "discord_reply",
  flair: "flair_search",
  observatory: "observatory_report",
};

let failures = 0;
function check(name, fn) {
  try {
    const detail = fn();
    console.log(`  ok    ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (err) {
    failures++;
    console.error(`  FAIL  ${name}`);
    for (const line of String(err.message).split("\n")) console.error(`        ${line}`);
  }
}

// Run a command, returning { status, stdout, stderr } without throwing. Env is
// scoped to the scratch dir (isolated HOME + npm cache) so nothing here can
// touch the real environment.
function run(cmd, args, opts = {}) {
  try {
    const stdout = execFileSync(cmd, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...opts,
    });
    return { status: 0, stdout, stderr: "" };
  } catch (err) {
    return {
      status: err.status ?? 1,
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? String(err.message),
    };
  }
}

const scratch = mkdtempSync(join(tmpdir(), "bob-verify-pack-"));
const home = join(scratch, "home");
const cache = join(scratch, "npm-cache");
const install = join(scratch, "install");
const agents = join(home, "agents");
for (const d of [home, cache, install, agents]) mkdirSync(d, { recursive: true });

const ENV = {
  ...process.env,
  HOME: home,
  npm_config_cache: cache,
  npm_config_audit: "false",
  npm_config_fund: "false",
  npm_config_update_notifier: "false",
};

try {
  console.log(`scratch: ${scratch}\n`);

  // ---------------------------------------------------------------- pack ---
  console.log("pack");
  const packed = run("npm", ["pack", "--silent", "--pack-destination", scratch], {
    cwd: REPO,
    env: ENV,
  });
  if (packed.status !== 0) {
    console.error(packed.stderr);
    process.exit(1);
  }
  const tarball = join(scratch, packed.stdout.trim().split("\n").pop().trim());
  const bytes = run("wc", ["-c", tarball]).stdout.trim().split(/\s+/)[0];
  console.log(`  ok    npm pack — ${tarball.split("/").pop()} (${bytes} bytes)`);

  // Exactly one tarball. If a second package ever reappears, this script is
  // the wrong shape and should be failing loudly rather than testing half of it.
  check("the repo publishes exactly one package", () => {
    const pkg = JSON.parse(run("cat", [join(REPO, "package.json")]).stdout);
    if (pkg.private) throw new Error("root package.json is private — nothing would publish");
    if (pkg.workspaces) throw new Error(`root still declares workspaces: ${pkg.workspaces}`);
    return pkg.name;
  });

  check("no `workspace:` spec survives into the packed manifest", () => {
    // npm does NOT rewrite `workspace:` specs when it builds a tarball (bun
    // silently does, which is what made this invisible in local dev). A
    // published package whose dependency is the literal string "workspace:*"
    // fails to install for EVERY user with EUNSUPPORTEDPROTOCOL.
    const json = run("tar", ["-xzOf", tarball, "package/package.json"]).stdout;
    const pkg = JSON.parse(json);
    const bad = [];
    for (const group of ["dependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [dep, range] of Object.entries(pkg[group] ?? {})) {
        if (String(range).startsWith("workspace:")) bad.push(`${group}.${dep} = ${range}`);
      }
    }
    if (bad.length) throw new Error(bad.join("\n"));
    return `${Object.keys(pkg.dependencies ?? {}).length} runtime deps, all resolvable`;
  });

  check("the tarball carries the bin shim, the roles and every capability", () => {
    const listing = run("tar", ["-tzf", tarball]).stdout.split("\n");
    const required = [
      "package/bin/bob",
      "package/dist/cli.js",
      "package/roles/ea/soul.md",
      ...Object.keys(CAPABILITY_TOOLS).map((c) => `package/dist/capabilities/${c}/index.js`),
    ];
    const missing = required.filter((f) => !listing.includes(f));
    if (missing.length) throw new Error(`missing from tarball:\n${missing.join("\n")}`);
    return `${listing.filter(Boolean).length} entries`;
  });

  // ------------------------------------------------------------- install ---
  console.log("\ninstall (clean dir, isolated HOME + npm cache)");
  writeFileSync(
    join(install, "package.json"),
    `${JSON.stringify({ name: "bob-pack-probe", version: "0.0.0", private: true, type: "module" }, null, 2)}\n`,
  );
  const installed = run("npm", ["install", "--no-save", tarball], { cwd: install, env: ENV });
  if (installed.status !== 0) {
    console.error(installed.stderr || installed.stdout);
    process.exit(1);
  }
  const bob = join(install, "node_modules", ".bin", "bob");
  console.log(`  ok    npm install <tarball> — exit 0`);

  check("the `bob` bin shim is on PATH and executable", () => {
    if (!existsSync(bob)) throw new Error(`no ${bob}`);
    return bob.replace(scratch, "<scratch>");
  });

  // ------------------------------------------------------------- the CLI ---
  console.log("\nthe installed CLI");
  const cli = (...args) => run(bob, args, { cwd: install, env: ENV });

  check("bob help", () => {
    const r = cli("help");
    if (r.status !== 0) throw new Error(`exit ${r.status}\n${r.stderr}`);
    if (!r.stdout.includes("Bob — moldable office-agent shell")) {
      throw new Error("help banner missing");
    }
    return "exit 0";
  });

  check("bob onboard --dry-run (reads the shipped role templates)", () => {
    const r = cli("onboard", "packbot", "--role", "ea", "--dry-run");
    if (r.status !== 0) throw new Error(`exit ${r.status}\n${r.stderr}`);
    // The role template has to have come out of the tarball, not a checkout.
    if (!r.stdout.includes("soul (from template")) throw new Error("role template not loaded");
    return "exit 0";
  });

  check("bob onboard --no-interactive (scaffolds a real agent)", () => {
    const r = cli("onboard", "packbot", "--role", "ea", "--no-interactive");
    if (r.status !== 0) throw new Error(`exit ${r.status}\n${r.stderr}`);
    return "exit 0";
  });

  check("bob doctor", () => {
    // doctor exits 1 when a check fails, which is expected for a freshly
    // scaffolded agent with no keys — what matters is that it RUNS and reports.
    const r = cli("doctor", "packbot");
    if (r.status !== 0 && r.status !== 1) throw new Error(`exit ${r.status}\n${r.stderr}`);
    if (!r.stdout.includes("agent dir")) throw new Error("no doctor report");
    return `exit ${r.status}, report printed`;
  });

  // ------------------------------------------------------- capabilities ----
  // The one that matters. Resolution is not loading and loading is not
  // registering — pi records an extension it cannot load and CONTINUES, so an
  // agent comes up with none of its tools and exit code 0. Drive pi's real
  // resource loader against the INSTALLED package and assert the tools exist.
  console.log("\ncapabilities, loaded from the installed package");
  const probe = join(install, "probe.mjs");
  writeFileSync(
    probe,
    `import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";

const WANT = ${JSON.stringify(CAPABILITY_TOOLS)};
const cwd = mkdtempSync(join(tmpdir(), "bob-probe-cwd-"));
const agentDir = mkdtempSync(join(tmpdir(), "bob-probe-pi-"));
const tokenFile = join(cwd, "bot.token");
writeFileSync(tokenFile, "invalid.token.value\\n", "utf8");

// Config the capabilities read from the environment. Paths and ids only — the
// schemas forbid an inlined secret, and nothing here is one.
process.env.BOB_PERSISTENT = "";
process.env.BOB_CAP_FIXTURE = JSON.stringify({});
process.env.BOB_CAP_DISCORD = JSON.stringify({ tokenFile, channelIds: ["123456789012345678"] });
process.env.BOB_CAP_FLAIR = JSON.stringify({ url: "http://127.0.0.1:9", agentId: "packbot", keyFile: "/dev/null" });
process.env.BOB_CAP_OBSERVATORY = JSON.stringify({
  observatoryUrl: "http://127.0.0.1:9",
  officeId: "packoffice",
  officeKeyFile: "/dev/null",
  agents: [{ agentId: "packbot" }],
});

const out = { resolved: {}, errors: [], tools: [] };
const sources = [];
for (const name of Object.keys(WANT)) {
  const url = import.meta.resolve("@tpsdev-ai/bob/capabilities/" + name);
  const path = fileURLToPath(url);
  out.resolved[name] = path;
  sources.push(path);
}
try {
  const loader = new DefaultResourceLoader({ cwd, agentDir, additionalExtensionPaths: sources });
  await loader.reload();
  out.errors = loader.getExtensions().errors ?? [];
  const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, sessionManager: SessionManager.inMemory(cwd) });
  out.tools = session.getAllTools().map((t) => t.name);
  session.dispose();
} finally {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
}
console.log("__PROBE__" + JSON.stringify(out));
`,
  );

  const probed = run("node", [probe], { cwd: install, env: ENV });
  const marker = probed.stdout.split("__PROBE__")[1];
  if (!marker) {
    console.error(`  FAIL  capability probe did not run\n${probed.stderr || probed.stdout}`);
    failures++;
  } else {
    const result = JSON.parse(marker.trim());
    check("every capability resolves INSIDE the installed package", () => {
      // realpath: node's resolver returns resolved paths, and on macOS the
      // scratch dir lives under a /var → /private/var symlink.
      const root = realpathSync(join(install, "node_modules", "@tpsdev-ai", "bob"));
      const wrong = Object.entries(result.resolved).filter(([, p]) => !p.startsWith(root));
      if (wrong.length) throw new Error(wrong.map(([n, p]) => `${n} -> ${p}`).join("\n"));
      return `${Object.keys(result.resolved).length} capabilities`;
    });
    check("pi loads every capability with zero extension errors", () => {
      if (result.errors.length) throw new Error(JSON.stringify(result.errors, null, 2));
      return "0 errors";
    });
    for (const [cap, tool] of Object.entries(CAPABILITY_TOOLS)) {
      check(`capability "${cap}" registered ${tool}`, () => {
        if (!result.tools.includes(tool)) {
          throw new Error(`session tools: ${result.tools.join(", ") || "(none)"}`);
        }
        return "registered";
      });
    }
  }

  // -------------------------------------------------- the failure path -----
  // A partially-installed capability must be a hard, named, exit-1 error. This
  // is the guard against the original defect returning: pi is silent about an
  // extension it cannot load, so if Bob is silent too, an agent boots with no
  // tools and says nothing.
  console.log("\nthe missing-capability failure path");
  const agentDir = join(agents, "packbot");
  writeFileSync(
    join(agentDir, "bob.yaml"),
    [
      "provider:",
      "  name: anthropic",
      "  model: claude-sonnet-4-6",
      "",
      "capabilities:",
      "  - flair",
      "",
      "flair:",
      "  url: http://127.0.0.1:9",
      "  agentId: packbot",
      "  keyFile: /dev/null",
      "",
    ].join("\n"),
  );
  const flairDir = join(
    install,
    "node_modules",
    "@tpsdev-ai",
    "bob",
    "dist",
    "capabilities",
    "flair",
  );
  const stashed = `${flairDir}.stashed`;
  renameSync(flairDir, stashed);
  const broken = cli("run", "packbot", "say hi");
  renameSync(stashed, flairDir);

  check("a capability whose extension is missing exits 1", () => {
    if (broken.status !== 1) throw new Error(`exit ${broken.status}, expected 1`);
    return "exit 1";
  });
  check("...with a message naming the capability and the remedy", () => {
    const msg = broken.stderr + broken.stdout;
    for (const want of ['capability "flair"', "not present in this install", "bob.yaml"]) {
      if (!msg.includes(want)) throw new Error(`message lacks ${JSON.stringify(want)}:\n${msg}`);
    }
    return "named + actionable";
  });
  check("...and no stack trace", () => {
    const msg = broken.stderr + broken.stdout;
    for (const noise of ["ERR_MODULE_NOT_FOUND", "    at ", "node:internal"]) {
      if (msg.includes(noise)) throw new Error(`message leaks ${JSON.stringify(noise)}:\n${msg}`);
    }
    return "clean";
  });

  console.log(`\n${failures === 0 ? "PASS" : `FAIL — ${failures} check(s)`}`);
} finally {
  if (KEEP) console.log(`\nkept: ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
