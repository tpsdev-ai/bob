// Provider custody: the code-owned names this module defines are the ONLY place
// bob derives the operator keyed-row variable namespace. Nothing else in `src/`
// may name it — a source-scanner test fails on any reference outside this file,
// so the namespace cannot be entered or copied from bob's own side by accident.
//
// Three code-owned tables live here:
//
//   * the operator variable namespace (`BOB_PROVIDER_<ID>_KEY`), DERIVED from a
//     row id — an operator keyed row never declares its own variable;
//   * pi's credential env table, classified for EVERY provider in pi's catalog.
//     pi 0.84.3 does not export its credential-name list, so bob carries it and
//     a drift test keeps it aligned with `getBuiltinProviders()`. Its one
//     remaining role is the session factory's defensive removal of those names
//     from the agent environment — agents do not hold provider keys;
//   * bob's OWN environment names (launcher exports and named constants). No
//     operator variable may collide with one, and the namespace above is
//     disjoint from this set by construction.

/** The reserved namespace prefix for an operator keyed row's derived variable. */
export const OPERATOR_VARIABLE_PREFIX = "BOB_PROVIDER_";

/** The reserved namespace suffix for an operator keyed row's derived variable. */
export const OPERATOR_VARIABLE_SUFFIX = "_KEY";

/**
 * Derive an operator keyed row's environment variable from its id:
 * `BOB_PROVIDER_<ID>_KEY`, where `<ID>` is the id upper-cased with EVERY
 * character outside `[A-Z0-9]` mapped to `_` (the same rule `capabilityEnvVar`
 * uses). Validated ids may carry `.`, `-` and `_`, so three ids that differ
 * only in those characters can collide — uniqueness is checked on the DERIVED
 * name at load.
 */
export function deriveOperatorVariable(id: string): string {
  const token = id.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `${OPERATOR_VARIABLE_PREFIX}${token}${OPERATOR_VARIABLE_SUFFIX}`;
}

/** True when `name` is inside the operator keyed-row variable namespace. */
export function isOperatorVariableName(name: string): boolean {
  return name.startsWith(OPERATOR_VARIABLE_PREFIX) && name.endsWith(OPERATOR_VARIABLE_SUFFIX);
}

// ── pi's credential table, classified over pi's catalog ──────────────────────

/** The credential env names pi resolves for one catalog provider (may be empty). */
export interface PiCredentialClass {
  readonly provider: string;
  readonly variables: readonly string[];
}

/**
 * Every provider pi's catalog names, mapped to the environment variables pi
 * reads for an API key. Providers that authenticate only through OAuth, a cloud
 * profile or an ambient credential source carry no env name here. This is bob's
 * copy of pi's `env-api-keys` map; the drift test (K11) asserts every catalog
 * provider has an entry.
 */
export const PI_CREDENTIAL_TABLE: readonly PiCredentialClass[] = [
  { provider: "amazon-bedrock", variables: [] },
  { provider: "ant-ling", variables: ["ANT_LING_API_KEY"] },
  {
    provider: "anthropic",
    variables: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
  },
  { provider: "azure-openai-responses", variables: ["AZURE_OPENAI_API_KEY"] },
  { provider: "baseten", variables: ["BASETEN_API_KEY"] },
  { provider: "cerebras", variables: ["CEREBRAS_API_KEY"] },
  { provider: "cloudflare-ai-gateway", variables: ["CLOUDFLARE_API_KEY"] },
  { provider: "cloudflare-workers-ai", variables: ["CLOUDFLARE_API_KEY"] },
  { provider: "deepseek", variables: ["DEEPSEEK_API_KEY"] },
  { provider: "fireworks", variables: ["FIREWORKS_API_KEY"] },
  { provider: "github-copilot", variables: ["COPILOT_GITHUB_TOKEN"] },
  { provider: "google", variables: ["GEMINI_API_KEY"] },
  { provider: "google-vertex", variables: ["GOOGLE_CLOUD_API_KEY"] },
  { provider: "groq", variables: ["GROQ_API_KEY"] },
  { provider: "huggingface", variables: ["HF_TOKEN"] },
  { provider: "kimi-coding", variables: ["KIMI_API_KEY"] },
  { provider: "meta", variables: [] },
  { provider: "minimax", variables: ["MINIMAX_API_KEY"] },
  { provider: "minimax-cn", variables: ["MINIMAX_CN_API_KEY"] },
  { provider: "mistral", variables: ["MISTRAL_API_KEY"] },
  { provider: "moonshotai", variables: ["MOONSHOT_API_KEY"] },
  { provider: "moonshotai-cn", variables: ["MOONSHOT_API_KEY"] },
  { provider: "nvidia", variables: ["NVIDIA_API_KEY"] },
  { provider: "openai", variables: ["OPENAI_API_KEY"] },
  { provider: "openai-codex", variables: [] },
  { provider: "opencode", variables: ["OPENCODE_API_KEY"] },
  { provider: "opencode-go", variables: ["OPENCODE_API_KEY"] },
  { provider: "openrouter", variables: ["OPENROUTER_API_KEY"] },
  { provider: "qwen-token-plan", variables: ["QWEN_TOKEN_PLAN_API_KEY"] },
  { provider: "qwen-token-plan-cn", variables: ["QWEN_TOKEN_PLAN_CN_API_KEY"] },
  { provider: "qwen-token-plan-individual", variables: ["QWEN_TOKEN_PLAN_API_KEY"] },
  { provider: "radius", variables: ["RADIUS_API_KEY"] },
  { provider: "together", variables: ["TOGETHER_API_KEY"] },
  { provider: "vercel-ai-gateway", variables: ["AI_GATEWAY_API_KEY"] },
  { provider: "xai", variables: ["XAI_API_KEY"] },
  { provider: "xiaomi", variables: ["XIAOMI_API_KEY"] },
  { provider: "xiaomi-token-plan-ams", variables: ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"] },
  { provider: "xiaomi-token-plan-cn", variables: ["XIAOMI_TOKEN_PLAN_CN_API_KEY"] },
  { provider: "xiaomi-token-plan-sgp", variables: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"] },
  { provider: "zai", variables: ["ZAI_API_KEY"] },
  { provider: "zai-coding-cn", variables: ["ZAI_CODING_CN_API_KEY"] },
];

/**
 * The union of every pi credential env name, from the table. The session factory
 * removes these from the agent environment before a session's capabilities,
 * extensions, tools or child processes start: an agent does not hold a provider
 * key, and the one that needs the provider reaches it through bob's transport.
 */
export function piCredentialEnvNames(): readonly string[] {
  const names = new Set<string>();
  for (const entry of PI_CREDENTIAL_TABLE) {
    for (const name of entry.variables) names.add(name);
  }
  return [...names];
}

// ── bob's own environment names ──────────────────────────────────────────────

/** The environment names the generated launcher exports. */
export const BOB_LAUNCHER_EXPORTS: readonly string[] = [
  "PI_CODING_AGENT_DIR",
  "GIT_AUTHOR_NAME",
  "GIT_AUTHOR_EMAIL",
  "GIT_COMMITTER_NAME",
  "GIT_COMMITTER_EMAIL",
  "GH_TOKEN",
  "FLAIR_AGENT_ID",
  "FLAIR_URL",
  "FLAIR_KEY_PATH",
];

/** The named environment-name constants bob sets or reads. */
export const BOB_ENV_NAME_CONSTANTS: readonly string[] = [
  "FLAIR_ADMIN_PASS",
  "FLAIR_OPS_TARGET",
  "BOB_TASK_BINDING",
  "BOB_MAIL_TURN",
  "BOB_MAIL_TURN_PARENT",
  "BOB_PERSISTENT",
];

/** The capability-config env prefix (`BOB_CAP_<NAME>`), from capabilityEnvVar. */
export const BOB_CAPABILITY_ENV_PREFIX = "BOB_CAP_";

/**
 * True when `name` is a bob/pi/launcher-owned environment name: a launcher
 * export, a named constant, or a capability-config variable. No operator
 * keyed-row variable may collide with one.
 */
export function isBobOwnedEnvironmentName(name: string): boolean {
  return (
    BOB_LAUNCHER_EXPORTS.includes(name) ||
    BOB_ENV_NAME_CONSTANTS.includes(name) ||
    name.startsWith(BOB_CAPABILITY_ENV_PREFIX)
  );
}

/** Every code-owned bob environment name, for the disjointness drift test. */
export function bobOwnedEnvironmentNames(): readonly string[] {
  return [...BOB_LAUNCHER_EXPORTS, ...BOB_ENV_NAME_CONSTANTS];
}
