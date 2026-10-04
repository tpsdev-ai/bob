import { createAssistantMessageEventStream, lazyStream } from "@earendil-works/pi-ai";
import {
  stream as openaiStream,
  streamSimple as openaiStreamSimple,
} from "@earendil-works/pi-ai/api/openai-completions";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  type ProviderRequestPolicy,
  type ProviderRequestTimeoutError,
  type ProviderStreamIdleTimeoutError,
  withStreamTimeouts,
} from "./provider-request-policy.js";
import { boundedOutputCap, type ProviderTurnBudget } from "./provider-turn-budget.js";

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
  const send = (
    delegate: typeof openaiStreamSimple,
    model: Parameters<ModelRuntime["streamSimple"]>[0],
    context: Parameters<ModelRuntime["streamSimple"]>[1],
    options: object | undefined,
  ) => {
    if (model.baseUrl !== baseUrl || model.api !== "openai-completions") {
      throw new Error("bob: run bob models <agent> to apply provider.base_url");
    }
    const controller = new AbortController();
    const supplied = (options ?? {}) as Record<string, unknown>;
    const callerSignal = supplied.signal as AbortSignal | undefined;
    let timeoutError: ProviderStreamIdleTimeoutError | ProviderRequestTimeoutError | undefined;
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    if (request !== undefined) {
      if (callerSignal?.aborted) onCallerAbort();
      else callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
    }
    const requestFetch =
      request === undefined
        ? guardedFetch
        : withStreamTimeouts(guardedFetch, request, provider, undefined, (error) => {
            timeoutError = error;
            controller.abort(error);
          });
    // bob#185 item 2: the row's per-turn budget sets the request's thinking
    // level and names `max_tokens` as its output-cap field. The row's keyless
    // model is scaffolded non-reasoning, so a budget marks it reasoning-capable
    // for pi to send the level.
    // bob#306: the request's output cap stays at or below the smaller of the
    // budget and the model's maxTokens (boundedOutputCap).
    const maxTokens =
      budget === undefined
        ? undefined
        : boundedOutputCap(budget.maxOutputTokens, model.maxTokens, supplied.maxTokens);
    const delegateModel =
      budget === undefined
        ? { ...model, headers: undefined }
        : {
            ...model,
            headers: undefined,
            reasoning: budget.reasoning !== "off",
            compat: {
              ...((model as { compat?: Record<string, unknown> }).compat ?? {}),
              supportsDeveloperRole: false,
              supportsReasoningEffort: true,
              maxTokensField: "max_tokens",
            },
          };
    const source = delegate(delegateModel as never, context, {
      ...supplied,
      ...(request !== undefined
        ? { timeoutMs: 2_147_483_647, maxRetries: request.maxRetries, signal: controller.signal }
        : {}),
      ...(budget !== undefined
        ? {
            maxTokens,
            reasoning: budget.reasoning,
            reasoningEffort: budget.reasoning === "off" ? undefined : budget.reasoning,
          }
        : {}),
      apiKey: BASE_URL_PLACEHOLDER,
      headers: undefined,
      env: {},
      fetch: requestFetch,
    } as never);
    if (request === undefined) return source;
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        for await (const event of source) {
          if (event.type === "error" && timeoutError !== undefined) {
            event.error.stopReason = "error";
            event.error.errorMessage = `${timeoutError.name}: ${timeoutError.message}`;
            stream.push({ ...event, reason: "error" });
          } else {
            stream.push(event);
          }
        }
      } finally {
        callerSignal?.removeEventListener("abort", onCallerAbort);
        stream.end();
      }
    })();
    return stream;
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
