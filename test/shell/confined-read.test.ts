// bob#230 — a resident role's `read` is confined to the workspace and refuses
// the agent's credential files. Every refusal here is exercised through pi's
// OWN read tool definition (bob plugs its checked file operations into it), and
// the resolved-session cases go through resolveRunConfig → createPiRunSession,
// the path `bob run` takes.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { createReadToolDefinition, SessionManager } from "@earendil-works/pi-coding-agent";
import { BLESSED_CATALOG, lookupCapability } from "../../src/shell/capability-catalog.js";
import {
  CREDENTIAL_FILE_FIELDS,
  checkReadTarget,
  collectCredentialPaths,
  confinedReadCustomTools,
  createConfinedReadToolDefinition,
  openVerifiedReadTarget,
  readConfinementApplies,
} from "../../src/shell/confined-read.js";
import { runOnboard } from "../../src/shell/onboard.js";
import type { RunSessionConfig } from "../../src/shell/run.js";
import { createPiRunSession, resolveRunConfig } from "../../src/shell/run.js";
import { createBobRuntimeFactory, SETUP_TOOL_POLICY } from "../../src/shell/session.js";

// A throwaway workspace + an "outside" directory beside it + a keys directory
// outside the workspace. Every "credential" here is a temp fixture.
let base: string;
let root: string;
let outside: string;
let keys: string;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "bob-confined-read-")));
  root = join(base, "work");
  outside = join(base, "outside");
  keys = join(base, "keys");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  mkdirSync(keys, { recursive: true });
  writeFileSync(join(root, "inside.txt"), "inside contents");
  writeFileSync(join(root, ".discord.token"), "tok-not-a-real-secret");
  writeFileSync(join(outside, "secret.txt"), "outside contents");
  writeFileSync(join(keys, "agent.key"), "fixture-key-not-a-real-secret");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

type ReadResult = { content: Array<{ type: string; text?: string }> };
const textOf = (res: unknown): string =>
  (res as ReadResult).content.map((c) => c.text ?? "").join("\n");

const NOT_IN_WORKSPACE = /does not resolve to a file inside the agent's workspace/;
const CREDENTIAL = /it is a credential file/;

function readTool(credentialPaths: readonly string[] = []) {
  const tool = createConfinedReadToolDefinition(root, credentialPaths);
  return (path: string) => tool.execute("c1", { path }, undefined, undefined, undefined as never);
}

// Is the temp volume case-insensitive? Create a file and stat a case variant.
function tempVolumeIsCaseInsensitive(): boolean {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "bob-case-probe-")));
  try {
    writeFileSync(join(dir, "Probe-Case.txt"), "x");
    return existsSync(join(dir, "pROBE-cASE.TXT"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const CASE_INSENSITIVE = tempVolumeIsCaseInsensitive();
const NODE = Bun.which("node");
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;

describe("confined read — the workspace root", () => {
  it("reads a normal file inside the workspace (relative and absolute)", async () => {
    const read = readTool();
    expect(textOf(await read("inside.txt"))).toContain("inside contents");
    expect(textOf(await read(join(root, "inside.txt")))).toContain("inside contents");
  });

  it("REFUSES a path OUTSIDE the workspace", async () => {
    await expect(readTool()(join(outside, "secret.txt"))).rejects.toThrow(NOT_IN_WORKSPACE);
  });

  it("REFUSES a symlink inside the workspace that points outside it", async () => {
    symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
    await expect(readTool()("escape.txt")).rejects.toThrow(NOT_IN_WORKSPACE);
  });

  it("REFUSES a `..` traversal that escapes the workspace", async () => {
    await expect(readTool()("../outside/secret.txt")).rejects.toThrow(NOT_IN_WORKSPACE);
  });

  it("checks the path pi actually opens: an @-prefixed or file: URL outside path is refused", async () => {
    // pi's read strips a leading `@` and turns a file: URL into a path before it
    // opens anything; the check runs on THAT path.
    const read = readTool();
    await expect(read(`@${join(outside, "secret.txt")}`)).rejects.toThrow(NOT_IN_WORKSPACE);
    await expect(read(pathToFileURL(join(outside, "secret.txt")).href)).rejects.toThrow(
      NOT_IN_WORKSPACE,
    );
  });

  it("REFUSES a directory inside the workspace (only a regular file is read)", async () => {
    mkdirSync(join(root, "sub"));
    await expect(readTool()("sub")).rejects.toThrow(/not a regular file/);
  });

  it("a path that does not exist is refused in the SAME words as one outside", async () => {
    await expect(readTool()("missing.txt")).rejects.toThrow(NOT_IN_WORKSPACE);
    await expect(readTool()(join(outside, "missing.txt"))).rejects.toThrow(NOT_IN_WORKSPACE);
  });
});

describe("confined read — unknown evidence refuses", () => {
  it("a target whose realpath FAILS is refused (a dangling symlink, a symlink loop)", async () => {
    symlinkSync(join(root, "nowhere.txt"), join(root, "dangling.txt"));
    symlinkSync(join(root, "loop-b"), join(root, "loop-a"));
    symlinkSync(join(root, "loop-a"), join(root, "loop-b"));
    await expect(readTool()("dangling.txt")).rejects.toThrow(NOT_IN_WORKSPACE);
    await expect(readTool()("loop-a")).rejects.toThrow(NOT_IN_WORKSPACE);
  });

  it.skipIf(IS_ROOT)("a target under an unsearchable directory is refused", async () => {
    const locked = join(root, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "f.txt"), "locked contents");
    chmodSync(locked, 0o000);
    try {
      await expect(readTool()("locked/f.txt")).rejects.toThrow(/refusing to read/);
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  it.skipIf(IS_ROOT)(
    "a credential path that cannot be CHECKED (EACCES) refuses the read — it is not treated as absent",
    async () => {
      const lockedKeys = join(base, "locked-keys");
      mkdirSync(lockedKeys);
      writeFileSync(join(lockedKeys, "k.key"), "fixture");
      chmodSync(lockedKeys, 0o000);
      try {
        await expect(readTool([join(lockedKeys, "k.key")])("inside.txt")).rejects.toThrow(
          /credential paths could not be checked \(EACCES\)/,
        );
      } finally {
        chmodSync(lockedKeys, 0o700);
      }
    },
  );

  it("a credential path KNOWN to be absent (ENOENT) does not block a normal read", async () => {
    const read = readTool([join(keys, "not-provisioned.key"), join(keys, "no-dir", "x.key")]);
    expect(textOf(await read("inside.txt"))).toContain("inside contents");
  });
});

describe("confined read — credential files", () => {
  it("REFUSES a credential file placed INSIDE the workspace", async () => {
    await expect(readTool([join(root, ".discord.token")])(".discord.token")).rejects.toThrow(
      CREDENTIAL,
    );
  });

  it("REFUSES a HARD LINK inside the workspace to a credential outside it (device + inode)", async () => {
    linkSync(join(keys, "agent.key"), join(root, "innocent.txt"));
    await expect(readTool([join(keys, "agent.key")])("innocent.txt")).rejects.toThrow(CREDENTIAL);
  });

  it("a non-credential file beside a credential still reads", async () => {
    const read = readTool([join(root, ".discord.token")]);
    expect(textOf(await read("inside.txt"))).toContain("inside contents");
  });

  it.skipIf(!CASE_INSENSITIVE)(
    "REFUSES a case-variant of a credential name on a case-insensitive volume",
    async () => {
      writeFileSync(join(root, "Cred.Key"), "fixture");
      // Configured in one spelling, requested in another, on disk in a third.
      const read = readTool([join(root, "CRED.KEY")]);
      await expect(read("cred.key")).rejects.toThrow(CREDENTIAL);
      expect(() =>
        checkReadTarget(join(root, "cRED.kEY"), {
          workspaceRoot: root,
          credentialPaths: [join(root, "cred.KEY")],
        }),
      ).toThrow(CREDENTIAL);
    },
  );

  it.skipIf(!CASE_INSENSITIVE || NODE === null)(
    "…and under Node too, where a plain realpath keeps the REQUESTED case",
    () => {
      // bin/bob runs under Node. Node's JS realpathSync returns the spelling it
      // was given, so this leg runs the built module under Node itself.
      writeFileSync(join(root, "Cred.Key"), "fixture");
      const dist = resolvePath(import.meta.dir, "../../dist/shell/confined-read.js");
      const script = [
        `import { checkReadTarget } from ${JSON.stringify(pathToFileURL(dist).href)};`,
        "try {",
        "  checkReadTarget(process.argv[1], { workspaceRoot: process.argv[2], credentialPaths: [process.argv[3]] });",
        '  console.log("ALLOWED");',
        "} catch (e) {",
        '  console.log(String(e.message).includes("credential file") ? "REFUSED" : "OTHER " + e.message);',
        "}",
      ].join("\n");
      const run = spawnSync(
        NODE as string,
        ["--input-type=module", "-e", script, join(root, "cred.key"), root, join(root, "CRED.KEY")],
        { encoding: "utf8", timeout: 30_000 },
      );
      expect(run.status, run.stderr).toBe(0);
      expect(run.stdout.trim()).toBe("REFUSED");
    },
  );
});

describe("confined read — the check-to-open race", () => {
  it("a file REPLACED between the check and the open is refused, never read", async () => {
    const target = join(root, "inside.txt");
    const checked = checkReadTarget(target, { workspaceRoot: root, credentialPaths: [] });
    // Swap: another file (a different inode) now sits at the checked path.
    renameSync(join(outside, "secret.txt"), target);
    await expect(openVerifiedReadTarget(checked, target)).rejects.toThrow(
      /changed between the check and the open/,
    );
  });

  it("a file swapped for a SYMLINK between the check and the open is refused", async () => {
    const target = join(root, "inside.txt");
    const checked = checkReadTarget(target, { workspaceRoot: root, credentialPaths: [] });
    rmSync(target);
    symlinkSync(join(keys, "agent.key"), target);
    await expect(openVerifiedReadTarget(checked, target)).rejects.toThrow(/refusing to read/);
  });

  it("an unchanged checked file opens and reads", async () => {
    const target = join(root, "inside.txt");
    const checked = checkReadTarget(target, { workspaceRoot: root, credentialPaths: [] });
    const fh = await openVerifiedReadTarget(checked, target);
    try {
      expect((await fh.readFile()).toString("utf8")).toBe("inside contents");
    } finally {
      await fh.close();
    }
  });
});

describe("confined read — same output as pi's own read", () => {
  // The confined tool IS pi's read with bob's checked operations; the image
  // sniff runs on the verified descriptor. Pin that both produce the same result
  // for text and for each image shape pi recognises (and the ones it rejects).
  const ONE_PX_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  );
  function bmp(dib: number, planes: number, bits: number): Buffer {
    const b = Buffer.alloc(64);
    b.write("BM", 0, "ascii");
    b.writeUInt32LE(64, 2);
    b.writeUInt32LE(14 + dib, 10);
    b.writeUInt32LE(dib, 14);
    b.writeUInt16LE(planes, dib === 12 ? 22 : 26);
    b.writeUInt16LE(bits, dib === 12 ? 24 : 28);
    return b;
  }
  const apng = Buffer.concat([
    ONE_PX_PNG.subarray(0, 33),
    Buffer.from([0, 0, 0, 8]),
    Buffer.from("acTL", "ascii"),
    Buffer.alloc(12),
  ]);
  const FILES: Record<string, Buffer> = {
    "text.txt": Buffer.from("line one\nline two\n"),
    "one.png": ONE_PX_PNG,
    "anim.png": apng,
    "short.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]),
    "ls.jpg": Buffer.from([0xff, 0xd8, 0xff, 0xf7, 0, 0x10]),
    "x.gif": Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"),
    "x.webp": Buffer.concat([Buffer.from("RIFF\x00\x00\x00\x00WEBPVP8 ", "latin1")]),
    "ok.bmp": bmp(40, 1, 24),
    "old.bmp": bmp(12, 1, 8),
    "bad.bmp": bmp(40, 2, 24),
  };

  it("matches pi's read result for text and every image shape", async () => {
    for (const [name, bytes] of Object.entries(FILES)) writeFileSync(join(root, name), bytes);
    const pi = createReadToolDefinition(root);
    const bob = createConfinedReadToolDefinition(root, []);
    const imageBlocks: string[] = [];
    for (const name of Object.keys(FILES)) {
      const want = await pi.execute("c", { path: name }, undefined, undefined, undefined as never);
      const got = await bob.execute("c", { path: name }, undefined, undefined, undefined as never);
      expect(JSON.stringify(got), name).toBe(JSON.stringify(want));
      if ((want as ReadResult).content.some((c) => c.type === "image")) imageBlocks.push(name);
    }
    // The comparison is not text-vs-text only: pi decodes the valid PNG as an
    // image, and the confined read must too.
    expect(imageBlocks).toContain("one.png");
  });
});

describe("collectCredentialPaths — from bob's own parsed config", () => {
  const src = (
    yamlText: string,
    capabilities: Array<{ name: string; config: Record<string, unknown> }> = [],
  ) =>
    collectCredentialPaths({
      yamlText,
      capabilities,
      piAgentDir: "/agent/.pi-agent",
      workspaceRoot: "/agent/work",
      processCwd: "/srv",
    });

  it("reads a QUOTED path containing ` #` exactly as bob's block reader does", () => {
    const list = src(["flair:", '  keyFile: "/keys/my #1.key"', ""].join("\n"));
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.paths).toContain("/keys/my #1.key");
  });

  it("takes a resolved capability's VALIDATED config, and reads undeclared blocks with readBlock", () => {
    const list = src(
      [
        "identity:",
        "  key_file: /keys/identity.key",
        "  pub_file: /keys/identity.pub",
        "observatory:",
        "  officeKeyFile: /keys/office.key",
        "",
      ].join("\n"),
      [{ name: "discord", config: { tokenFile: "/keys/discord.token", channelIds: ["1"] } }],
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.paths).toContain("/keys/identity.key");
    expect(list.paths).toContain("/keys/discord.token");
    expect(list.paths).toContain("/keys/office.key");
    expect(list.paths).not.toContain("/keys/identity.pub");
  });

  it("adds pi's provider stores, expands ~, and refuses BOTH readings of a relative path", () => {
    const list = src(
      ["presence:", "  keyFile: ~/k/p.key", "discord:", "  tokenFile: rel/t.token", ""].join("\n"),
    );
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    expect(list.paths).toContain("/agent/.pi-agent/auth.json");
    expect(list.paths).toContain("/agent/.pi-agent/models.json");
    expect(list.paths).toContain(join(homedir(), "k/p.key"));
    expect(list.paths).toContain("/srv/rel/t.token");
    expect(list.paths).toContain("/agent/work/rel/t.token");
  });

  it("is UNAVAILABLE — never empty — when a credential field is not a path string", () => {
    const list = src(["identity:", "  key_file: 12345", ""].join("\n"));
    expect(list.ok).toBe(false);
    if (list.ok) return;
    expect(list.reason).toContain("identity.key_file");
  });

  it("is UNAVAILABLE when a block that can carry a credential cannot be parsed", () => {
    const list = src(["identity:", "  keys:", "    nested: map", ""].join("\n"));
    expect(list.ok).toBe(false);
    if (list.ok) return;
    expect(list.reason).toContain('"identity:" block');
  });
});

describe("drift: every blessed capability's credential file fields are collected", () => {
  type Schema = Record<string, unknown>;
  const CRED_WORD = /(key|token|secret|credential|password|passphrase|cert)/i;
  const FILE_WORD = /(file|path)$/i;

  // Every property in a schema, with its JSON-pointer-ish location.
  function* walk(
    schema: Schema,
    at: string,
  ): Generator<{ at: string; name: string; prop: Schema }> {
    const props = schema.properties as Record<string, Schema> | undefined;
    for (const [name, prop] of Object.entries(props ?? {})) {
      yield { at: `${at}/${name}`, name, prop };
      yield* walk(prop, `${at}/${name}`);
    }
    if (schema.items && typeof schema.items === "object")
      yield* walk(schema.items as Schema, `${at}/[]`);
    for (const k of ["anyOf", "oneOf", "allOf"]) {
      for (const sub of (schema[k] as Schema[] | undefined) ?? []) yield* walk(sub, at);
    }
    const pattern = schema.patternProperties as Record<string, Schema> | undefined;
    for (const sub of Object.values(pattern ?? {})) yield* walk(sub, `${at}/*`);
  }
  // A field that names a key, token or credential FILE: a credential word in
  // its name, and a file/path suffix or a description that says it is a path.
  function credentialFileFields(schema: Schema): string[] {
    const found: string[] = [];
    for (const { at, name, prop } of walk(schema, "")) {
      const desc = typeof prop.description === "string" ? prop.description : "";
      if (CRED_WORD.test(name) && (FILE_WORD.test(name) || /\b(path|file)\b/i.test(desc))) {
        found.push(at);
      }
    }
    return found;
  }

  it("the detector fires on the known credential fields and not on plain signal-file paths", () => {
    const schema = (n: string) => lookupCapability(n)?.manifest.configSchema as unknown as Schema;
    expect(credentialFileFields(schema("discord"))).toEqual(["/tokenFile"]);
    expect(credentialFileFields(schema("observatory"))).toEqual(["/officeKeyFile"]);
    // observatory's agents[].beadsFile / heartbeatFile are paths, not credentials.
    const all = [...walk(schema("observatory"), "")].map((p) => p.at);
    expect(all).toContain("/agents/[]/beadsFile");
    expect(all).toContain("/agents/[]/heartbeatFile");
  });

  it("every credential file field in every blessed schema is in CREDENTIAL_FILE_FIELDS", () => {
    const missing: string[] = [];
    for (const [name, entry] of Object.entries(BLESSED_CATALOG)) {
      for (const at of credentialFileFields(entry.manifest.configSchema as unknown as Schema)) {
        const top = at.split("/").filter(Boolean);
        const covered = top.length === 1 && (CREDENTIAL_FILE_FIELDS[name] ?? []).includes(top[0]);
        if (!covered) missing.push(`${name}${at}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("every capability entry in CREDENTIAL_FILE_FIELDS names a real string field of that schema", () => {
    for (const [name, fields] of Object.entries(CREDENTIAL_FILE_FIELDS)) {
      if (name === "identity") continue; // bob.yaml's own block, not a capability
      const schema = lookupCapability(name)?.manifest.configSchema as unknown as Schema | undefined;
      expect(schema, name).toBeDefined();
      const props = (schema?.properties ?? {}) as Record<string, Schema>;
      for (const field of fields) expect(props[field]?.type, `${name}.${field}`).toBe("string");
    }
  });
});

describe("who gets the confined read", () => {
  const cfg = { cwd: "/w", credentialPaths: [] as string[] };
  const readPolicy = { resident: false, tools: ["read"], excludeTools: [] as string[] };

  it("a resident policy, a config carrying the resolved `resident`, or the persistent runtime", () => {
    expect(readConfinementApplies({ ...readPolicy, resident: true }, {})).toBe(true);
    expect(readConfinementApplies(readPolicy, { resident: true })).toBe(true);
    expect(readConfinementApplies(readPolicy, { persistent: true })).toBe(true);
    expect(confinedReadCustomTools(readPolicy, { ...cfg, resident: true })[0]?.name).toBe("read");
  });

  it("NOT a non-resident session, and not a policy that does not keep read", () => {
    expect(readConfinementApplies(readPolicy, {})).toBe(false);
    expect(
      readConfinementApplies({ ...readPolicy, resident: true, tools: ["flair_get"] }, {}),
    ).toBe(false);
    expect(
      readConfinementApplies({ ...readPolicy, resident: true, excludeTools: ["read"] }, {}),
    ).toBe(false);
  });

  it("the fixed SETUP session is exempt, even for a resident agent", () => {
    expect(SETUP_TOOL_POLICY.tools).toEqual(["read", "write_soul"]);
    expect(
      readConfinementApplies(SETUP_TOOL_POLICY, { resident: true, setupSoulPath: "/a/soul.md" }),
    ).toBe(false);
  });

  it("REFUSES to compose a resident read without the credential list, naming the remedy", () => {
    expect(() => confinedReadCustomTools(readPolicy, { cwd: "/w", resident: true })).toThrow(
      /credential file list is unavailable .*drop read from tools\.allow/,
    );
    expect(() =>
      confinedReadCustomTools(readPolicy, {
        cwd: "/w",
        resident: true,
        credentialPathsUnavailable: "bob.yaml identity.key_file is not a file path",
      }),
    ).toThrow(/identity\.key_file is not a file path/);
  });
});

// ─── Through the resolved session ────────────────────────────────────────────

type ToolLike = { execute(...a: unknown[]): Promise<unknown> };
type SessionLike = { _toolRegistry: Map<string, ToolLike>; dispose(): void };

// The factory sets capability config env + BOB_PERSISTENT on process.env; put
// them back so nothing leaks into other test files.
function snapshotEnv(): () => void {
  const saved = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith("BOB_CAP_") || k === "BOB_PERSISTENT"),
  );
  return () => {
    for (const k of Object.keys(process.env)) {
      if (k.startsWith("BOB_CAP_") || k === "BOB_PERSISTENT") delete process.env[k];
    }
    Object.assign(process.env, saved);
  };
}

function writeAgent(agentsRoot: string, lines: string[]): string {
  const agentDir = join(agentsRoot, "testbot");
  mkdirSync(join(agentDir, "work"), { recursive: true });
  mkdirSync(join(agentDir, ".pi-agent"), { recursive: true });
  writeFileSync(join(agentDir, "soul.md"), "seed persona for the setup session\n");
  writeFileSync(join(agentDir, "bob.yaml"), lines.join("\n"));
  return agentDir;
}

const HEADER = [
  "agent:",
  "  id: testbot",
  "  name: Testbot",
  "  role: reviewer",
  "",
  "provider:",
  "  name: anthropic",
  "  model: claude-sonnet-4-6",
  "  context_window: 200000",
  "",
];

async function withReadTool(
  config: RunSessionConfig,
  fn: (read: (path: string) => Promise<unknown>) => Promise<void>,
): Promise<void> {
  const session = (await createPiRunSession(config)) as unknown as SessionLike;
  try {
    const tool = session._toolRegistry.get("read");
    if (!tool) throw new Error("the session has no read tool");
    await fn((path) => tool.execute("c", { path }, undefined, undefined));
  } finally {
    session.dispose();
  }
}

describe("confined read — through the resolved session (bob run)", () => {
  let agentsRoot: string;
  let restoreEnv: () => void;
  beforeEach(() => {
    agentsRoot = realpathSync(mkdtempSync(join(tmpdir(), "bob-confined-agent-")));
    restoreEnv = snapshotEnv();
  });
  afterEach(() => {
    restoreEnv();
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  it("a ONE-SHOT run of a `resident: true` agent (persistent: false) gets the confined read", async () => {
    writeAgent(agentsRoot, [
      ...HEADER,
      "resident: true",
      "",
      "tools:",
      "  allow:",
      "    - read",
      "",
    ]);
    const { config } = resolveRunConfig({ name: "testbot", agentsRoot });
    expect(config.persistent).not.toBe(true);
    expect(config.resident).toBe(true);
    await withReadTool(config, async (read) => {
      await expect(read(join(outside, "secret.txt"))).rejects.toThrow(NOT_IN_WORKSPACE);
    });
  });

  it("control: the same agent WITHOUT `resident: true` keeps pi's own read", async () => {
    writeAgent(agentsRoot, [...HEADER, "tools:", "  allow:", "    - read", ""]);
    const { config } = resolveRunConfig({ name: "testbot", agentsRoot });
    await withReadTool(config, async (read) => {
      expect(textOf(await read(join(outside, "secret.txt")))).toContain("outside contents");
    });
  });

  it("refuses EACH credential file bob's parsed config names, and the pi provider stores", async () => {
    const agentDir = join(agentsRoot, "testbot");
    const work = join(agentDir, "work");
    const k = join(work, "keys");
    const creds = {
      identity: join(k, "identity.key"),
      flair: join(k, "fl #air.key"), // quoted in bob.yaml, contains ` #`
      discord: join(k, "discord.token"),
      presence: join(k, "presence.key"),
      observatory: join(k, "office.key"),
    };
    writeAgent(agentsRoot, [
      ...HEADER,
      "resident: true",
      "",
      "identity:",
      "  flair_url: http://127.0.0.1:1",
      `  key_file: ${creds.identity}`,
      `  pub_file: ${join(k, "identity.pub")}`,
      "",
      "tools:",
      "  allow:",
      "    - read",
      "",
      "capabilities:",
      "  - flair",
      "  - discord",
      "  - presence",
      "  - observatory",
      "",
      "flair:",
      "  url: http://127.0.0.1:1",
      "  agentId: testbot",
      `  keyFile: "${creds.flair}"`,
      "",
      "discord:",
      `  tokenFile: ${creds.discord}`,
      "  channelIds:",
      '    - "123"',
      "",
      "presence:",
      "  url: http://127.0.0.1:1",
      "  agentId: testbot",
      `  keyFile: ${creds.presence}`,
      "",
      "observatory:",
      "  observatoryUrl: http://127.0.0.1:1",
      "  officeId: office",
      `  officeKeyFile: ${creds.observatory}`,
      "  agents:",
      "    - agentId: testbot",
      "",
    ]);
    mkdirSync(k, { recursive: true });
    for (const p of Object.values(creds)) writeFileSync(p, "fixture-not-a-real-secret");
    writeFileSync(join(k, "identity.pub"), "public half");
    writeFileSync(join(work, "notes.txt"), "workspace notes");
    // pi's stores live under .pi-agent (outside the workspace); a hard link
    // inside the workspace reaches the same file, so the credential check — not
    // the workspace check — is what refuses it.
    writeFileSync(join(agentDir, ".pi-agent", "auth.json"), "{}");
    writeFileSync(join(agentDir, ".pi-agent", "models.json"), "{}");
    linkSync(join(agentDir, ".pi-agent", "auth.json"), join(work, "auth-link.json"));
    linkSync(join(agentDir, ".pi-agent", "models.json"), join(work, "models-link.json"));

    const { config } = resolveRunConfig({ name: "testbot", agentsRoot });
    expect(config.credentialPathsUnavailable).toBeUndefined();
    await withReadTool(config, async (read) => {
      expect(textOf(await read("notes.txt"))).toContain("workspace notes");
      expect(textOf(await read("keys/identity.pub"))).toContain("public half");
      for (const [which, p] of Object.entries(creds)) {
        await expect(read(p), which).rejects.toThrow(CREDENTIAL);
      }
      await expect(read("auth-link.json")).rejects.toThrow(CREDENTIAL);
      await expect(read("models-link.json")).rejects.toThrow(CREDENTIAL);
    });
  });

  it("REFUSES the resident session when the credential list cannot be built (fail closed)", async () => {
    writeAgent(agentsRoot, [
      ...HEADER,
      "resident: true",
      "",
      "identity:",
      "  key_file: 12345",
      "",
      "tools:",
      "  allow:",
      "    - read",
      "",
    ]);
    const { config } = resolveRunConfig({ name: "testbot", agentsRoot });
    expect(config.credentialPaths).toBeUndefined();
    await expect(createPiRunSession(config)).rejects.toThrow(
      /credential file list is unavailable .*identity\.key_file.*drop read from tools\.allow/,
    );
  });

  it("REFUSES a hand-built resident config that carries no credential list", async () => {
    writeAgent(agentsRoot, [
      ...HEADER,
      "resident: true",
      "",
      "tools:",
      "  allow:",
      "    - read",
      "",
    ]);
    const { config } = resolveRunConfig({ name: "testbot", agentsRoot });
    const { credentialPaths: _dropped, ...withoutList } = config;
    await expect(createPiRunSession(withoutList as RunSessionConfig)).rejects.toThrow(
      /credential file list is unavailable/,
    );
  });
});

describe("the setup session keeps pi's read (bob#230 exemption, behavioural)", () => {
  let agentsRoot: string;
  let restoreEnv: () => void;
  beforeEach(() => {
    agentsRoot = realpathSync(mkdtempSync(join(tmpdir(), "bob-confined-setup-")));
    restoreEnv = snapshotEnv();
  });
  afterEach(() => {
    restoreEnv();
    rmSync(agentsRoot, { recursive: true, force: true });
  });

  it("a real onboard session of a RESIDENT agent reads the seed soul.md outside its work dir", async () => {
    const agentDir = writeAgent(agentsRoot, [
      ...HEADER,
      "resident: true",
      "",
      "tools:",
      "  allow:",
      "    - read",
      "",
    ]);
    let soulText = "";
    let sawResident: boolean | undefined;
    const res = await runOnboard({
      name: "testbot",
      role: "reviewer",
      agentDir,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      sessionRunner: async ({ config, policy }) => {
        sawResident = config.resident;
        const factory = createBobRuntimeFactory({ config, policy });
        const { session } = await factory({
          cwd: config.cwd,
          agentDir: config.piAgentDir,
          sessionManager: SessionManager.inMemory(config.cwd),
        });
        const s = session as unknown as SessionLike;
        try {
          const read = s._toolRegistry.get("read");
          if (!read) throw new Error("the setup session has no read tool");
          soulText = textOf(
            await read.execute("c", { path: config.setupSoulPath }, undefined, undefined),
          );
        } finally {
          s.dispose();
        }
        return 0;
      },
    });
    expect(res.exitCode).toBe(0);
    // The agent IS resident — the exemption, not a non-resident config, is what
    // keeps this read unconfined.
    expect(sawResident).toBe(true);
    expect(soulText).toContain("seed persona for the setup session");
  });
});
