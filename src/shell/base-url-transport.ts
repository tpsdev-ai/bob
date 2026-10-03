import { lazyStream } from "@earendil-works/pi-ai";
import {
  stream as openaiStream,
  streamSimple as openaiStreamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type ProviderRequestPolicy, withStreamTimeouts } from "./provider-request-policy.js";
import type { ProviderTurnBudget } from "./provider-turn-budget.js";

export const BASE_URL_PLACEHOLDER = "bob-base-url-placeholder-not-a-secret";

export function installBaseUrlTransport(
  runtime: ModelRuntime,
  provider: string,
  baseUrl: string,
  request?: ProviderRequestPolicy,
  budget?: ProviderTurnBudget,
): void {
  const originalAuth = runtime.getAuth.bind(runtime);
  runtime.getAuth = (async (selected, options) => {
    const selectedProvider = typeof selected === "string" ? selected : selected.provider;
    if (selectedProvider === provider) {
      return { auth: { apiKey: BASE_URL_PLACEHOLDER }, source: "bob" };
    }
    return originalAuth(selected as never, options);
  }) as ModelRuntime["getAuth"];
  const originalRefresh = runtime.refresh.bind(runtime);
  runtime.refresh = (options) => originalRefresh({ ...options, allowNetwork: false });
  const baseFetch = globalThis.fetch;
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const guardedFetch: typeof globalThis.fetch = async (url, init) => {
    if ((typeof url !== "string" && !(url instanceof URL)) || String(url) !== endpoint) {
      throw new Error("bob: refusing a provider.base_url request outside the scaffold endpoint");
    }
    const response = await baseFetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        authorization: `Bearer ${BASE_URL_PLACEHOLDER}`,
      },
      redirect: "error",
    });
    if (response.status >= 300 && response.status < 400) {
      throw new Error("bob: refusing a provider.base_url redirect");
    }
    return response;
  };
  // The row's request timeout/retry policy (bob#185 item 1) is enforced on the
  // request fetch: an idle timer that resets on every chunk and a generous total
  // cap. A row with no policy keeps the previous behaviour exactly.
  const requestFetch =
    request === undefined ? guardedFetch : withStreamTimeouts(guardedFetch, request, provider);

  const send = (
    delegate: typeof openaiStreamSimple,
    model: Parameters<ModelRuntime["streamSimple"]>[0],
    context: Parameters<ModelRuntime["streamSimple"]>[1],
    options: object | undefined,
  ) => {
    if (model.baseUrl !== baseUrl || model.api !== "openai-completions") {
      throw new Error("bob: run bob models <agent> to apply provider.base_url");
    }
    // bob owns the timeouts and retries when the row carries a policy: the
    // request carries no SDK total timeout, and the retry count is the row's (the
    // builtin local rows set 0).
    const {
      timeoutMs: _droppedTimeout,
      maxRetries: _droppedRetries,
      maxTokens: _droppedMaxTokens,
      reasoning: _droppedReasoning,
      ...rest
    } = (options ?? {}) as Record<string, unknown>;
    // bob#185 item 2: the row's per-turn budget replaces the request's output
    // cap and thinking level. The cap is pi's `maxTokens`, which the OpenAI-
    // compatible adapter sends in the provider's own field; a lower per-agent
    // output cap (model.maxTokens) still wins. A reasoning level needs a model
    // pi treats as reasoning-capable with reasoning effort enabled — the row's
    // keyless model is otherwise scaffolded non-reasoning — so the level is
    // handed to pi as its own thinking level and pi shapes it for the provider.
    const modelCap = (model as { maxTokens?: unknown }).maxTokens;
    const turnCap =
      budget === undefined
        ? undefined
        : typeof modelCap === "number" && Number.isFinite(modelCap) && modelCap > 0
          ? Math.min(budget.maxOutputTokens, modelCap)
          : budget.maxOutputTokens;
    const delegateModel =
      budget === undefined
        ? ({ ...model, headers: undefined } as never)
        : ({
            ...model,
            headers: undefined,
            reasoning: budget.reasoning !== "off",
            compat: {
              ...((model as { compat?: Record<string, unknown> }).compat ?? {}),
              supportsDeveloperRole: false,
              supportsReasoningEffort: true,
            },
          } as never);
    return delegate(delegateModel, context, {
      ...rest,
      ...(request !== undefined ? { timeoutMs: undefined, maxRetries: request.maxRetries } : {}),
      ...(budget !== undefined ? { maxTokens: turnCap, reasoning: budget.reasoning } : {}),
      apiKey: BASE_URL_PLACEHOLDER,
      headers: undefined,
      env: {},
      fetch: requestFetch,
    } as never);
  };

  // These request verbs survive pi's provider recomposition during refresh.
  const originalSimple = runtime.streamSimple.bind(runtime);
  runtime.streamSimple = (model, context, options) =>
    model.provider === provider || model.baseUrl === baseUrl
      ? lazyStream(model, async () => send(openaiStreamSimple, model, context, options))
      : originalSimple(model, context, options);
  const originalStream = runtime.stream.bind(runtime);
  runtime.stream = (model, context, options) =>
    model.provider === provider || model.baseUrl === baseUrl
      ? lazyStream(model, async () =>
          send(openaiStream as typeof openaiStreamSimple, model, context, options),
        )
      : originalStream(model, context, options);
  const originalFetchDeferred = runtime.fetchDeferred.bind(runtime);
  runtime.fetchDeferred = async (model, handle, options) => {
    if (model.provider === provider || model.baseUrl === baseUrl) {
      throw new Error("bob: provider.base_url does not support deferred requests");
    }
    return originalFetchDeferred(model, handle, options);
  };
  const originalCancelDeferred = runtime.cancelDeferred.bind(runtime);
  runtime.cancelDeferred = async (model, handle, options) => {
    if (model.provider === provider || model.baseUrl === baseUrl) {
      throw new Error("bob: provider.base_url does not support deferred requests");
    }
    return originalCancelDeferred(model, handle, options);
  };
}
