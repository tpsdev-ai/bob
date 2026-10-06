// bob#322: a keyed-row init does not replace a pi file entry that appeared
// between its existence check and the publication.
// The competing write is injected through `beforePublish`, which runs after the
// check and the temp write, immediately before publication.
import { afterEach, describe, expect, it } from "bun:test";
import {
  lstatSync,
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
        `bob: refusing to write ${path}: an entry already exists there and bob does not replace it; it was left unchanged. Inspect it, then re-run.`,
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
