// Turning a blessed capability's `piPackage` specifier into a file pi's
// resource loader can actually load — the step where "blessed" becomes "on
// disk".
//
// WHY THIS EXISTS AT ALL. pi's resource loader takes extension *sources*, not
// packages, and it is quiet about the ones it can't find: a source that doesn't
// resolve is recorded on `getExtensions().errors` and skipped, so an agent boots
// with none of its declared tools and says nothing about it. Bob therefore
// resolves the extension itself, here, so "the capability's extension isn't on
// disk" is a named, actionable error at session setup instead of a silently
// under-equipped agent.
//
// HOW. Node ESM *self-reference* resolution: every capability is blessed as
// `@tpsdev-ai/bob/capabilities/<name>`, which is this package's own name, and
// `import.meta.resolve` maps it through the `exports` block in package.json.
// Self-reference works from any module inside the package, which means one
// mechanism covers every shape this code runs in:
//
//   checkout, from source   src/shell/capability-resolve.ts
//   checkout, built         dist/shell/capability-resolve.js
//   published install       node_modules/@tpsdev-ai/bob/dist/shell/…
//
// and in all three it lands on the SAME target — the built
// dist/capabilities/<name>/index.js — because the `exports` map is the single
// declaration of where a capability lives. Measured under node and under bun.
//
// ONE code path, deliberately, with no branch that only a checkout takes. A
// dev-only fallback would mean local development never exercises what a user
// runs — which is exactly how the original defect survived: the catalog blessed
// a path that could only ever resolve inside a checkout, and nothing in the
// monorepo could tell. Here, a broken `exports` map fails the unit tests in a
// checkout for the same reason it would fail a user's install.
//
// Alternatives, rejected on measurement rather than taste:
//   * A path relative to this module (`../capabilities/<name>/index.js`) — the
//     source tree and the built tree differ in file extension (.ts vs .js), so
//     it needs a "which tree am I in" branch. That is the dev-only fallback
//     shape, reintroduced.
//   * `require.resolve` — the package declares only `import` conditions in
//     `exports`, so CJS resolution throws ERR_PACKAGE_PATH_NOT_EXPORTED.
//   * `npm:` specs — pi resolves those by shelling out to `npm install` at
//     session start: network on the agent boot path, a writable managed dir, and
//     a silent skip whenever pi is in offline mode. A capability Bob ships
//     inside its own tarball must never be fetched at run time.
//   * plain `import()` — hands back a module object; pi's loader wants a path
//     and owns the extension lifecycle (jiti load, hooks, disposal).

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// ONE error for the one thing that can actually go wrong: the capability's
// built extension is not present in this install.
//
// Deliberately not split into "specifier didn't resolve" vs "resolved but the
// file is missing", because the two runtimes disagree about which of those a
// missing capability IS. Measured: for a specifier the `exports` pattern
// matches but nothing is built at,
//
//   node  resolves happily and hands back a path to a file that isn't there
//   bun   throws ERR_MODULE_NOT_FOUND out of import.meta.resolve
//
// Bob runs under node (bin/bob) and its tests run under bun, so a split message
// would be right in one and misleading in the other — the exact shape of bug
// that only shows up in a user's install. One message, both remedies, correct
// under both.
function missingExtensionError(capability: string, spec: string, path?: string): Error {
  return new Error(
    [
      `capability "${capability}" is blessed as ${spec}, but its extension is not present in this install.`,
      ...(path ? [`Expected it at: ${path}`] : []),
      "",
      "Every blessed capability ships inside @tpsdev-ai/bob, so this is a bob",
      "packaging fault rather than a configuration one. In a bob checkout the",
      "capability has not been compiled yet:",
      "",
      "  bun run build",
      "",
      "In an installed bob the tarball is missing a file it ships — reinstall:",
      "",
      "  npm install -g @tpsdev-ai/bob",
      "",
      `To run the agent without it, remove "${capability}" from capabilities: in bob.yaml.`,
    ].join("\n"),
  );
}

// Resolve one capability's `piPackage` specifier to the absolute path of its
// built extension entry point.
//
// Throws — never returns a source Bob has reason to believe pi will drop. The
// throw is the whole point: it converts "agent came up without its tools" into
// a named capability and a remedy.
export function resolveExtensionSource(capability: string, spec: string): string {
  let resolvedUrl: string;
  try {
    resolvedUrl = import.meta.resolve(spec);
  } catch {
    throw missingExtensionError(capability, spec);
  }

  let path: string;
  try {
    path = fileURLToPath(resolvedUrl);
  } catch {
    // Resolved to something that isn't a file: URL (a node:/data: builtin, say).
    // Not loadable as a pi extension, and not a case any blessed capability hits.
    throw missingExtensionError(capability, spec);
  }

  // `import.meta.resolve` can succeed on a target that hasn't been built yet —
  // under node the exports map is a declaration, not a guarantee. Check, so an
  // unbuilt checkout reports it rather than dropping the capability's tools.
  if (!existsSync(path)) throw missingExtensionError(capability, spec, path);

  return path;
}
