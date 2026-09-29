import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertReadAllowed,
  confinedReadCustomTools,
  createConfinedReadToolDefinition,
  credentialPathsFromYaml,
  sessionCredentialPaths,
} from "../../src/shell/confined-read.js";
import { SETUP_TOOL_POLICY } from "../../src/shell/session.js";

// A throwaway workspace + an "outside" directory beside it.
let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "bob-confined-read-"));
  root = join(base, "work");
  outside = join(base, "outside");
  mkdirSync(root, { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "inside.txt"), "inside contents");
  writeFileSync(join(root, ".discord.token"), "tok-not-a-real-secret");
  writeFileSync(join(outside, "secret.txt"), "outside contents");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const textOf = (res: { content: Array<{ type: string; text?: string }> }): string =>
  res.content.map((c) => c.text ?? "").join("\n");

describe("confined read — the workspace root", () => {
  it("reads a normal file inside the workspace", async () => {
    const tool = createConfinedReadToolDefinition(root, []);
    const res = await tool.execute("c1", { path: "inside.txt" }, undefined, undefined, undefined);
    expect(textOf(res as never)).toContain("inside contents");
  });

  it("reads a file inside the workspace by ABSOLUTE path", async () => {
    const tool = createConfinedReadToolDefinition(root, []);
    const res = await tool.execute(
      "c1",
      { path: join(root, "inside.txt") },
      undefined,
      undefined,
      undefined,
    );
    expect(textOf(res as never)).toContain("inside contents");
  });

  it("REFUSES a path OUTSIDE the workspace", async () => {
    const tool = createConfinedReadToolDefinition(root, []);
    await expect(
      tool.execute("c1", { path: join(outside, "secret.txt") }, undefined, undefined, undefined),
    ).rejects.toThrow(/resolves outside the agent's workspace/);
  });

  it("REFUSES a symlink inside the workspace that points outside it", async () => {
    const link = join(root, "escape.txt");
    symlinkSync(join(outside, "secret.txt"), link);
    const tool = createConfinedReadToolDefinition(root, []);
    await expect(
      tool.execute("c1", { path: "escape.txt" }, undefined, undefined, undefined),
    ).rejects.toThrow(/resolves outside the agent's workspace/);
  });

  it("REFUSES a `..` traversal that escapes the workspace", async () => {
    const tool = createConfinedReadToolDefinition(root, []);
    await expect(
      tool.execute("c1", { path: "../outside/secret.txt" }, undefined, undefined, undefined),
    ).rejects.toThrow(/resolves outside the agent's workspace/);
  });
});

describe("confined read — credential paths", () => {
  it("REFUSES a credential path OUTSIDE the workspace (already outside, but named)", () => {
    // The outside file is refused for being outside regardless; the credential
    // check is exercised by the inside case below. This pins that a credential
    // path is never readable.
    expect(() =>
      assertReadAllowed(join(outside, "secret.txt"), {
        workspaceRoot: root,
        credentialPaths: [join(outside, "secret.txt")],
      }),
    ).toThrow(/resolves outside the agent's workspace/);
  });

  it("REFUSES a credential path placed INSIDE the workspace", async () => {
    const cred = join(root, ".discord.token");
    const tool = createConfinedReadToolDefinition(root, [cred]);
    await expect(
      tool.execute("c1", { path: ".discord.token" }, undefined, undefined, undefined),
    ).rejects.toThrow(/refusing to read ".discord.token": it is a credential path/);
  });

  it("REFUSES the provider login store inside the workspace", () => {
    const store = join(root, "auth.json");
    writeFileSync(store, "{}");
    expect(() =>
      assertReadAllowed("auth.json", { workspaceRoot: root, credentialPaths: [store] }),
    ).toThrow(/credential path/);
  });

  it("a non-credential file beside a credential still reads", async () => {
    const cred = join(root, ".discord.token");
    const tool = createConfinedReadToolDefinition(root, [cred]);
    const res = await tool.execute("c1", { path: "inside.txt" }, undefined, undefined, undefined);
    expect(textOf(res as never)).toContain("inside contents");
  });
});

describe("credentialPathsFromYaml", () => {
  it("collects every key/token file bob.yaml can name (both spellings)", () => {
    const yaml = [
      "identity:",
      "  key_file: ~/.flair/keys/me.key",
      "  pub_file: ~/.flair/keys/me.pub", // public — NOT a credential
      "flair:",
      "  keyFile: ~/.flair/keys/me.key",
      "capabilities:",
      "  - discord",
      "discord:",
      "  tokenFile: /etc/bob/discord.token",
      "  channelIds:",
      '    - "123"',
      "observatory:",
      "  officeKeyFile: /etc/bob/office.key",
      "resident: true",
      "tools:",
      "  allow:",
      "    - read",
      "",
    ].join("\n");
    const paths = credentialPathsFromYaml(yaml);
    expect(paths).toContain("~/.flair/keys/me.key");
    expect(paths).toContain("/etc/bob/discord.token");
    expect(paths).toContain("/etc/bob/office.key");
    expect(paths).not.toContain("~/.flair/keys/me.pub");
  });

  it("sessionCredentialPaths adds the provider login store", () => {
    const paths = sessionCredentialPaths("identity:\n  key_file: ~/k\n", "/agent/.pi-agent");
    expect(paths).toContain(join("/agent/.pi-agent", "auth.json"));
    expect(paths).toContain("~/k");
  });
});

describe("confinedReadCustomTools — who gets the confined read", () => {
  it("installs it for a RESIDENT session that allows read", () => {
    const tools = confinedReadCustomTools(
      { resident: true, tools: ["read", "flair_search"], excludeTools: [] },
      { cwd: root, credentialPaths: [] },
    );
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("read");
  });

  it("does NOT install it for a non-resident session (a bob run)", () => {
    expect(
      confinedReadCustomTools(
        { resident: false, tools: ["read"], excludeTools: [] },
        { cwd: root, credentialPaths: [] },
      ),
    ).toEqual([]);
  });

  it("does NOT install it when the policy does not allow read", () => {
    expect(
      confinedReadCustomTools(
        { resident: true, tools: ["flair_search"], excludeTools: [] },
        { cwd: root, credentialPaths: [] },
      ),
    ).toEqual([]);
  });

  it("the SETUP session is NOT confined: its read + write_soul policy is left alone", () => {
    // bob#230: the setup interview must read the seed soul at
    // `<agentDir>/soul.md`, outside its workspace root, and runs locally before
    // any chat surface — so it keeps pi's own read.
    expect(SETUP_TOOL_POLICY.resident).toBe(false);
    expect(SETUP_TOOL_POLICY.tools).toEqual(["read", "write_soul"]);
    expect(confinedReadCustomTools(SETUP_TOOL_POLICY, { cwd: root, credentialPaths: [] })).toEqual(
      [],
    );
  });

  it("~ is expanded when matching a requested path against the home dir", () => {
    expect(() =>
      assertReadAllowed("~", { workspaceRoot: homedir(), credentialPaths: [] }),
    ).not.toThrow();
  });
});
