// Provider-aware REQUEST timeouts and retry policy, carried by the SELECTED
// provider row (bob#185 item 1).
//
// The measured problem: an OpenAI-compatible request carried one total timeout
// (cloud-sized). On a local model that generates for minutes the total timeout
// fired mid-generation, and the request was retried, discarding the tokens
// already produced. This module turns the row into the source of the policy:
//
//   * idleTimeoutMs — abort when no response data has arrived for this long
//     (queued + prefill + inter-token gaps). Reset on every streamed chunk.
//   * totalTimeoutMs — a generous hard cap on the whole request; 0 disables it.
//   * maxRetries — provider-level blind retries; 0 means never, so a timed-out
//     generation is surfaced (not thrown away and silently retried).
//
// A timed-out generation is an ERROR, surfaced with the provider, the elapsed
// time and the remedy; it is never retried by the policy itself. This module
// owns the timeout mechanism; the row owns the values (validated at load by
// provider-registry.ts).

/** A row's request timeout and retry policy. Every field is required. */
export interface ProviderRequestPolicy {
  /** No-data idle timeout in ms (queued, prefill and inter-chunk gaps). 0 disables. */
  readonly idleTimeoutMs: number;
  /** Hard cap on the whole request in ms. 0 disables. */
  readonly totalTimeoutMs: number;
  /** Provider-level blind retries. 0 means none. */
  readonly maxRetries: number;
}

/**
 * The validated bounds for a policy an operator may declare. `totalTimeoutMs`
 * additionally accepts 0 (disabled); a nonzero value below the minimum is a
 * short total timeout, which is what this change exists to remove.
 */
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
      `bob: provider stream idle timeout — provider "${provider}" sent no data for ${formatMs(idleTimeoutMs)}; the timed-out generation was not retried. Remedy: raise this row's request.idleTimeoutMs, or check the endpoint.`,
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
      `bob: provider request timeout — provider "${provider}" exceeded its ${formatMs(totalTimeoutMs)} total request cap; the timed-out generation was not retried. Remedy: raise this row's request.totalTimeoutMs, or check the endpoint.`,
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

/**
 * Wrap a fetch so the request it makes carries the row's idle and total
 * timeouts. The idle timer is armed before the request (covering queue + first
 * token) and re-armed on every streamed chunk; the total timer is armed once.
 * On either firing the underlying request is aborted with the NAMED error, so
 * the caller surfaces it (and, with maxRetries 0, does not retry it).
 *
 * Headers, method, body and the caller's own AbortSignal are preserved.
 */
export function withStreamTimeouts(
  baseFetch: typeof globalThis.fetch,
  policy: ProviderRequestPolicy,
  provider: string,
  timers: TimerSeam = systemTimers,
): typeof globalThis.fetch {
  const wrapped = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const controller = new AbortController();
    const callerSignal = init?.signal ?? undefined;
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
    const armIdle = () => {
      if (policy.idleTimeoutMs <= 0) return;
      disarmIdle();
      idleHandle = timers.setTimeout(() => {
        controller.abort(new ProviderStreamIdleTimeoutError(provider, policy.idleTimeoutMs));
      }, policy.idleTimeoutMs);
    };

    if (policy.totalTimeoutMs > 0) {
      totalHandle = timers.setTimeout(() => {
        controller.abort(new ProviderRequestTimeoutError(provider, policy.totalTimeoutMs));
      }, policy.totalTimeoutMs);
    }
    armIdle();

    let response: Response;
    try {
      response = await baseFetch(input, { ...init, signal: controller.signal });
    } catch (err) {
      cleanup();
      throw err;
    }

    const originalBody = response.body;
    if (originalBody === null) {
      cleanup();
      return response;
    }

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
          controller.error(err);
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
