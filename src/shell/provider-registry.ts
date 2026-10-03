// The ONE provider registry: provider identity, ownership and endpoint as data.
//
// Every row carries an explicit, closed `auth` mode — there is no default and no
// inference from disk contents, placeholders or missing credentials:
//
//   bob/env(<ENV_VAR>)  bob reads the key from the environment at run time
//   bob/none            keyless: no user credential; the transport sends a fixed,
//                       non-secret placeholder Authorization header
//   bob/vm              host/VM identity (the exe.dev gateway)
//   pi/disk             pi-managed key on disk (unmigrated, until its slice)
//   pi/login            pi-managed subscription (unmigrated, until its slice)
//
// A missing or unknown mode refuses at load; the old `gateway`/`envKey` flags are
// gone and refuse if present. Endpoint eligibility, scaffold emission, the
// disk-refusal set and run resolution are all derived from these rows.
//
// `auth: bob/env(<VAR>)` is a CUSTODY CLAIM: bob loads such a row only when the
// runtime's implemented custody descriptor (CUSTODY_IMPLEMENTATIONS) matches the
// declared variable, endpoint and API. Operator data cannot assert that custody
// exists. Slice 3 generalizes the transport; slice 2 ships the load-time gate.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Document, isAlias, isMap, isSeq, type Node, parseDocument } from "yaml";
import { type ProviderRequestPolicy, REQUEST_POLICY_BOUNDS } from "./provider-request-policy.js";
import {
  isTurnReasoningMode,
  type ProviderTurnBudget,
  TURN_BUDGET_BOUNDS,
  TURN_REASONING_MODES,
} from "./provider-turn-budget.js";

/** The wire API pi uses for an OpenAI-compatible custom provider. */
export const PROVIDER_API_OPENAI_COMPLETIONS = "openai-completions";
export type ProviderApi = typeof PROVIDER_API_OPENAI_COMPLETIONS;

/** Every API flavour this slice accepts. An unknown adapter refuses at load. */
export const SUPPORTED_PROVIDER_APIS: readonly ProviderApi[] = Object.freeze([
  PROVIDER_API_OPENAI_COMPLETIONS,
]);

/**
 * The ownership/credential mode of a row. A closed union: every kind is
 * explicit, and a row with no recognised kind refuses rather than defaulting.
 */
export type ProviderAuth =
  | { readonly kind: "env"; readonly variable: string }
  | { readonly kind: "none" }
  | { readonly kind: "vm" }
  | { readonly kind: "disk" }
  | { readonly kind: "login" };

/** True when bob owns this row's credentials (env, keyless or VM identity). */
export function authIsBobOwned(auth: ProviderAuth): boolean {
  return auth.kind === "env" || auth.kind === "none" || auth.kind === "vm";
}

/** True when bob reads the key from the environment for this row. */
export function authIsKeyed(auth: ProviderAuth): boolean {
  return auth.kind === "env";
}

/** The canonical `owner/mode` label for an auth mode, e.g. `bob/env(OPENROUTER_API_KEY)`. */
export function authLabel(auth: ProviderAuth): string {
  switch (auth.kind) {
    case "env":
      return `bob/env(${auth.variable})`;
    case "none":
      return "bob/none";
    case "vm":
      return "bob/vm";
    case "disk":
      return "pi/disk";
    case "login":
      return "pi/login";
  }
}

/**
 * A keyless row's endpoint-override policy. Only an explicit `override` block
 * authorizes `provider.base_url`; `excludeHosts` names hosts the override may
 * not point at (ollama keeps its cloud-host exclusion). Disk contents never
 * select a profile.
 */
export interface ProviderOverridePolicy {
  readonly excludeHosts?: readonly string[];
}

export interface ProviderRecord {
  /** Canonical ID; bob.yaml may declare an alias. Unique. */
  readonly id: string;
  /** Other names that resolve to this record. Unique, and disjoint from every id. */
  readonly aliases: readonly string[];
  /** Include the canonical ID in ProviderConfig.name. */
  readonly configName?: boolean;
  /**
   * The runtime identity: the provider id pi resolves this provider's models
   * under. `exe-dev-gateway` and `anthropic` both use pi's `anthropic`.
   */
  readonly runtime: string;
  /** The explicit ownership/credential mode. Required; no default. */
  readonly auth: ProviderAuth;
  /** The provider's default endpoint (base URL), when it has one. */
  readonly endpoint?: string;
  /** The wire API pi uses, when the provider is an OpenAI-compatible custom provider. */
  readonly api?: ProviderApi;
  /** Present only on keyless rows: authorizes a `provider.base_url` override. */
  readonly override?: ProviderOverridePolicy;
  /** Request timeout and retry policy, from the selected row (bob#185 item 1). */
  readonly request?: ProviderRequestPolicy;
  /** Per-turn reasoning / output budget, from the selected row (bob#185 item 2). */
  readonly budget?: ProviderTurnBudget;
  readonly compatibility?: readonly string[];
}

export const PROVIDER_RECORDS = [
  {
    id: "ollama-cloud",
    configName: true,
    aliases: [],
    runtime: "ollama-cloud",
    endpoint: "https://ollama.com/v1",
    api: PROVIDER_API_OPENAI_COMPLETIONS,
    auth: { kind: "disk" },
  },
  {
    id: "ollama",
    configName: false,
    aliases: [],
    runtime: "ollama",
    endpoint: "http://localhost:11434/v1",
    api: PROVIDER_API_OPENAI_COMPLETIONS,
    auth: { kind: "none" },
    override: { excludeHosts: ["ollama.com"] },
    request: { idleTimeoutMs: 120_000, totalTimeoutMs: 1_800_000, maxRetries: 0 },
    budget: { maxOutputTokens: 4_096, reasoning: "low" },
  },
  {
    id: "ollama-newton",
    configName: true,
    aliases: [],
    runtime: "ollama-newton",
    api: PROVIDER_API_OPENAI_COMPLETIONS,
    auth: { kind: "none" },
    override: {},
    request: { idleTimeoutMs: 120_000, totalTimeoutMs: 1_800_000, maxRetries: 0 },
    budget: { maxOutputTokens: 4_096, reasoning: "low" },
  },
  {
    id: "omlx",
    configName: true,
    aliases: [],
    runtime: "omlx",
    api: PROVIDER_API_OPENAI_COMPLETIONS,
    auth: { kind: "none" },
    override: {},
    request: { idleTimeoutMs: 120_000, totalTimeoutMs: 1_800_000, maxRetries: 0 },
    budget: { maxOutputTokens: 4_096, reasoning: "low" },
  },
  {
    id: "exe-dev-gateway",
    configName: true,
    aliases: [],
    runtime: "anthropic",
    endpoint: "http://169.254.169.254/gateway/llm/anthropic",
    auth: { kind: "vm" },
  },
  { id: "anthropic", configName: true, aliases: [], runtime: "anthropic", auth: { kind: "login" } },
  { id: "openai", configName: true, aliases: [], runtime: "openai", auth: { kind: "disk" } },
  {
    id: "openrouter",
    configName: true,
    aliases: [],
    runtime: "openrouter",
    auth: { kind: "env", variable: "OPENROUTER_API_KEY" },
    endpoint: "https://openrouter.ai/api/v1",
    api: PROVIDER_API_OPENAI_COMPLETIONS,
  },
] as const satisfies readonly ProviderRecord[];

for (const row of PROVIDER_RECORDS) {
  Object.freeze(row.aliases);
  Object.freeze(row.auth);
  if ("override" in row) {
    if ("excludeHosts" in row.override) Object.freeze(row.override.excludeHosts);
    Object.freeze(row.override);
  }
  if ("request" in row) Object.freeze(row.request);
  if ("budget" in row) Object.freeze(row.budget);
  Object.freeze(row);
}
Object.freeze(PROVIDER_RECORDS);

export type ProviderName = Extract<
  (typeof PROVIDER_RECORDS)[number],
  { readonly configName: true }
>["id"];

/**
 * A code-owned custody implementation, keyed by runtime identity. A `bob/env`
 * row loads only when one of these matches its declared variable, endpoint and
 * API. Operator data cannot assert that custody exists.
 */
export interface CustodyDescriptor {
  readonly runtime: string;
  readonly variable: string;
  readonly endpoint: string;
  readonly api: ProviderApi;
}

export const CUSTODY_IMPLEMENTATIONS: readonly CustodyDescriptor[] = [
  {
    runtime: "openrouter",
    variable: "OPENROUTER_API_KEY",
    endpoint: "https://openrouter.ai/api/v1",
    api: PROVIDER_API_OPENAI_COMPLETIONS,
  },
];

for (const descriptor of CUSTODY_IMPLEMENTATIONS) Object.freeze(descriptor);
Object.freeze(CUSTODY_IMPLEMENTATIONS);

/** Runtime identities pi already owns login/subscription credentials for. */
export const PI_LOGIN_OWNED = ["openai-codex", "github-copilot", "xai", "kimi-coding"] as const;

export class ProviderRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRegistryError";
  }
}

const SAFE_NAME = /^[a-z0-9][a-z0-9._-]*$/;
const ENV_VAR = /^[A-Z_][A-Z0-9_]*$/;
const ALLOWED_FIELDS = new Set([
  "id",
  "aliases",
  "configName",
  "runtime",
  "auth",
  "endpoint",
  "api",
  "override",
  "request",
  "budget",
  "compatibility",
]);

function assertNoLegacyAuthFields(raw: Record<string, unknown>, id: string): void {
  for (const field of ["gateway", "envKey"]) {
    if (Object.hasOwn(raw, field)) {
      throw new ProviderRegistryError(
        `provider registry: row "${id}" declares the obsolete "${field}" flag — use an explicit auth mode.`,
      );
    }
  }
}

/**
 * Validate ONE row's non-identity fields against the row contract. Throws on a
 * missing/unknown auth mode, a contradictory `override` on a keyed row, an
 * unsupported adapter, or an endpoint violating its mode's policy. `keyed`
 * endpoints must be a canonical absolute HTTPS URL without userinfo, an explicit
 * port, query or fragment; keyless/VM endpoints may be HTTP or HTTPS and carry a
 * port.
 */
function validateRowFields(row: ProviderRecord): void {
  const legacy = row as unknown as Record<string, unknown>;
  assertNoLegacyAuthFields(legacy, row.id);
  for (const field of Object.keys(legacy)) {
    if (!ALLOWED_FIELDS.has(field)) {
      throw new ProviderRegistryError(`provider registry: row "${row.id}" has an unknown field.`);
    }
  }
  if (row.configName !== undefined && typeof row.configName !== "boolean") {
    throw new ProviderRegistryError(
      `provider registry: row "${row.id}" configName must be boolean.`,
    );
  }
  if (row.compatibility !== undefined) {
    if (
      !Array.isArray(row.compatibility) ||
      row.compatibility.some((name) => typeof name !== "string" || !SAFE_NAME.test(name))
    ) {
      throw new ProviderRegistryError(
        `provider registry: row "${row.id}" compatibility must be a list of names.`,
      );
    }
  }
  const auth = row.auth;
  if (
    auth === null ||
    typeof auth !== "object" ||
    Array.isArray(auth) ||
    typeof auth.kind !== "string"
  ) {
    throw new ProviderRegistryError(
      `provider registry: row "${row.id}" has no auth mode — every row requires an explicit auth.`,
    );
  }
  if (!["env", "none", "vm", "disk", "login"].includes(auth.kind)) {
    throw new ProviderRegistryError(`provider registry: row "${row.id}" has unknown auth mode.`);
  }
  for (const field of Object.keys(auth)) {
    if (field !== "kind" && !(auth.kind === "env" && field === "variable")) {
      throw new ProviderRegistryError(
        `provider registry: row "${row.id}" auth has an unknown field.`,
      );
    }
  }
  if (auth.kind === "env" && (typeof auth.variable !== "string" || !ENV_VAR.test(auth.variable))) {
    throw new ProviderRegistryError(
      `provider registry: row "${row.id}" declares bob/env with an invalid environment variable name.`,
    );
  }
  const keyed = auth.kind === "env";
  if (row.override !== undefined && auth.kind !== "none") {
    throw new ProviderRegistryError(
      `provider registry: row "${row.id}" declares an override policy but a base_url override is only allowed on a bob/none row.`,
    );
  }
  if (row.request !== undefined && auth.kind !== "none") {
    throw new ProviderRegistryError(
      `provider registry: row "${row.id}" declares a request policy but bob only enforces it on a bob/none row.`,
    );
  }
  if (row.budget !== undefined && auth.kind !== "none") {
    throw new ProviderRegistryError(
      `provider registry: row "${row.id}" declares a turn budget but bob only enforces it on a bob/none row.`,
    );
  }
  if (row.override !== undefined) {
    const policy = asRecord(row.override, "override");
    if (Object.keys(policy).some((field) => field !== "excludeHosts")) {
      throw new ProviderRegistryError(
        `provider registry: row "${row.id}" override has an unknown field.`,
      );
    }
    if (
      policy.excludeHosts !== undefined &&
      (!Array.isArray(policy.excludeHosts) ||
        policy.excludeHosts.some((host) => !validExcludedHost(host)))
    ) {
      throw new ProviderRegistryError(
        `provider registry: row "${row.id}" override.excludeHosts must be a list of canonical hosts.`,
      );
    }
  }
  if (row.api !== undefined && !SUPPORTED_PROVIDER_APIS.includes(row.api)) {
    throw new ProviderRegistryError(
      `provider registry: row "${row.id}" declares unsupported adapter/API.`,
    );
  }
  validateRequestPolicy(row.request, row.id);
  validateTurnBudget(row.budget, row.id);
  if (row.endpoint !== undefined) {
    if (typeof row.endpoint !== "string") {
      throw new ProviderRegistryError(
        `provider registry: row "${row.id}" endpoint must be a URL string.`,
      );
    }
    let url: URL;
    try {
      url = new URL(row.endpoint);
    } catch {
      throw new ProviderRegistryError(
        `provider registry: row "${row.id}" has an endpoint that is not an absolute URL.`,
      );
    }
    if (url.username !== "" || url.password !== "") {
      throw new ProviderRegistryError(
        `provider registry: row "${row.id}" endpoint must not carry credentials.`,
      );
    }
    if (url.href !== row.endpoint) {
      throw new ProviderRegistryError(
        `provider registry: row "${row.id}" endpoint is not canonical.`,
      );
    }
    if (url.search !== "" || url.hash !== "") {
      throw new ProviderRegistryError(
        `provider registry: row "${row.id}" endpoint must not contain a query or fragment.`,
      );
    }
    assertProviderEndpointAllowed(row, row.endpoint);
    if (keyed) {
      if (url.protocol !== "https:") {
        throw new ProviderRegistryError(
          `provider registry: row "${row.id}" is bob/env, so its endpoint must be HTTPS.`,
        );
      }
      if (url.port !== "") {
        throw new ProviderRegistryError(
          `provider registry: row "${row.id}" is bob/env, so its endpoint must not name an explicit port.`,
        );
      }
    } else if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ProviderRegistryError(
        `provider registry: row "${row.id}" endpoint must be HTTP or HTTPS.`,
      );
    }
  }
}

export function assertProviderEndpointAllowed(row: ProviderRecord, endpoint: string): void {
  const host = new URL(endpoint).hostname.replace(/\.+$/, "");
  if (row.auth.kind === "none" && (row.override?.excludeHosts ?? []).includes(host)) {
    throw new ProviderRegistryError(
      `provider registry: row "${row.id}" endpoint host is excluded.`,
    );
  }
}

/**
 * Validate a row's request timeout/retry policy, by row name. A nonzero total
 * cap below the minimum is refused (that is the short total timeout this change
 * removes); an out-of-bounds or non-integer field refuses rather than clamping.
 */
function validateRequestPolicy(value: unknown, id: string): void {
  if (value === undefined) return;
  const policy = asRecord(value, "request");
  for (const field of Object.keys(policy)) {
    if (field !== "idleTimeoutMs" && field !== "totalTimeoutMs" && field !== "maxRetries") {
      throw new ProviderRegistryError(
        `provider registry: row "${id}" request has an unknown field.`,
      );
    }
  }
  for (const field of ["idleTimeoutMs", "totalTimeoutMs", "maxRetries"] as const) {
    if (!Object.hasOwn(policy, field)) {
      throw new ProviderRegistryError(
        `provider registry: row "${id}" request must declare idleTimeoutMs, totalTimeoutMs and maxRetries.`,
      );
    }
  }
  const idle = policy.idleTimeoutMs;
  const bounds = REQUEST_POLICY_BOUNDS;
  if (
    typeof idle !== "number" ||
    !Number.isInteger(idle) ||
    idle < bounds.idleTimeoutMs.min ||
    idle > bounds.idleTimeoutMs.max
  ) {
    throw new ProviderRegistryError(
      `provider registry: row "${id}" request.idleTimeoutMs must be an integer within [${bounds.idleTimeoutMs.min}, ${bounds.idleTimeoutMs.max}].`,
    );
  }
  const total = policy.totalTimeoutMs;
  if (
    typeof total !== "number" ||
    !Number.isInteger(total) ||
    total < 0 ||
    (total !== 0 && (total < bounds.totalTimeoutMs.min || total > bounds.totalTimeoutMs.max))
  ) {
    throw new ProviderRegistryError(
      `provider registry: row "${id}" request.totalTimeoutMs must be 0 or an integer within [${bounds.totalTimeoutMs.min}, ${bounds.totalTimeoutMs.max}].`,
    );
  }
  const retries = policy.maxRetries;
  if (
    typeof retries !== "number" ||
    !Number.isInteger(retries) ||
    retries < bounds.maxRetries.min ||
    retries > bounds.maxRetries.max
  ) {
    throw new ProviderRegistryError(
      `provider registry: row "${id}" request.maxRetries must be an integer within [${bounds.maxRetries.min}, ${bounds.maxRetries.max}].`,
    );
  }
}

/**
 * Validate a row's per-turn reasoning / output budget, by row name. A missing
 * field, an unknown field, an out-of-bounds or non-integer cap, or an unknown
 * reasoning mode refuses rather than clamping or defaulting.
 */
function validateTurnBudget(value: unknown, id: string): void {
  if (value === undefined) return;
  const budget = asRecord(value, "budget");
  for (const field of Object.keys(budget)) {
    if (field !== "maxOutputTokens" && field !== "reasoning") {
      throw new ProviderRegistryError(
        `provider registry: row "${id}" budget has an unknown field.`,
      );
    }
  }
  for (const field of ["maxOutputTokens", "reasoning"] as const) {
    if (!Object.hasOwn(budget, field)) {
      throw new ProviderRegistryError(
        `provider registry: row "${id}" budget must declare maxOutputTokens and reasoning.`,
      );
    }
  }
  const cap = budget.maxOutputTokens;
  const bounds = TURN_BUDGET_BOUNDS.maxOutputTokens;
  if (typeof cap !== "number" || !Number.isInteger(cap) || cap < bounds.min || cap > bounds.max) {
    throw new ProviderRegistryError(
      `provider registry: row "${id}" budget.maxOutputTokens must be an integer within [${bounds.min}, ${bounds.max}].`,
    );
  }
  if (!isTurnReasoningMode(budget.reasoning)) {
    throw new ProviderRegistryError(
      `provider registry: row "${id}" budget.reasoning must be one of ${TURN_REASONING_MODES.join(", ")}.`,
    );
  }
}

function validExcludedHost(value: unknown): boolean {
  if (typeof value !== "string" || value === "") return false;
  try {
    const url = new URL(`http://${value}`);
    return (
      url.hostname === value &&
      url.host === value &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

/**
 * Validate a custody gate: every `bob/env` row must match an implemented custody
 * descriptor on runtime, variable, endpoint and API. A keyed row whose custody is
 * not implemented refuses at load, before any write or credential read.
 */
export function assertCustodyImplemented(rows: readonly ProviderRecord[]): void {
  for (const row of rows) {
    if (!authIsKeyed(row.auth)) continue;
    if (row.auth.kind !== "env") continue;
    const descriptor = CUSTODY_IMPLEMENTATIONS.find((impl) => impl.runtime === row.runtime);
    if (descriptor === undefined) {
      throw new ProviderRegistryError(
        `provider registry: row "${row.id}" has no implemented custody for its runtime.`,
      );
    }
    if (
      descriptor.variable !== row.auth.variable ||
      descriptor.endpoint !== row.endpoint ||
      descriptor.api !== row.api
    ) {
      throw new ProviderRegistryError(
        `provider registry: row "${row.id}" declares custody that does not match the implemented ${row.runtime} descriptor.`,
      );
    }
  }
}

// IDs, aliases and runtimes are unique across rows except the built-in exe-dev-gateway/anthropic pair.
export function validateProviderRecords(records: readonly ProviderRecord[]): void {
  if (!Array.isArray(records))
    throw new ProviderRegistryError("provider registry: records must be a list.");
  const owner = new Map<string, string>();
  const runtimes = new Map<string, string[]>();
  for (const record of records) {
    asRecord(record, "row");
    if (typeof record.id !== "string" || !SAFE_NAME.test(record.id)) {
      throw new ProviderRegistryError(
        `provider registry: invalid provider id — ids must match ${SAFE_NAME}.`,
      );
    }
    if (!Array.isArray(record.aliases)) {
      throw new ProviderRegistryError(
        `provider registry: row "${record.id}" aliases must be an array of names.`,
      );
    }
    for (const alias of record.aliases) {
      if (typeof alias !== "string" || !SAFE_NAME.test(alias)) {
        throw new ProviderRegistryError(
          `provider registry: row "${record.id}" has an invalid alias.`,
        );
      }
    }
    if (typeof record.runtime !== "string" || !SAFE_NAME.test(record.runtime)) {
      throw new ProviderRegistryError(
        `provider registry: row "${record.id}" has an invalid runtime identity.`,
      );
    }
    const codeOwned = PROVIDER_RECORDS.some((builtin) => builtin === record);
    if (!codeOwned) {
      for (const [field, names] of [
        ["id", [record.id]],
        ["aliases", record.aliases],
        ["runtime", [record.runtime]],
      ] as const) {
        for (const name of names) {
          if (PI_LOGIN_OWNED.some((identity) => identity === name)) {
            throw new ProviderRegistryError(
              `provider registry: row "${record.id}" ${field} collides with pi-owned identity "${name}". Remedy: choose an id, aliases and runtime outside the pi-owned namespace.`,
            );
          }
        }
      }
    }
    for (const name of [record.id, ...record.aliases]) {
      const previous = owner.get(name);
      if (previous !== undefined) {
        throw new ProviderRegistryError(
          `provider registry: duplicate identity "${name}" — declared by both "${previous}" and "${record.id}". Ids and aliases must be unique.`,
        );
      }
      owner.set(name, record.id);
    }
    runtimes.set(record.runtime, [...(runtimes.get(record.runtime) ?? []), record.id]);
    validateRowFields(record);
    if (
      !codeOwned &&
      (record.auth.kind === "disk" || record.auth.kind === "login" || record.auth.kind === "vm")
    ) {
      throw new ProviderRegistryError(
        `provider registry: row "${record.id}" auth "${authLabel(record.auth)}" is reserved for code-owned declarations. Remedy: use bob/none for a keyless row; other custody modes require a code-owned declaration.`,
      );
    }
  }
  const builtinPair = (holders: readonly string[]): boolean =>
    holders.length === 2 &&
    ["exe-dev-gateway", "anthropic"].every((id) => holders.includes(id)) &&
    ["exe-dev-gateway", "anthropic"].every(
      (id) =>
        records.find((row) => row.id === id) === PROVIDER_RECORDS.find((row) => row.id === id),
    );
  for (const [runtime, holders] of runtimes) {
    const nameOwner = owner.get(runtime);
    for (const holder of holders) {
      if (nameOwner !== undefined && nameOwner !== holder && !builtinPair([nameOwner, holder])) {
        throw new ProviderRegistryError(
          `provider registry: identity "${runtime}" is ambiguous — declared by both "${nameOwner}" and "${holder}".`,
        );
      }
    }
    if (holders.length > 1 && !builtinPair(holders)) {
      throw new ProviderRegistryError(
        `provider registry: runtime identity "${runtime}" is ambiguous — declared by ${holders.join(", ")}.`,
      );
    }
  }
  assertCustodyImplemented(records);
}

/**
 * The selected default provider per setup command. Operator data may name a
 * different `onboard`/`hire` provider; when it does not, the built-in default
 * applies. This is resolved ONCE when the registry loads and carried with it,
 * so a command never re-reads the file to find its own default.
 */
export interface ProviderDefaults {
  readonly onboard?: string;
  readonly hire?: string;
}

/** bob's built-in default selection when the operator declares none. */
export const BUILTIN_PROVIDER_DEFAULTS: Required<ProviderDefaults> = Object.freeze({
  onboard: "ollama-cloud",
  hire: "exe-dev-gateway",
});

/** A validated, indexed set of provider records. */
export class ProviderRegistry {
  readonly #byName = new Map<string, ProviderRecord>();
  readonly #records: readonly ProviderRecord[];
  readonly #defaults: Required<ProviderDefaults>;

  constructor(
    records: readonly ProviderRecord[] = PROVIDER_RECORDS,
    defaults: ProviderDefaults = {},
  ) {
    validateProviderRecords(records);
    const rawDefaults = asRecord(defaults, "defaults");
    for (const [key, value] of Object.entries(rawDefaults)) {
      if (key !== "onboard" && key !== "hire")
        throw new ProviderRegistryError("provider registry: defaults has an unknown field.");
      if (
        typeof value !== "string" ||
        !SAFE_NAME.test(value) ||
        !records.some((row) => row.id === value || row.aliases.includes(value))
      ) {
        throw new ProviderRegistryError(
          `provider registry: defaults.${key} must name a declared provider.`,
        );
      }
    }
    this.#records = Object.freeze(
      records.map((row) =>
        Object.freeze({
          ...row,
          aliases: Object.freeze([...row.aliases]),
          auth: Object.freeze({ ...row.auth }),
          ...(row.compatibility !== undefined
            ? { compatibility: Object.freeze([...row.compatibility]) }
            : {}),
          ...(row.override !== undefined
            ? {
                override: Object.freeze({
                  ...(row.override.excludeHosts !== undefined
                    ? { excludeHosts: Object.freeze([...row.override.excludeHosts]) }
                    : {}),
                }),
              }
            : {}),
          ...(row.request !== undefined ? { request: Object.freeze({ ...row.request }) } : {}),
          ...(row.budget !== undefined ? { budget: Object.freeze({ ...row.budget }) } : {}),
        }),
      ),
    );
    this.#defaults = Object.freeze({ ...BUILTIN_PROVIDER_DEFAULTS, ...defaults });
    for (const record of this.#records) {
      this.#byName.set(record.id, record);
      for (const alias of record.aliases) this.#byName.set(alias, record);
    }
    Object.freeze(this);
  }

  /** Every record, in declaration order. */
  records(): readonly ProviderRecord[] {
    return this.#records;
  }

  /** The record whose id or alias is `name`, or undefined when none declares it. */
  find(name: string): ProviderRecord | undefined {
    return this.#byName.get(name);
  }

  /** The selected default provider names (operator defaults over the builtins). */
  defaults(): Required<ProviderDefaults> {
    return this.#defaults;
  }
}

export const DEFAULT_PROVIDER_REGISTRY = new ProviderRegistry();

/** The record for `name`, or undefined when no row declares it. */
export function providerRecord(
  name: string,
  registry: ProviderRegistry = DEFAULT_PROVIDER_REGISTRY,
): ProviderRecord | undefined {
  return registry.find(name);
}

// The runtime identity pi resolves `name` under. An undeclared name (a pi
// provider, or any string bob.yaml carries) is its own runtime identity — the
// pass-through the old mappers applied.
export function resolveRuntimeProviderName(
  name: string,
  registry: ProviderRegistry = DEFAULT_PROVIDER_REGISTRY,
): string {
  return registry.find(name)?.runtime ?? name;
}

/**
 * The default provider name for a setup command, from the validated selection.
 * `onboard` is the provider a fresh agent is scaffolded onto; `hire` the one a
 * position hire defaults to when its caller names none.
 */
export function defaultProviderName(
  kind: "onboard" | "hire",
  registry: ProviderRegistry = DEFAULT_PROVIDER_REGISTRY,
): string {
  return registry.defaults()[kind];
}

/**
 * The wire API for the row whose runtime identity is `runtime`, when a row
 * declares one. The scaffold reads its emitted adapter from HERE rather than a
 * literal, so a new row's metadata reaches models.json unchanged.
 */
export function providerApiForRuntime(
  runtime: string,
  registry: ProviderRegistry = DEFAULT_PROVIDER_REGISTRY,
): ProviderApi | undefined {
  return registry.records().find((row) => row.runtime === runtime && row.api !== undefined)?.api;
}

/** The default endpoint for `name`, when its row declares one. */
export function providerEndpoint(
  name: string,
  registry: ProviderRegistry = DEFAULT_PROVIDER_REGISTRY,
): string | undefined {
  return registry.find(name)?.endpoint;
}

/** The wire API for `name`, when its row declares one. */
export function providerApiFlavour(
  name: string,
  registry: ProviderRegistry = DEFAULT_PROVIDER_REGISTRY,
): ProviderApi | undefined {
  return registry.find(name)?.api;
}

/** True when `name`'s row authenticates by host/VM identity, not an API key. */
export function providerUsesGatewayIdentity(
  name: string,
  registry: ProviderRegistry = DEFAULT_PROVIDER_REGISTRY,
): boolean {
  return registry.find(name)?.auth.kind === "vm";
}

/** True when bob reads this row's key from the environment. */
export function providerReadsKeyFromEnv(
  name: string,
  registry: ProviderRegistry = DEFAULT_PROVIDER_REGISTRY,
): boolean {
  return registry.find(name)?.auth.kind === "env";
}

/**
 * The disk-refusal set: the union of `{id, aliases, runtime}` over every
 * `bob/env` row. An own-property with one of these names under `providers` in
 * `models.json`, or at the top level of `auth.json`, refuses, regardless of
 * value — including empty, null or placeholder entries.
 */
export function reservedProviderNames(
  registry: ProviderRegistry = DEFAULT_PROVIDER_REGISTRY,
): readonly string[] {
  const names = new Set<string>();
  for (const row of registry.records()) {
    if (!authIsKeyed(row.auth)) continue;
    names.add(row.id);
    for (const alias of row.aliases) names.add(alias);
    names.add(row.runtime);
  }
  return [...names];
}

// ── Operator registry file ──────────────────────────────────────────────────

/** The default operator registry path. */
export function defaultProviderRegistryPath(): string {
  return join(homedir(), ".config", "bob", "providers.yaml");
}

export interface LoadProviderRegistryOptions {
  /** The operator registry file. Defaults to `~/.config/bob/providers.yaml`. */
  path?: string;
  /**
   * True when the caller EXPLICITLY asked for this file: a missing path then
   * refuses instead of falling back to the builtins.
   */
  explicit?: boolean;
}

interface OperatorDocument {
  version: number;
  providers: ProviderRecord[];
  defaults: { onboard?: string; hire?: string };
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    throw new ProviderRegistryError(`provider registry: ${what} must be a mapping.`);
  }
  return value as Record<string, unknown>;
}

// Parse a registry document with a REAL YAML parser (no regex grammar). Duplicate
// mapping keys, unresolved tags, aliases/anchors and merge keys are all refused
// by the parser or the walk below; a parse error refuses rather than defaulting.
function parseOperatorDocument(text: string, source: string): unknown {
  let doc: Document;
  try {
    doc = parseDocument(text, { uniqueKeys: true, schema: "core", merge: false });
  } catch {
    throw new ProviderRegistryError(`provider registry: could not parse ${source}.`);
  }
  if (doc.errors.length > 0) {
    throw new ProviderRegistryError(`provider registry: invalid ${source}.`);
  }
  if (doc.warnings.length > 0) {
    throw new ProviderRegistryError(`provider registry: unsupported tag in ${source}.`);
  }
  assertNoAliases(doc.contents, source);
  return doc.toJS({ maxAliasCount: 0 });
}

// Refuse aliases, anchors and merge keys: they make a document ambiguous, and
// the registry is a flat, explicit declaration.
function assertNoAliases(node: Node | null, source: string): void {
  if (node === null || node === undefined) return;
  if (isAlias(node) || (node as { anchor?: unknown }).anchor !== undefined) {
    throw new ProviderRegistryError(
      `provider registry: ${source} uses a YAML alias/anchor, which is not allowed.`,
    );
  }
  if (isMap(node)) {
    for (const pair of node.items) {
      const key = pair.key as Node | null;
      if (isMap(key) || isSeq(key)) assertNoAliases(key, source);
      else if (key !== null && (key as { value?: unknown }).value === "<<") {
        throw new ProviderRegistryError(
          `provider registry: ${source} uses a YAML merge key, which is not allowed.`,
        );
      }
      if (pair.key) assertNoAliases(pair.key as Node, source);
      if (pair.value) assertNoAliases(pair.value as Node, source);
    }
  } else if (isSeq(node)) {
    for (const item of node.items) assertNoAliases(item as Node, source);
  }
}

function parseAuth(value: unknown, id: string): ProviderAuth {
  if (typeof value !== "string") {
    throw new ProviderRegistryError(
      `provider registry: row "${id}" auth must be one of bob/env(<VAR>), bob/none, bob/vm, pi/disk, pi/login.`,
    );
  }
  if (value === "bob/none") return { kind: "none" };
  if (value === "bob/vm") return { kind: "vm" };
  if (value === "pi/disk") return { kind: "disk" };
  if (value === "pi/login") return { kind: "login" };
  const env = /^bob\/env\(([^()]*)\)$/.exec(value);
  if (env) return { kind: "env", variable: env[1] };
  throw new ProviderRegistryError(`provider registry: row "${id}" has unknown auth mode.`);
}

function parseOperatorRow(value: unknown, index: number): ProviderRecord {
  const raw = asRecord(value, `providers[${index}]`);
  const id = typeof raw.id === "string" && SAFE_NAME.test(raw.id) ? raw.id : `providers[${index}]`;
  assertNoLegacyAuthFields(raw, id);
  for (const key of Object.keys(raw)) {
    if (!ALLOWED_FIELDS.has(key)) {
      throw new ProviderRegistryError(`provider registry: row "${id}" has an unknown field.`);
    }
  }
  if (raw.id === undefined || raw.aliases === undefined || raw.runtime === undefined) {
    throw new ProviderRegistryError(
      `provider registry: row "${id}" must declare id, aliases, runtime and auth.`,
    );
  }
  const aliases = Array.isArray(raw.aliases) ? raw.aliases : undefined;
  if (aliases === undefined) {
    throw new ProviderRegistryError(`provider registry: row "${id}" aliases must be a list.`);
  }
  const auth = parseAuth(raw.auth, id);
  const row: ProviderRecord = {
    id: raw.id as string,
    aliases: aliases as string[],
    runtime: raw.runtime as string,
    auth,
    ...(raw.configName !== undefined ? { configName: raw.configName as boolean } : {}),
    ...(raw.endpoint !== undefined ? { endpoint: raw.endpoint as string } : {}),
    ...(raw.api !== undefined ? { api: raw.api as ProviderApi } : {}),
    ...(raw.override !== undefined ? { override: raw.override as ProviderOverridePolicy } : {}),
    ...(raw.request !== undefined ? { request: raw.request as ProviderRequestPolicy } : {}),
    ...(raw.budget !== undefined ? { budget: raw.budget as ProviderTurnBudget } : {}),
    ...(raw.compatibility !== undefined ? { compatibility: raw.compatibility as string[] } : {}),
  };
  return row;
}

function parseOperatorDocumentValue(value: unknown, source: string): OperatorDocument {
  const raw = asRecord(value, "the registry document");
  for (const key of Object.keys(raw)) {
    if (!["version", "providers", "defaults"].includes(key)) {
      throw new ProviderRegistryError(`provider registry: ${source} has an unknown field.`);
    }
  }
  if (raw.version !== 1) {
    throw new ProviderRegistryError(`provider registry: ${source} version must be 1.`);
  }
  if (!Array.isArray(raw.providers)) {
    throw new ProviderRegistryError(`provider registry: ${source} providers must be a list.`);
  }
  const providers = raw.providers.map((row, i) => parseOperatorRow(row, i));
  const defaults: OperatorDocument["defaults"] = {};
  if (raw.defaults !== undefined) {
    const d = asRecord(raw.defaults, `${source} defaults`);
    for (const key of Object.keys(d)) {
      if (key !== "onboard" && key !== "hire") {
        throw new ProviderRegistryError(
          `provider registry: ${source} defaults has an unknown field.`,
        );
      }
    }
    if (d.onboard !== undefined) {
      if (typeof d.onboard !== "string") {
        throw new ProviderRegistryError(
          `provider registry: ${source} defaults.onboard must be a name.`,
        );
      }
      defaults.onboard = d.onboard;
    }
    if (d.hire !== undefined) {
      if (typeof d.hire !== "string") {
        throw new ProviderRegistryError(
          `provider registry: ${source} defaults.hire must be a name.`,
        );
      }
      defaults.hire = d.hire;
    }
  }
  return { version: 1, providers, defaults };
}

/**
 * Load the operator registry file. An ABSENT default file uses the classified
 * builtins; an explicitly requested missing file, an unreadable file, a parse
 * error or an invalid document refuses. Every row (selected or not) is validated
 * before the registry is returned, so nothing unvalidated can reach a write or a
 * credential read.
 */
export function loadProviderRegistry(opts: LoadProviderRegistryOptions = {}): ProviderRegistry {
  const path = opts.path ?? defaultProviderRegistryPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT" && opts.explicit !== true) {
      return new ProviderRegistry();
    }
    throw new ProviderRegistryError(`provider registry: could not read ${path}.`);
  }
  const parsed = parseOperatorDocument(text, path);
  const doc = parseOperatorDocumentValue(parsed, path);
  const builtins = PROVIDER_RECORDS as readonly ProviderRecord[];
  const combined = [...builtins, ...doc.providers];
  const registry = new ProviderRegistry(combined, doc.defaults);
  return registry;
}
