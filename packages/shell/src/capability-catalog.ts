// Bob's blessed capability catalog — the thin curation/trust layer pi doesn't
// ship (spec §4, decision "both"). An agent's `bob.yaml capabilities:` entries
// resolve against this map; only blessed names are allowed in the fleet, and
// this is the K&S gate for what capability packages an agent may load.
//
// pi owns the actual tool/hook *registry* — this is NOT that. It's a name →
// manifest lookup so Bob knows which pi package a capability resolves to and how
// to validate its config block, before handing the package to pi's loader.
//
// PR2 ships the MECHANISM. Only the `fixture` capability is implemented (it
// proves the loader). The real capabilities are listed as `notYetImplemented`
// so the catalog documents the intended fleet surface; resolving one is a hard
// error until its package lands in a later PR.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { BobCapabilityManifest, CatalogEntry } from "./capability.js";

// Absolute path to the fixture capability extension that ships with this
// package (under examples/cap-fixture/). Resolved relative to this module so it
// works from both source (bun/jiti) and the compiled dist/ layout.
//
// dist/ layout:  <pkg>/dist/capability-catalog.js  → ../examples/cap-fixture
// src/ layout:   <pkg>/src/capability-catalog.ts    → ../examples/cap-fixture
const fixtureExtensionPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "examples",
  "cap-fixture",
  "index.ts",
);

// Absolute path to the discord capability's pi extension. It's a real,
// publishable package (packages/cap-discord) but is blessed here as a LOCAL
// path for phase 1 — exactly like the fixture — until it's published as
// `npm:@tpsdev-ai/bob-cap-discord`. We point at the source `index.ts` (pi loads
// extensions via jiti, no build needed). The path is the same relative to both
// the src/ and dist/ layout of this module:
//   src/  layout: packages/shell/src/capability-catalog.ts  → ../../cap-discord/src/index.ts
//   dist/ layout: packages/shell/dist/capability-catalog.js  → ../../cap-discord/src/index.ts
const discordExtensionPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "cap-discord",
  "src",
  "index.ts",
);

// Absolute path to the flair (memory) capability's pi extension. Same blessing
// pattern as discord: a real publishable package (packages/cap-flair) pointed at
// as a LOCAL source path for phase 1 until it's published as
// `npm:@tpsdev-ai/bob-cap-flair`.
const flairExtensionPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "cap-flair",
  "src",
  "index.ts",
);

// Absolute path to the observatory (team-view producer) capability's pi
// extension. Same blessing pattern as discord/flair: a real publishable package
// (packages/cap-observatory) pointed at as a LOCAL source path for phase 1 until
// it's published as `npm:@tpsdev-ai/bob-cap-observatory`.
const observatoryExtensionPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "cap-observatory",
  "src",
  "index.ts",
);

// The discord capability's config schema, mirrored here so the catalog can
// pre-validate an agent's bob.yaml `discord:` block. Kept in sync with
// packages/cap-discord/src/config.ts CONFIG_SCHEMA (defined inline rather than
// imported to avoid the shell package depending on cap-discord — the fixture's
// manifest is handled the same way). channelIds is REQUIRED + non-empty: the
// channel allow-list is the trust boundary, so a discord capability with no
// allow-list must fail config validation, not run wide open.
const discordConfigSchema = Type.Object(
  {
    tokenFile: Type.String({ minLength: 1 }),
    channelIds: Type.Array(Type.String({ pattern: "^[0-9]+$" }), { minItems: 1 }),
    botUserId: Type.Optional(Type.String({ pattern: "^[0-9]+$" })),
    dispatchAll: Type.Optional(Type.Boolean()),
    model: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

const discordManifest: BobCapabilityManifest = {
  name: "discord",
  piPackage: discordExtensionPath,
  configSchema: discordConfigSchema,
  provides: {
    tools: ["discord_reply", "discord_react", "discord_fetch"],
    serves: true,
  },
};

// The flair capability's config schema, mirrored here (kept in sync with
// packages/cap-flair/src/config.ts CONFIG_SCHEMA) so the catalog can pre-validate
// an agent's bob.yaml `flair:` block. keyFile is a PATH — the private key is
// never inlined; additionalProperties:false fails closed on a stray secret.
const flairConfigSchema = Type.Object(
  {
    url: Type.String({ minLength: 1 }),
    agentId: Type.String({ minLength: 1, pattern: "^[a-z0-9-]+$" }),
    keyFile: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const flairManifest: BobCapabilityManifest = {
  name: "flair",
  piPackage: flairExtensionPath,
  configSchema: flairConfigSchema,
  provides: {
    tools: ["flair_search", "flair_write", "flair_get"],
    serves: false,
  },
};

// The observatory capability's config schema, mirrored here (kept in sync with
// packages/cap-observatory/src/config.ts CONFIG_SCHEMA) so the catalog can
// pre-validate an agent's bob.yaml `observatory:` block. officeKeyFile is a PATH
// — the OFFICE key is never inlined; additionalProperties:false fails closed on a
// stray secret. The snapshot-source `agents:` array is required + non-empty (an
// office reports at least one agent).
const observatorySnapshotSourceSchema = Type.Object(
  {
    agentId: Type.String({ minLength: 1, pattern: "^[a-z0-9-]+$" }),
    name: Type.Optional(Type.String()),
    role: Type.Optional(Type.String()),
    model: Type.Optional(Type.String()),
    type: Type.Optional(Type.Union([Type.Literal("agent"), Type.Literal("human")])),
    beadsFile: Type.Optional(Type.String()),
    heartbeatFile: Type.Optional(Type.String()),
  },
  { additionalProperties: false },
);

const observatoryConfigSchema = Type.Object(
  {
    observatoryUrl: Type.String({ minLength: 1 }),
    officeId: Type.String({ minLength: 1, pattern: "^[a-z0-9-]+$" }),
    officeKeyFile: Type.String({ minLength: 1 }),
    staleThresholdSeconds: Type.Optional(Type.Integer({ minimum: 1 })),
    agents: Type.Array(observatorySnapshotSourceSchema, { minItems: 1 }),
  },
  { additionalProperties: false },
);

const observatoryManifest: BobCapabilityManifest = {
  name: "observatory",
  piPackage: observatoryExtensionPath,
  configSchema: observatoryConfigSchema,
  provides: {
    tools: ["observatory_report"],
    serves: false,
  },
};

// The fixture's manifest, with its piPackage resolved to the absolute on-disk
// path. (Defined here rather than imported from examples/ so the compiled dist
// doesn't depend on a file outside rootDir; the fixture's manifest.ts mirrors
// this for standalone use.)
const fixtureManifest: BobCapabilityManifest = {
  name: "fixture",
  piPackage: fixtureExtensionPath,
  configSchema: Type.Object({
    greeting: Type.Optional(
      Type.String({ description: "Optional greeting the fixture would log." }),
    ),
  }),
  provides: { tools: ["bob_fixture_noop"], serves: false },
};

// Planned capabilities whose packages don't exist yet (later PRs). Listed so
// the catalog documents the intended fleet surface and `bob doctor` can show
// "blessed but unbuilt". configSchema is a permissive placeholder until the
// real package defines it; resolving any of these is rejected (see resolver).
function placeholder(name: string, provides: BobCapabilityManifest["provides"]): CatalogEntry {
  return {
    manifest: {
      name,
      piPackage: `npm:@tpsdev-ai/bob-cap-${name}`,
      configSchema: Type.Object({}, { additionalProperties: true }),
      provides,
    },
    notYetImplemented: true,
  };
}

// The catalog. Keyed by capability name. Adding a capability = add an entry
// (and, for real ones, ship its pi-extension package); zero loader edits.
export const BLESSED_CATALOG: Readonly<Record<string, CatalogEntry>> = Object.freeze({
  fixture: { manifest: fixtureManifest },
  // Discord is REAL as of PR3 (packages/cap-discord), blessed as a local path.
  discord: { manifest: discordManifest },
  // Flair memory is REAL (packages/cap-flair), blessed as a local path.
  flair: { manifest: flairManifest },
  // Observatory (team-view producer) is REAL (packages/cap-observatory), blessed
  // as a local path.
  observatory: { manifest: observatoryManifest },
  // --- planned, not yet implemented (later PRs) ---
  mail: placeholder("mail", { tools: ["mail_send"], serves: true }),
  heartbeat: placeholder("heartbeat", { serves: true }),
});

// Look up a capability by name. Returns undefined when the name isn't blessed.
export function lookupCapability(name: string): CatalogEntry | undefined {
  return BLESSED_CATALOG[name];
}
