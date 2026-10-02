// The fetch core (bob#245 — web spec v3, slice R1b). It is an INTERNAL module:
// it registers no tool, and nothing wires it to a session's config yet (slice
// R1c builds the `web_fetch` tool on it).
//
// THE CONNECTION. One owned, direct undici Agent is built per hop and
// destroyed before the next hop. Its connector's `lookup` is vettedLookup: it
// resolves names, vets EVERY answer against the address policy, and hands
// those same answers to the socket — so the checked address is the one connected
// to. A canonical literal is vetted in admitUrl before dispatch. The
// global dispatcher is never used, no proxy dispatcher is ever built, and the
// proxy environment is never read.
//
// THE REQUEST. GET only. The headers bob sets are a fixed `bob/<version>`
// User-Agent and a fixed Accept (undici adds Host and Connection): no cookies,
// no Authorization, no referer, and no caller-supplied header — there is no
// option for one.
//
// REDIRECTS. Followed here, by hand, at most five, each target re-admitted
// through admitUrl (scheme, port, userinfo, zone, downgrade, canonical literal)
// and each named hop uses a new connection with a fresh vetted DNS lookup.
// Canonical literals are vetted at admission. A redirect status without a
// Location is returned as the final response.
//
// LIMITS. One 15-second deadline covers every hop, the body read, decoding,
// extraction, and the final success path. Bodies skipped on redirects or
// rejected content types are destroyed. Accepted final responses have separate
// 5 MB encoded and decoded caps, enforced while streaming before extraction.
// The text is the operator's ceiling (web.fetch_max_chars, at most 100,000)
// unless the caller asked for less; a cut is reported.

import { type LookupAddress, type LookupOptions, lookup as nodeLookup } from "node:dns";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { Agent, request } from "undici";
import { type AddressPolicy, publicUnicastPolicy } from "./address.js";
import { FETCH_MAX_CHARS_CEILING } from "./config.js";
import type { WebSettings } from "./core.js";
import { isWebFetchError, WebFetchError } from "./errors.js";
import {
  ALLOWED_CONTENT_TYPES,
  allowedContentType,
  extractText,
  mediaTypeOf,
  truncateText,
} from "./extract.js";
import { addressRefused, admitUrl, type UrlPolicy, WEB_PORTS } from "./url-admission.js";

// One deadline for the whole operation, including decoding and extraction.
export const TOTAL_DEADLINE_MS = 15_000;
// At most five redirects (five targets beyond the URL that was given).
export const MAX_REDIRECTS = 5;
// The encoded body cap and the decoded body cap, each 5 MB.
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
// The redirect statuses this core follows.
export const REDIRECT_STATUSES: readonly number[] = Object.freeze([301, 302, 303, 307, 308]);
// The one Accept header a fetch sends.
export const ACCEPT_HEADER = ALLOWED_CONTENT_TYPES.join(", ");

// bob's version, for the fixed User-Agent. Read once, from bob's own
// package.json: a version that cannot be read is an install fault, and the
// User-Agent is fixed, so this refuses rather than sending a guessed one.
function readBobVersion(): string {
  const text = readFileSync(new URL("../../../package.json", import.meta.url), "utf8");
  const parsed = JSON.parse(text) as { version?: unknown };
  if (typeof parsed.version !== "string" || parsed.version === "") {
    throw new Error("web fetch core: bob's package.json has no version");
  }
  return parsed.version;
}

export const USER_AGENT = `bob/${readBobVersion()}`;

// The character limit for one fetch: the operator's ceiling, or the caller's
// request when that is lower. Never zero, never above the operator's ceiling,
// and never above the schema's absolute ceiling.
export function resolveMaxChars(requested: number | undefined, operatorCeiling: number): number {
  const ceiling = Math.min(Math.max(1, Math.trunc(operatorCeiling)), FETCH_MAX_CHARS_CEILING);
  if (requested === undefined || !Number.isFinite(requested)) return ceiling;
  return Math.max(1, Math.min(Math.trunc(requested), ceiling));
}

// The DNS lookup seam: node's dns.lookup signature as `net.connect` (and so
// undici's connector) calls it.
export type DnsLookup = (
  hostname: string,
  options: LookupOptions,
  callback: (
    error: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

// A lookup that vets every answer and refuses the whole request when any one is
// refused. `net.connect` calls this with `all: true`, and the answers that come
// back are the addresses it may use — none other, so there is no second
// resolution to race.
export function vettedLookup(base: DnsLookup, policy: AddressPolicy): DnsLookup {
  return (hostname, options, callback) => {
    base(hostname, { ...options, all: true, verbatim: true }, (error, addresses, family) => {
      // net reads only the error when one is set, so no address is handed back
      // on that path.
      const fail = (refusal: NodeJS.ErrnoException | WebFetchError): void =>
        callback(refusal, undefined as unknown as string);
      if (error) {
        fail(error);
        return;
      }
      const list: LookupAddress[] = Array.isArray(addresses)
        ? addresses
        : addresses === undefined || addresses === ""
          ? []
          : [{ address: addresses, family: family ?? 0 }];
      if (list.length === 0) {
        const empty: NodeJS.ErrnoException = new Error(`DNS returned no address for ${hostname}`);
        empty.code = "ENOTFOUND";
        fail(empty);
        return;
      }
      for (const answer of list) {
        const verdict = policy.classify(answer.address);
        if (!verdict.allowed) {
          fail(addressRefused(verdict, answer.address));
          return;
        }
      }
      if (options.all === true) callback(null, list);
      else callback(null, list[0].address, list[0].family);
    });
  };
}

export interface FetchOptions {
  // The operator's settings: allow_http and the character ceiling.
  settings: WebSettings;
  // A lower character limit than the operator's ceiling. The model may lower
  // the limit and never raise it.
  maxChars?: number;
}

// Test seams. R1c passes neither: production callers get the public-unicast
// policy, ports 443 and 80, a 15-second deadline, node's own DNS lookup and no
// TLS option. A test running against loopback peers injects the peers' address
// policy, their ports, a shorter deadline (the production value is pinned by a
// test), an injected resolver, and the CA those peers' certificates carry.
export interface FetchDeps {
  addressPolicy?: AddressPolicy;
  ports?: readonly number[];
  deadlineMs?: number;
  lookup?: DnsLookup;
  tlsCa?: string | Buffer | Array<string | Buffer>;
}

export interface FetchResult {
  // The URL the text came from, after every redirect.
  finalUrl: string;
  // The final response's status.
  status: number;
  // The final response's media type, one of ALLOWED_CONTENT_TYPES.
  contentType: string;
  // The extracted text, cut to the resolved limit.
  text: string;
  // True when the text was cut.
  truncated: boolean;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(", ") : value;
}

// A bounded detail for a failure this core did not make: the error's code or
// name, never a message that could carry a URL or a body.
function boundedDetail(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === "string" && code !== "" ? code : error.name;
  }
  return "unknown error";
}

// A refusal made by this core, wherever undici attached it.
function refusalIn(error: unknown): WebFetchError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth++) {
    if (isWebFetchError(current)) return current;
    const cause = (current as { cause?: unknown }).cause;
    if (cause === current) break;
    current = cause;
  }
  return undefined;
}

// Read a stream into a buffer, refusing as soon as it is over `cap`. The source
// stream is destroyed when this throws.
async function readCapped(
  stream: AsyncIterable<Uint8Array>,
  cap: number,
  what: "encoded" | "decoded",
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.byteLength;
    if (total > cap) {
      throw new WebFetchError("too-large", `the ${what} body is over ${cap} bytes`);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

// Keep stream failures inside the fetch refusal type. This also preserves a
// refusal raised by the byte cap or carried as the stream error's cause.
export async function readEncodedBody(body: AsyncIterable<Uint8Array>): Promise<Buffer> {
  try {
    return await readCapped(body, MAX_BODY_BYTES, "encoded");
  } catch (error) {
    const refusal = refusalIn(error);
    if (refusal !== undefined) throw refusal;
    throw new WebFetchError("network", boundedDetail(error));
  }
}

// Decode a body, capping the DECODED bytes too (a small compressed body can
// expand past the cap). An encoding this core does not decode is refused.
async function decodeBody(
  encoded: Buffer,
  encoding: string | undefined,
  signal: AbortSignal,
): Promise<Buffer> {
  const name = (encoding ?? "").trim().toLowerCase();
  if (name === "" || name === "identity") return encoded;
  const decoder =
    name === "gzip" || name === "x-gzip"
      ? createGunzip()
      : name === "deflate"
        ? createInflate()
        : name === "br"
          ? createBrotliDecompress()
          : undefined;
  if (decoder === undefined) {
    throw new WebFetchError(
      "content-encoding",
      `content-encoding ${name} is not decoded by the fetch core`,
    );
  }
  const source = Readable.from(encoded);
  const decoded = source.pipe(decoder);
  const abort = (): void => {
    source.destroy();
    decoded.destroy();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    return await readCapped(decoded, MAX_BODY_BYTES, "decoded");
  } catch (error) {
    if (isWebFetchError(error)) throw error;
    throw new WebFetchError("content-encoding", `the body could not be decoded as ${name}`);
  } finally {
    signal.removeEventListener("abort", abort);
    source.destroy();
    decoded.destroy();
  }
}

// A body that cannot be used is terminated without reading untrusted bytes.
// Destroying an unfinished body aborts its request; a completed response may
// leave its connection reusable until the hop's dispatcher is destroyed.
// Destroying an undici body before it is read raises an abort error on the
// body, and with no 'error' listener node treats that as unhandled and aborts
// the process — so the listener is attached before the
// destroy. The body is being discarded: that error carries nothing this call
// can use.
export function discard(body: {
  destroy: () => void;
  on?: (event: "error", listener: (error: unknown) => void) => unknown;
}): void {
  body.on?.("error", () => {});
  body.destroy();
}

// Fetch one document for its text. Every refusal is a WebFetchError naming the
// rule; nothing is returned from a response that broke one.
export async function fetchDocument(
  rawUrl: string,
  options: FetchOptions,
  deps: FetchDeps = {},
): Promise<FetchResult> {
  const policy: UrlPolicy = {
    allowHttp: options.settings.allowHttp,
    ports: deps.ports ?? WEB_PORTS,
    address: deps.addressPolicy ?? publicUnicastPolicy(),
  };
  const maxChars = resolveMaxChars(options.maxChars, options.settings.fetchMaxChars);
  const deadlineMs = deps.deadlineMs ?? TOTAL_DEADLINE_MS;

  const controller = new AbortController();
  let expired = false;
  const deadlineAt = performance.now() + deadlineMs;
  const timer = setTimeout(() => {
    expired = true;
    controller.abort();
  }, deadlineMs);
  const deadlineError = (): WebFetchError =>
    new WebFetchError("deadline", `the request took longer than ${deadlineMs} ms`);
  const deadlineReached = (): boolean =>
    expired || controller.signal.aborted || performance.now() >= deadlineAt;
  const checkDeadline = (): void => {
    if (!deadlineReached()) return;
    expired = true;
    controller.abort();
    throw deadlineError();
  };

  try {
    let current = admitUrl(rawUrl, policy);
    let redirects = 0;

    for (;;) {
      // No pooled connection survives a hop, including a completed keep-alive
      // redirect response. A followed name must connect through a fresh vetted
      // lookup, even when it names the same origin.
      const dispatcher = new Agent({
        connect: {
          timeout: deadlineMs,
          lookup: vettedLookup(deps.lookup ?? (nodeLookup as unknown as DnsLookup), policy.address),
          ...(deps.tlsCa === undefined ? {} : { ca: deps.tlsCa }),
        },
      });
      try {
        let response: Awaited<ReturnType<typeof request>>;
        try {
          response = await request(current.href, {
            dispatcher,
            method: "GET",
            headers: { "user-agent": USER_AGENT, accept: ACCEPT_HEADER },
            signal: controller.signal,
          });
        } catch (error) {
          checkDeadline();
          const refusal = refusalIn(error);
          if (refusal !== undefined) throw refusal;
          throw new WebFetchError("network", boundedDetail(error));
        }

        const status = response.statusCode;
        if (REDIRECT_STATUSES.includes(status)) {
          const location = headerValue(response.headers.location);
          if (location === undefined) {
            return await readResult(
              response,
              status,
              current,
              maxChars,
              controller.signal,
              checkDeadline,
            );
          }
          discard(response.body);
          redirects += 1;
          if (redirects > MAX_REDIRECTS) {
            throw new WebFetchError(
              "redirect-limit",
              `the response redirects more than ${MAX_REDIRECTS} times`,
            );
          }
          current = admitUrl(location, policy, { from: current });
          continue;
        }

        return await readResult(
          response,
          status,
          current,
          maxChars,
          controller.signal,
          checkDeadline,
        );
      } finally {
        await dispatcher.destroy();
        // A completed response can outlive its request signal while its body is
        // decoded, extracted, or its dispatcher is destroyed.
        checkDeadline();
      }
    }
  } catch (error) {
    if (deadlineReached()) throw deadlineError();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

// The text of a final response: the content type is checked BEFORE the body is
// read, then the encoded and decoded caps, then extraction and the text limit.
export async function readResult(
  response: Awaited<ReturnType<typeof request>>,
  status: number,
  url: URL,
  maxChars: number,
  signal: AbortSignal,
  checkDeadline: () => void,
  extract: (media: string, body: string, url: string) => string | Promise<string> = extractText,
): Promise<FetchResult> {
  const media = mediaTypeOf(headerValue(response.headers["content-type"]));
  if (media === undefined || !allowedContentType(media)) {
    discard(response.body);
    throw new WebFetchError(
      "content-type",
      `content type ${media ?? "(none)"} is not one of ${ALLOWED_CONTENT_TYPES.join(", ")}`,
    );
  }
  const encoded = await readEncodedBody(response.body);
  checkDeadline();
  const decoded = await decodeBody(
    encoded,
    headerValue(response.headers["content-encoding"]),
    signal,
  );
  checkDeadline();
  const text = await extract(media, decoded.toString("utf8"), url.href);
  checkDeadline();
  const cut = truncateText(text, maxChars);
  return {
    finalUrl: url.href,
    status,
    contentType: media,
    text: cut.text,
    truncated: cut.truncated,
  };
}
