// The provider registry — ONE table of provider identity records.
//
// Before this module, a bob provider name was mapped to pi's provider id in
// two hand-written mappers (init.ts's `resolvePiProvider`, run.ts's
// `mapBobProviderToPi`), and the same names were special-cased again for
// endpoints, OpenAI compatibility, OpenRouter ownership and the gateway's
// VM-identity placeholder. Each of those lists had to be kept in step with the
// others by hand.
//
// Here each provider is ONE row: its stable id (the name bob.yaml declares),
// its aliases, its runtime identity (the id pi resolves its models under), its
// default endpoint and its API flavour. init's scaffold and run's resolution
// both READ this table, so a row's alias and endpoint reach both without an
// edit to either mapper.
//
// This is a behaviour-preserving extraction (bob#186, slice 1): the records
// below reproduce the behaviour the old mappers and special-cases held.
// Transport, disk refusal, key custody and endpoint eligibility are NOT decided
// here — those are later slices.

/** The wire API pi must use for a provider that is not one of pi's built-ins. */
export const PROVIDER_API_OPENAI_COMPLETIONS = "openai-completions";
export type ProviderApi = typeof PROVIDER_API_OPENAI_COMPLETIONS;

export interface ProviderRecord {
  /** The stable id, as written in bob.yaml's `provider.name`. Unique. */
  readonly id: string;
  /** Other names that resolve to this record. Unique, and disjoint from every id. */
  readonly aliases: readonly string[];
  /**
   * The runtime identity: the provider id pi resolves this provider's models
   * under. `exe-dev-gateway` and `anthropic` both use pi's `anthropic` today;
   * the transport slices give the gateway its own identity.
   */
  readonly runtime: string;
  /** The provider's fixed endpoint (base URL), when it has one. */
  readonly endpoint?: string;
  /** The wire API pi must use, when the provider is not one of pi's built-ins. */
  readonly api?: ProviderApi;
  /** The endpoint authenticates by host/VM identity, so it carries no API key. */
  readonly gateway?: boolean;
  /**
   * The credential is read from the environment at run time and never written
   * to disk, so the scaffold writes no provider block and no auth entry.
   */
  readonly envKey?: boolean;
}

// bob's provider surface, reproducing the mappings that lived in init.ts and
// run.ts. `ollama` is listed because init's scaffold emits the ollama.com
// endpoint for it, even though it was not one of the names ProviderConfig's
// union narrowed to.
export const PROVIDER_RECORDS = [
  {
    id: "ollama-cloud",
    aliases: [],
    runtime: "ollama-cloud",
    endpoint: "https://ollama.com/v1",
    api: PROVIDER_API_OPENAI_COMPLETIONS,
  },
  {
    id: "ollama",
    aliases: [],
    runtime: "ollama",
    endpoint: "https://ollama.com/v1",
    api: PROVIDER_API_OPENAI_COMPLETIONS,
  },
  { id: "ollama-newton", aliases: [], runtime: "ollama-newton" },
  { id: "omlx", aliases: [], runtime: "omlx" },
  {
    id: "exe-dev-gateway",
    aliases: [],
    runtime: "anthropic",
    endpoint: "http://169.254.169.254/gateway/llm/anthropic",
    gateway: true,
  },
  { id: "anthropic", aliases: [], runtime: "anthropic" },
  { id: "openai", aliases: [], runtime: "openai" },
  { id: "openrouter", aliases: [], runtime: "openrouter", envKey: true },
] as const satisfies readonly ProviderRecord[];

/** The provider names the registry declares — derived from the table above. */
export type ProviderName = (typeof PROVIDER_RECORDS)[number]["id"];

export class ProviderRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderRegistryError";
  }
}

// Every id and alias names exactly one record. A name declared twice cannot be
// resolved, so it fails at load, naming the name and both holders — not later,
// when a lookup silently answers with whichever row won.
export function validateProviderRecords(records: readonly ProviderRecord[]): void {
  const owner = new Map<string, string>();
  for (const record of records) {
    for (const name of [record.id, ...record.aliases]) {
      const previous = owner.get(name);
      if (previous !== undefined) {
        throw new ProviderRegistryError(
          `provider registry: duplicate identity "${name}" — declared by both "${previous}" and "${record.id}". Ids and aliases must be unique.`,
        );
      }
      owner.set(name, record.id);
    }
  }
}

/** A validated, indexed set of provider records. */
export class ProviderRegistry {
  readonly #byName = new Map<string, ProviderRecord>();

  constructor(records: readonly ProviderRecord[] = PROVIDER_RECORDS) {
    validateProviderRecords(records);
    for (const record of records) {
      this.#byName.set(record.id, record);
      for (const alias of record.aliases) this.#byName.set(alias, record);
    }
  }

  /** The record whose id or alias is `name`, or undefined when none declares it. */
  find(name: string): ProviderRecord | undefined {
    return this.#byName.get(name);
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
  return registry.find(name)?.gateway === true;
}

/** True when `name`'s row reads its credential from the environment at run time. */
export function providerReadsKeyFromEnv(
  name: string,
  registry: ProviderRegistry = DEFAULT_PROVIDER_REGISTRY,
): boolean {
  return registry.find(name)?.envKey === true;
}
