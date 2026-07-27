// Turning a blessed capability's `piPackage` into something pi's resource
// loader can actually load — the step where "blessed" becomes "on disk".
//
// WHY THIS EXISTS AT ALL. pi's resource loader takes extension *sources*, not
// packages, and it is quiet about the ones it can't find: a source that doesn't
// resolve is recorded on `getExtensions().errors` and skipped, so an agent boots
// with none of its declared tools and says nothing about it. Bob therefore
// resolves the package itself, here, so "the capability's package isn't
// installed" is a named, actionable error at session setup instead of a silently
// under-equipped agent.
//
// HOW. Node ESM package resolution (`import.meta.resolve`) from *this* module,
// which lives inside @tpsdev-ai/bob-shell. That is the one mechanism that
// behaves identically in the two shapes this code has to work in:
//
//   monorepo   packages/shell/src/capability-resolve.ts
//                → packages/cap-discord/dist/index.js            (workspace link)
//   published  node_modules/@tpsdev-ai/bob-shell/dist/capability-resolve.js
//                → node_modules/@tpsdev-ai/bob-cap-discord/dist/index.js
//
// ONE code path in both, deliberately. A dev-only fallback branch would mean
// local development never exercises what a user runs — which is exactly how the
// original defect survived: the catalog blessed a path that could only ever
// resolve inside a checkout, and nothing in the monorepo could tell.
//
// Alternatives, rejected on measurement rather than taste:
//   * `require.resolve` — the capability packages declare only `import`/`types`
//     conditions in `exports`, so CJS resolution throws
//     ERR_PACKAGE_PATH_NOT_EXPORTED under node; under bun it fails to see the
//     workspace link at all. Measured against this repo's own packages.
//   * `npm:` specs — pi resolves those by shelling out to `npm install` at
//     session start: network on the agent boot path, a writable managed dir, and
//     a silent skip whenever pi is in offline mode. A capability Bob ships
//     should not be fetched at run time.
//   * plain `import()` — hands back a module object; pi's loader wants a path
//     and owns the extension lifecycle (jiti load, hooks, disposal).

import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

// Sources pi's own package resolver owns end to end. Bob passes these through
// untouched — resolving them here would duplicate (and second-guess) pi.
function isPiOwnedSource(spec: string): boolean {
  return spec.startsWith("npm:") || spec.startsWith("git:") || spec.includes("://");
}

// A path source rather than a package specifier. Node's rule, not ours.
function isPathSource(spec: string): boolean {
  return isAbsolute(spec) || spec.startsWith("./") || spec.startsWith("../");
}

function missingPackageError(capability: string, pkg: string): Error {
  return new Error(
    [
      `capability "${capability}" needs the package ${pkg}, which is not installed.`,
      "",
      "Bob ships this capability as a dependency, so a missing package usually means a",
      "partial or hand-assembled install. Either reinstall bob, or add the package:",
      "",
      `  npm install ${pkg}`,
      "",
      `To run the agent without it, remove "${capability}" from capabilities: in bob.yaml.`,
    ].join("\n"),
  );
}

function unbuiltPackageError(capability: string, pkg: string, path: string): Error {
  return new Error(
    [
      `capability "${capability}" resolved ${pkg} to ${path}, but that file does not exist.`,
      "",
      "The package is installed but has no build output. In a bob checkout, run:",
      "",
      "  bun run build",
    ].join("\n"),
  );
}

function missingPathError(capability: string, path: string): Error {
  return new Error(
    [
      `capability "${capability}" is blessed as the extension file ${path}, which does not exist.`,
      "",
      "This is a bob packaging fault, not a configuration one — the installed",
      "@tpsdev-ai/bob-shell is missing a file it ships. Reinstall bob.",
    ].join("\n"),
  );
}

// Resolve one capability's `piPackage` to a source pi's resource loader can
// load. Bare package specifiers become absolute file paths; paths are checked
// for existence; npm:/git: sources are pi's to resolve and pass through.
//
// Throws — never returns a source Bob has reason to believe pi will drop. The
// throw is the whole point: it converts "agent came up without its tools" into
// "here is the package you are missing and how to install it".
export function resolveExtensionSource(capability: string, spec: string): string {
  if (isPiOwnedSource(spec)) return spec;

  if (isPathSource(spec)) {
    // Relative paths are resolved by pi against the settings file that declared
    // them; Bob has no such base, so only absolute paths are checkable here.
    if (isAbsolute(spec) && !existsSync(spec)) throw missingPathError(capability, spec);
    return spec;
  }

  let resolvedUrl: string;
  try {
    resolvedUrl = import.meta.resolve(spec);
  } catch {
    throw missingPackageError(capability, spec);
  }

  let path: string;
  try {
    path = fileURLToPath(resolvedUrl);
  } catch {
    // Resolved to something that isn't a file: URL (a node:/data: builtin, say).
    // Not loadable as a pi extension, and not a case any real capability hits.
    throw missingPackageError(capability, spec);
  }

  // `import.meta.resolve` can succeed on a package whose entry point hasn't been
  // built yet — the exports map is a declaration, not a guarantee. Check, so an
  // unbuilt checkout says "run bun run build" rather than dropping the tools.
  if (!existsSync(path)) throw unbuiltPackageError(capability, spec, path);

  return path;
}
