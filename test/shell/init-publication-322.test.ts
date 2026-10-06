// bob#322: what init publishes with link(2) does not replace an existing entry.
// The competing write is injected through `beforePublish`, which runs before the
// agent directory's mkdir and before each link(2) publication.
import { afterEach, describe, expect, it } from "bun:test";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type InitOptions, initAgent } from "../../src/shell/init.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function keyedInit(root: string, extra: Partial<InitOptions> = {}) {
  return initAgent({
    name: "agent-a",
    role: "coder",
    provider: "openrouter",
    model: "fixture/model",
    contextWindow: 200_000,
    agentsRoot: root,
    skipFlair: true,
    ...extra,
  });
}

/** A keyed agent scaffolded once, with `missing` removed so the next init's
 *  existence check finds it absent. */
function scaffoldWithout(missing: "models.json" | "auth.json") {
  const root = mkdtempSync(join(tmpdir(), "bob-322-"));
  roots.push(root);
  const piDir = join(keyedInit(root).agentDir, ".pi-agent");
  rmSync(join(piDir, missing));
  return { root, piDir, path: join(piDir, missing) };
}

function tempFiles(piDir: string): string[] {
  return readdirSync(piDir).filter((name) => name.endsWith(".tmp"));
}

describe("bob#322 — keyed-row pi file publication", () => {
  for (const name of ["models.json", "auth.json"] as const) {
    it(`${name} written between the check and the publication is preserved and the init refuses`, () => {
      const { root, piDir, path } = scaffoldWithout(name);
      const competitor = Buffer.from('{"competitor":true}\n');
      const seen: string[] = [];
      expect(() =>
        keyedInit(root, {
          noClobber: false,
          beforePublish: (target) => {
            seen.push(target);
            if (target === path) writeFileSync(path, competitor);
          },
        }),
      ).toThrow(
        `bob: refusing to write ${path}: an entry already exists there and bob does not replace it. Inspect it, then re-run.`,
      );
      expect(seen).toEqual([path]);
      expect(readFileSync(path)).toEqual(competitor);
      expect(tempFiles(piDir)).toEqual([]);
    });
  }

  it("a pi file whose existence check fails is not written and its entry is left in place", () => {
    const { root, piDir } = scaffoldWithout("models.json");
    const authPath = join(piDir, "auth.json");
    rmSync(authPath);
    let caught: unknown;
    try {
      keyedInit(root, {
        noClobber: false,
        // After models.json's publication, auth.json becomes a link to itself,
        // so its existence check fails with ELOOP instead of finding it absent.
        beforePublish: (target) => {
          if (target === join(piDir, "models.json")) symlinkSync(authPath, authPath);
        },
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as NodeJS.ErrnoException | undefined)?.code).toBe("ELOOP");
    expect(lstatSync(authPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(authPath)).toBe(authPath);
    expect(tempFiles(piDir)).toEqual([]);
  });

  it("a fresh keyed init publishes both pi files with mode 0600 and no temp file", () => {
    const root = mkdtempSync(join(tmpdir(), "bob-322-"));
    roots.push(root);
    const r = keyedInit(root);
    const piDir = join(r.agentDir, ".pi-agent");
    for (const name of ["models.json", "auth.json"]) {
      const path = join(piDir, name);
      expect(r.files).toContain(path);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(JSON.parse(readFileSync(join(piDir, "models.json"), "utf8"))).toEqual({
      providers: {},
    });
    expect(JSON.parse(readFileSync(join(piDir, "auth.json"), "utf8"))).toEqual({});
    expect(tempFiles(piDir)).toEqual([]);
  });
});

function newRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "bob-322-"));
  roots.push(root);
  return root;
}

/** A non-keyed scaffold without --force. */
function scaffold(root: string, extra: Partial<InitOptions> = {}) {
  return initAgent({
    name: "agent-a",
    role: "coder",
    provider: "ollama-cloud",
    model: "fixture-model",
    contextWindow: 200_000,
    agentsRoot: root,
    skipFlair: true,
    ...extra,
  });
}

function tempFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((name) => name.endsWith(".tmp"));
}

describe("bob#322 — agent scaffold without --force", () => {
  it("an agent directory created between the check and the mkdir is refused and its contents are untouched", () => {
    const root = newRoot();
    const agentDir = join(root, "agent-a");
    const competitor = Buffer.from("competitor\n");
    expect(() =>
      scaffold(root, {
        beforePublish: (target) => {
          if (target !== agentDir) return;
          mkdirSync(agentDir);
          writeFileSync(join(agentDir, "bob.yaml"), competitor);
        },
      }),
    ).toThrow(`agent dir already exists: ${agentDir} (pass --force to overwrite)`);
    expect(readdirSync(agentDir)).toEqual(["bob.yaml"]);
    expect(readFileSync(join(agentDir, "bob.yaml"))).toEqual(competitor);
  });

  for (const rel of [
    "soul.md",
    "bob.yaml",
    join(".pi-agent", "models.json"),
    join(".pi-agent", "auth.json"),
    join("bin", "agent-a"),
  ]) {
    it(`a competing ${rel} written before its publication is preserved and the init refuses`, () => {
      const root = newRoot();
      const agentDir = join(root, "agent-a");
      const path = join(agentDir, rel);
      const competitor = Buffer.from("competitor\n");
      let injected = false;
      expect(() =>
        scaffold(root, {
          beforePublish: (target) => {
            if (target !== path) return;
            injected = true;
            writeFileSync(path, competitor);
          },
        }),
      ).toThrow(
        `bob: refusing to write ${path}: an entry already exists there and bob does not replace it. Inspect it, then re-run.`,
      );
      expect(injected).toBe(true);
      expect(readFileSync(path)).toEqual(competitor);
      expect(tempFilesUnder(agentDir)).toEqual([]);
    });
  }

  it("a keyed-row models.json that appears before its publication is refused, not skipped", () => {
    const root = newRoot();
    const agentDir = join(root, "agent-a");
    const modelsPath = join(agentDir, ".pi-agent", "models.json");
    const competitor = Buffer.from("competitor\n");
    expect(() =>
      keyedInit(root, {
        beforePublish: (target) => {
          if (target === join(agentDir, "bob.yaml")) writeFileSync(modelsPath, competitor);
        },
      }),
    ).toThrow(
      `bob: refusing to write ${modelsPath}: an entry already exists there and bob does not replace it. Inspect it, then re-run.`,
    );
    expect(readFileSync(modelsPath)).toEqual(competitor);
    expect(tempFilesUnder(agentDir)).toEqual([]);
  });

  it("an agent directory whose existence check fails is refused and left in place", () => {
    const root = newRoot();
    const agentDir = join(root, "agent-a");
    symlinkSync(agentDir, agentDir);
    let caught: unknown;
    try {
      scaffold(root);
    } catch (err) {
      caught = err;
    }
    expect((caught as NodeJS.ErrnoException | undefined)?.code).toBe("ELOOP");
    expect(lstatSync(agentDir).isSymbolicLink()).toBe(true);
    expect(readlinkSync(agentDir)).toBe(agentDir);
  });

  it("a fresh scaffold sets each file's mode and leaves no temp file", () => {
    const root = newRoot();
    // The mode writeFileSync gives a new file under this process's umask.
    const probe = join(root, "probe");
    writeFileSync(probe, "");
    const umaskMode = statSync(probe).mode & 0o777;
    const r = scaffold(root);
    const modes = Object.fromEntries(
      ["soul.md", "bob.yaml", ".pi-agent/models.json", ".pi-agent/auth.json", "bin/agent-a"].map(
        (rel) => [rel, statSync(join(r.agentDir, rel)).mode & 0o777],
      ),
    );
    expect(modes).toEqual({
      "soul.md": umaskMode,
      "bob.yaml": umaskMode,
      ".pi-agent/models.json": umaskMode,
      ".pi-agent/auth.json": 0o600,
      "bin/agent-a": 0o755,
    });
    expect(tempFilesUnder(r.agentDir)).toEqual([]);
  });
});
