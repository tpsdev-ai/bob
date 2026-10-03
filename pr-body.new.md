Refs #185 (item 2 — a reasoning / output budget per turn for local providers).

## What changed

A keyless provider row may declare an optional `budget: {maxOutputTokens, reasoning}`. As with `request`, a budget on any other row refuses at load.

- bob hands `maxOutputTokens` to pi as `maxTokens`; pi's OpenAI-compatible adapter sends it as `max_completion_tokens` (or `max_tokens` where the model's compat selects it). A lower per-agent output cap still wins.
- bob hands `reasoning` to pi as its thinking level; the adapter sends it as `reasoning_effort`. `off` sends none.
- Whether Ollama's and omlx's OpenAI-compatible endpoints honour `max_completion_tokens` and `reasoning_effort` is not verified here: neither server's source is in this repo or its dependencies, and pi's docs set `supportsReasoningEffort: false` in their Ollama examples.
- The built-in keyless rows (`ollama`, `ollama-newton`, `omlx`) declare a 4096-token cap and the `low` level; rows without a budget pass their options through unchanged.
- `maxOutputTokens` is in [256, 131072]; `reasoning` is one of off/minimal/low/medium/high. An out-of-bounds, non-integer, incomplete or unknown budget refuses at load by row name.
- A request that ends with stop reason `length` carries `outputCap` (the row's `maxOutputTokens`) in the run log's request-usage record.
- The budget is layered on #301's transport: its timeout, retry and pass-through behaviour is unchanged.

## Evidence

Measured on HEAD_AFTER_APPLY (origin/main 68ed8df8 merged).

- `test/shell/provider-turn-budget-185.test.ts`: 15 pass. With the #301 timeout tests (`provider-request-timeouts-185`, `provider-timeouts-185`, `provider-legacy-timeout-185`) and `provider-controls-297`: 120 pass / 0 fail. The fake-server tests capture the outgoing request body on loopback; no network leaves the host.
- `bun run lint` (`biome check .`): exit 0, 0 errors.
- `bun run typecheck`: exit 0. `bun run build`: exit 0.
- `node scripts/changelog-fragments.mjs check`: exit 0.
- Full suite (`bun run test`) in a sandbox that refuses writes under the home directory: 2686 pass / 5 skip / 90 fail; origin/main 68ed8df8 in the same sandbox: 2671 pass / 5 skip / 90 fail, the same 90 failing tests.
