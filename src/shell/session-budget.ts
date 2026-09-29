// bob#214 — the pure (pi-free) half of the model budget: the config values a
// role (role.json `session`) or an agent (bob.yaml `provider:` / `session:`)
// declares, and their validation. The pi-facing half is model-budget.ts; this
// module is kept free of pi so the bob.yaml and role readers can use it.

/** The thinking levels a role or bob.yaml may name (bob#214). */
export const THINKING_SETTINGS = ["off", "low", "high"] as const;
export type ThinkingSetting = (typeof THINKING_SETTINGS)[number];

/** The model limits declared in bob.yaml's `provider:` block, bound to the
 *  provider/model pair they describe (pi's provider id, already mapped). */
export interface ModelLimits {
  provider: string;
  model: string;
  /** The context window the SERVER enforces for this model, in tokens. */
  contextWindow: number;
  /** Per-request output cap in tokens. Absent: pi's own model maxTokens. */
  maxOutputTokens?: number;
}

/** pi's default for the tokens kept verbatim after a compaction (pi 0.84.3
 *  `DEFAULT_COMPACTION_SETTINGS.keepRecentTokens`). A threshold at or below it
 *  would compact without shrinking anything. */
export const PI_KEEP_RECENT_TOKENS = 20_000;

/** A config value bob refuses, naming where it came from and the fix. */
export class ModelBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelBudgetError";
  }
}

/** A positive integer token count, or undefined for "not a positive integer". */
export function positiveTokens(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) return undefined;
  return value;
}

/**
 * The compaction threshold as a fraction of the context window, strictly
 * between 0 and 1 ("0.5" or 0.5). Anything else is undefined — a caller turns
 * that into a refusal naming the key.
 */
export function parseCompactionThreshold(value: unknown): number | undefined {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value : "";
  if (!/^0?\.[0-9]+$/.test(text.trim())) return undefined;
  const n = Number(text.trim());
  return Number.isFinite(n) && n > 0 && n < 1 ? n : undefined;
}

/** One of THINKING_SETTINGS, or undefined. */
export function parseThinkingSetting(value: unknown): ThinkingSetting | undefined {
  return typeof value === "string" && (THINKING_SETTINGS as readonly string[]).includes(value)
    ? (value as ThinkingSetting)
    : undefined;
}

/** The session-budget keys a role (role.json `session`) or an agent (bob.yaml
 *  `session:`) may set. Unknown keys are refused by the readers. */
export const SESSION_BUDGET_KEYS = ["compaction_threshold", "thinking"] as const;

export interface SessionBudget {
  compactionThreshold?: number;
  thinking?: ThinkingSetting;
}

/**
 * Validate a raw session-budget object (role.json `session`, or bob.yaml's
 * `session:` block after readBlock). `where` names the source for the error.
 * Unknown keys and malformed values THROW; an absent key stays absent.
 */
export function parseSessionBudget(raw: Record<string, unknown>, where: string): SessionBudget {
  const out: SessionBudget = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!(SESSION_BUDGET_KEYS as readonly string[]).includes(key)) {
      throw new ModelBudgetError(
        `${where}: unknown key "${key}" — supported keys are ${SESSION_BUDGET_KEYS.join(", ")}.`,
      );
    }
    if (key === "compaction_threshold") {
      const t = parseCompactionThreshold(value);
      if (t === undefined) {
        throw new ModelBudgetError(
          `${where}: "compaction_threshold" must be a fraction of the context window strictly between 0 and 1 (for example 0.5).`,
        );
      }
      out.compactionThreshold = t;
    } else {
      const level = parseThinkingSetting(value);
      if (level === undefined) {
        throw new ModelBudgetError(
          `${where}: "thinking" must be one of ${THINKING_SETTINGS.join(", ")}.`,
        );
      }
      out.thinking = level;
    }
  }
  return out;
}
