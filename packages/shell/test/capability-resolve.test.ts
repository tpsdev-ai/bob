import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveExtensionSource } from "../src/capability-resolve.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REAL_FILE = resolve(HERE, "..", "examples", "cap-fixture", "index.ts");

describe("resolveExtensionSource — package specifiers", () => {
  // The regression test for the defect. A capability blessed as a package name
  // must come back as an absolute path to a file that EXISTS. This passes in the
  // monorepo via the workspace link and in a published install via the installed
  // package — same code path, which is the point.
  it("resolves a capability package to an absolute path that exists", () => {
    const path = resolveExtensionSource("flair", "@tpsdev-ai/bob-cap-flair");
    expect(isAbsolute(path)).toBe(true);
    expect(existsSync(path)).toBe(true);
    // The shipped entry point, not source. `src/` is not published.
    expect(path.endsWith("/dist/index.js")).toBe(true);
  });

  it("resolves every real capability in the blessed catalog", () => {
    for (const [name, pkg] of [
      ["discord", "@tpsdev-ai/bob-cap-discord"],
      ["flair", "@tpsdev-ai/bob-cap-flair"],
      ["observatory", "@tpsdev-ai/bob-cap-observatory"],
    ] as const) {
      const path = resolveExtensionSource(name, pkg);
      expect(existsSync(path), `${name} → ${path}`).toBe(true);
    }
  });
});

describe("resolveExtensionSource — a capability package that isn't installed", () => {
  // The case that matters more than the happy path: what a user sees. It must
  // name the package and the command, not throw ERR_MODULE_NOT_FOUND at them.
  it("names the missing package and how to install it", () => {
    let err: Error | undefined;
    try {
      resolveExtensionSource("discord", "@tpsdev-ai/bob-cap-not-a-real-package");
    } catch (e) {
      err = e as Error;
    }
    expect(err).toBeDefined();
    const msg = err?.message ?? "";
    expect(msg).toContain('capability "discord"');
    expect(msg).toContain("@tpsdev-ai/bob-cap-not-a-real-package");
    expect(msg).toContain("is not installed");
    expect(msg).toContain("npm install @tpsdev-ai/bob-cap-not-a-real-package");
    // And how to proceed without it.
    expect(msg).toContain("bob.yaml");
    // Not a bare module-resolution stack trace.
    expect(msg).not.toContain("ERR_MODULE_NOT_FOUND");
  });
});

describe("resolveExtensionSource — path and pi-owned sources", () => {
  it("passes an existing absolute path through unchanged", () => {
    expect(resolveExtensionSource("fixture", REAL_FILE)).toBe(REAL_FILE);
  });

  it("rejects an absolute path that does not exist", () => {
    // pi would silently skip this; Bob refuses to hand it over.
    expect(() => resolveExtensionSource("fixture", "/no/such/extension.ts")).toThrow(
      /does not exist/,
    );
  });

  it("passes npm: and git: sources through for pi to resolve", () => {
    expect(resolveExtensionSource("x", "npm:@scope/thing@1.2.3")).toBe("npm:@scope/thing@1.2.3");
    expect(resolveExtensionSource("x", "git:github.com/o/r@v1")).toBe("git:github.com/o/r@v1");
  });
});
