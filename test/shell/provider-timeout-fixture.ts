export const SSE_CHUNK = (content: string, finish: string | null) =>
  `data: ${JSON.stringify({
    id: "1",
    choices: [{ index: 0, delta: { content }, finish_reason: finish }],
  })}\n\n`;
export const SSE_DONE = "data: [DONE]\n\n";

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

export function memoryServer(options: {
  headersDelayMs?: number;
  status?: number;
  chunks?: number;
  chunkDelayMs?: number;
  stall?: boolean;
}) {
  let requests = 0;
  const fetch = (async (_url: unknown, init?: RequestInit) => {
    requests += 1;
    const signal = init?.signal ?? undefined;
    await sleep(options.headersDelayMs ?? 0, signal);
    if (options.status !== undefined) {
      return new Response(JSON.stringify({ error: { message: "unavailable" } }), {
        status: options.status,
        headers: { "content-type": "application/json", "retry-after-ms": "1" },
      });
    }
    const encoder = new TextEncoder();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    let count = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const abort = () => {
          if (ended) return;
          ended = true;
          clearTimeout(timer);
          controller.error(signal?.reason);
        };
        signal?.addEventListener("abort", abort, { once: true });
        const send = () => {
          if (ended) return;
          controller.enqueue(encoder.encode(SSE_CHUNK(`tok${count++}`, null)));
          if (options.stall) return;
          if (count < (options.chunks ?? 1)) {
            timer = setTimeout(send, options.chunkDelayMs ?? 0);
          } else {
            ended = true;
            signal?.removeEventListener("abort", abort);
            controller.enqueue(encoder.encode(SSE_CHUNK("", "stop") + SSE_DONE));
            controller.close();
          }
        };
        if (signal?.aborted) abort();
        else send();
      },
      cancel() {
        ended = true;
        clearTimeout(timer);
      },
    });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    get requests() {
      return requests;
    },
  };
}
