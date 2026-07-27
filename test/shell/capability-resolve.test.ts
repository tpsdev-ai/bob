import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { BLESSED_CATALOG } from "../../src/shell/capability-catalog.js";
import { resolveExtensionSource } from "../../src/shell/capability-resolve.js";

describe("resolveExtensionSource — blessed capability specifiers", () => {
  // The regression test for the defect this mechanism exists to prevent. A
  // capability must resolve to an absolute path to a file that EXISTS. It runs
  // here against the source tree and, in a published install, against
  // node_modules — one code path, because both go through the SAME `exports`
  // map in package.json.
  it("resolves a capability to an absolute path that exists", () => {
    const path = resolveExtensionSource("flair", "@tpsdev-ai/bob/capabilities/flair");
    expect(isAbsolute(path)).toBe(true);
    expect(existsSync(path)).toBe(true);
    // The BUILT extension, not source. `src/` is not published.
    expect(path.endsWith("/dist/capabilities/flair/index.js")).toBe(true);
  });

  // Every implemented capability, driven off the catalog itself rather than a
  // hand-kept list — so a capability added to the catalog without a built
  // extension fails here instead of in a user's install.
  it("resolves every implemented capability in the blessed catalog", () => {
    const implemented = Object.entries(BLESSED_CATALOG).filter(
      ([, entry]) => !entry.notYetImplemented,
    );
    expect(implemented.length).toBeGreaterThanOrEqual(4);
    for (const [name, entry] of implemented) {
      const path = resolveExtensionSource(name, entry.manifest.piPackage);
      expect(existsSync(path), `${name} → ${path}`).toBe(true);
    }
  });
});

describe("resolveExtensionSource — a capability whose extension isn't there", () => {
  // The case that matters more than the happy path: what a user sees. Every
  // capability ships inside bob, so an absent one is a broken install or an
  // unbuilt checkout, and the message has to say so rather than surface a bare
  // ERR_MODULE_NOT_FOUND.
  //
  // Both inputs below are the SAME failure — a capability with no built
  // extension. node and bun disagree about whether that shows up as a failed
  // resolve or a resolved-but-absent path, so the message must be identical
  // either way. That is what these two cases pin.
  for (const [label, spec] of [
    ["a name the exports pattern matches", "@tpsdev-ai/bob/capabilities/ghost"],
    ["a subpath the exports map has no entry for", "@tpsdev-ai/bob/no-such-subpath"],
  ] as const) {
    it(`names the capability and both remedies — ${label}`, () => {
      let err: Error | undefined;
      try {
        resolveExtensionSource("ghost", spec);
      } catch (e) {
        err = e as Error;
      }
      expect(err).toBeDefined();
      const msg = err?.message ?? "";
      expect(msg).toContain('capability "ghost"');
      expect(msg).toContain(spec);
      expect(msg).toContain("not present in this install");
      expect(msg).toContain("bun run build");
      expect(msg).toContain("npm install -g @tpsdev-ai/bob");
      // And how to proceed without it.
      expect(msg).toContain("bob.yaml");
      // Not a bare module-resolution stack trace.
      expect(msg).not.toContain("ERR_MODULE_NOT_FOUND");
    });
  }
});
