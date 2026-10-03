/** A row's request timeout and retry policy. Every field is required. */
export interface ProviderRequestPolicy {
  /** Idle timeout in ms, including queue, prefill and gaps between received chunks. */
  readonly idleTimeoutMs: number;
  /** Hard cap on the whole request in ms. 0 disables. */
  readonly totalTimeoutMs: number;
  /** Provider request retries. 0 means none. */
  readonly maxRetries: number;
}

export const REQUEST_POLICY_BOUNDS = Object.freeze({
  idleTimeoutMs: Object.freeze({ min: 1_000, max: 600_000 }),
  totalTimeoutMs: Object.freeze({ min: 900_000, max: 86_400_000 }),
  maxRetries: Object.freeze({ min: 0, max: 5 }),
});

function formatMs(ms: number): string {
  if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} min`;
  if (ms >= 1_000 && ms % 1_000 === 0) return `${ms / 1_000} s`;
  return `${ms} ms`;
}

/** The named error for a stream that went idle past the row's idle timeout. */
export class ProviderStreamIdleTimeoutError extends Error {
  readonly provider: string;
  readonly idleTimeoutMs: number;
  constructor(provider: string, idleTimeoutMs: number) {
    super(
      `bob: provider stream idle timeout — provider "${provider}" sent no data for ${formatMs(idleTimeoutMs)}. Remedy: raise this row's request.idleTimeoutMs, or check the endpoint.`,
    );
    this.name = "ProviderStreamIdleTimeoutError";
    this.provider = provider;
    this.idleTimeoutMs = idleTimeoutMs;
  }
}

/** The named error for a request that exceeded the row's total cap. */
export class ProviderRequestTimeoutError extends Error {
  readonly provider: string;
  readonly totalTimeoutMs: number;
  constructor(provider: string, totalTimeoutMs: number) {
    super(
      `bob: provider request timeout — provider "${provider}" exceeded its ${formatMs(totalTimeoutMs)} total request cap. Remedy: raise this row's request.totalTimeoutMs, or check the endpoint.`,
    );
    this.name = "ProviderRequestTimeoutError";
    this.provider = provider;
    this.totalTimeoutMs = totalTimeoutMs;
  }
}

interface TimerSeam {
  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const systemTimers: TimerSeam = { setTimeout, clearTimeout };

export function withStreamTimeouts(
  baseFetch: typeof globalThis.fetch,
  policy: ProviderRequestPolicy,
  provider: string,
  timers: TimerSeam = systemTimers,
  onTimeout?: (error: ProviderStreamIdleTimeoutError | ProviderRequestTimeoutError) => void,
): typeof globalThis.fetch {
  const wrapped = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const controller = new AbortController();
    const callerSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    const onCallerAbort = () => controller.abort(callerSignal?.reason);
    if (callerSignal !== undefined) {
      if (callerSignal.aborted) controller.abort(callerSignal.reason);
      else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    let idleHandle: ReturnType<typeof setTimeout> | undefined;
    let totalHandle: ReturnType<typeof setTimeout> | undefined;
    const disarmIdle = () => {
      if (idleHandle !== undefined) {
        timers.clearTimeout(idleHandle);
        idleHandle = undefined;
      }
    };
    const cleanup = () => {
      disarmIdle();
      if (totalHandle !== undefined) {
        timers.clearTimeout(totalHandle);
        totalHandle = undefined;
      }
      callerSignal?.removeEventListener("abort", onCallerAbort);
    };
    const abortTimeout = (error: ProviderStreamIdleTimeoutError | ProviderRequestTimeoutError) => {
      onTimeout?.(error);
      controller.abort(error);
    };
    const armIdle = () => {
      if (policy.idleTimeoutMs <= 0) return;
      disarmIdle();
      idleHandle = timers.setTimeout(() => {
        abortTimeout(new ProviderStreamIdleTimeoutError(provider, policy.idleTimeoutMs));
      }, policy.idleTimeoutMs);
    };

    if (policy.totalTimeoutMs > 0) {
      totalHandle = timers.setTimeout(() => {
        abortTimeout(new ProviderRequestTimeoutError(provider, policy.totalTimeoutMs));
      }, policy.totalTimeoutMs);
    }
    armIdle();

    let response: Response;
    try {
      response = await baseFetch(input, { ...init, signal: controller.signal });
    } catch (err) {
      cleanup();
      throw controller.signal.aborted ? controller.signal.reason : err;
    }

    const originalBody = response.body;
    if (originalBody === null) {
      cleanup();
      return response;
    }

    const controllerSignal = controller.signal;
    const reader = originalBody.getReader();
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            cleanup();
            controller.close();
            return;
          }
          armIdle();
          controller.enqueue(value);
        } catch (err) {
          cleanup();
          controller.error(controllerSignal.aborted ? controllerSignal.reason : err);
        }
      },
      cancel(reason) {
        cleanup();
        return reader.cancel(reason);
      },
    });

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };
  return wrapped as typeof globalThis.fetch;
}
