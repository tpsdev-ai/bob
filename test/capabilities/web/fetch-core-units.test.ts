// The web fetch core's runtime-independent pieces (bob#245 — web spec v3, slice
// R1b): the DNS-answer vetting wrapper, the fixed User-Agent, the character
// limit, and the fact that the capability still registers no tool. The
// transport itself is exercised under Node in fetch-core-node.test.ts.

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { discard, readEncodedBody } from "../../../src/capabilities/web/fetch.js";
import {
  ACCEPT_HEADER,
  ADDRESS_POLICY_VERSION,
  MAX_BODY_BYTES,
  MAX_REDIRECTS,
  publicUnicastPolicy,
  resolveMaxChars,
  TOTAL_DEADLINE_MS,
  USER_AGENT,
  vettedLookup,
  WebFetchError,
} from "../../../src/capabilities/web/index.js";

const policy = publicUnicastPolicy({ own: [] });

it("terminates a skipped body without waiting for or consuming it", () => {
  let destroyed = false;
  let consumed = false;
  const body = {
    destroy: () => {
      destroyed = true;
    },
    dump: () => {
      consumed = true;
      return new Promise<void>(() => {});
    },
  };
  discard(body);
  expect(destroyed).toBe(true);
  expect(consumed).toBe(false);
});

it("wraps an in-memory stream reset as a bounded network refusal", async () => {
  const reset = Object.assign(new Error("untrusted response detail"), { code: "ECONNRESET" });
  const body = Readable.from(
    (async function* () {
      yield Buffer.from("partial");
      throw reset;
    })(),
  );
  await expect(readEncodedBody(body)).rejects.toMatchObject({
    name: "WebFetchError",
    code: "network",
    detail: "ECONNRESET",
  });
});

it("preserves refusals raised while reading the encoded body", async () => {
  await expect(
    readEncodedBody(Readable.from([Buffer.alloc(MAX_BODY_BYTES + 1)])),
  ).rejects.toMatchObject({
    code: "too-large",
    detail: `the encoded body is over ${MAX_BODY_BYTES} bytes`,
  });
  const refusal = new WebFetchError("address", "existing refusal");
  await expect(
    readEncodedBody(
      Readable.from(
        (async function* () {
          yield Buffer.from("partial");
          throw refusal;
        })(),
      ),
    ),
  ).rejects.toBe(refusal);
});

interface Recorded {
  options: unknown;
  error: Error | null;
  addresses?: Array<{ address: string; family: number }>;
  single?: { address: string; family?: number };
}

// A base resolver that records what it was asked and answers with `answers`
// (the array shape node's dns.lookup returns when `all` is set).
function baseLookup(answers: unknown): {
  lookup: Parameters<typeof vettedLookup>[0];
  recorded: Recorded;
} {
  const recorded: Recorded = { options: undefined, error: null };
  const lookup = ((_hostname: string, options: unknown, callback: (...args: never[]) => void) => {
    recorded.options = options;
    const cb = callback as unknown as (
      error: Error | null,
      addresses?: Array<{ address: string; family: number }>,
      family?: number,
    ) => void;
    if (Array.isArray(answers)) cb(null, answers as Array<{ address: string; family: number }>);
    else cb(null, String(answers), 4);
  }) as unknown as Parameters<typeof vettedLookup>[0];
  return { lookup, recorded };
}

describe("the DNS-answer vetting", () => {
  it("asks for every answer and hands back exactly those answers", () => {
    const answers = [
      { address: "93.184.216.34", family: 4 },
      { address: "2606:4700::1111", family: 6 },
    ];
    const { lookup, recorded } = baseLookup(answers);
    const vetted = vettedLookup(lookup, policy);
    let received: Array<{ address: string; family: number }> | undefined;
    let error: Error | null = null;

    vetted(
      "example.test",
      { all: true, verbatim: true } as never,
      ((e: Error | null, a: unknown) => {
        error = e;
        received = a as Array<{ address: string; family: number }>;
      }) as never,
    );

    expect(error).toBeNull();
    expect(received).toEqual(answers);
    expect(recorded.options).toEqual({ all: true, verbatim: true });
  });

  it("refuses the whole request when any answer is refused", () => {
    const { lookup } = baseLookup([
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]);
    const vetted = vettedLookup(lookup, policy);
    const calls: Array<{ error: Error | null; addresses: unknown }> = [];
    vetted(
      "mixed.test",
      { all: true, verbatim: true } as never,
      ((error: Error | null, addresses: unknown) => {
        calls.push({ error, addresses });
      }) as never,
    );

    expect(calls.length).toBe(1);
    expect(calls[0].error).toBeInstanceOf(WebFetchError);
    expect((calls[0].error as WebFetchError).code).toBe("address");
    expect((calls[0].error as WebFetchError).detail).toContain(
      'iana-ipv4-special-registry 10.0.0.0/8 "Private-Use"',
    );
    // No address list was ever handed back.
    expect(calls[0].addresses).toBeUndefined();
  });

  it("vets a refused answer whatever family it is in", () => {
    const { lookup } = baseLookup([{ address: "::ffff:10.0.0.1", family: 6 }]);
    const vetted = vettedLookup(lookup, policy);
    let error: WebFetchError | null = null;
    vetted(
      "mapped.test",
      { all: true, verbatim: true } as never,
      ((e: WebFetchError) => {
        error = e;
      }) as never,
    );
    expect(error).not.toBeNull();
    expect((error as unknown as WebFetchError).code).toBe("address");
  });

  it("vets a bare string answer too", () => {
    const { lookup } = baseLookup("127.0.0.1");
    const vetted = vettedLookup(lookup, policy);
    let error: WebFetchError | null = null;
    vetted(
      "string.test",
      { all: true, verbatim: true } as never,
      ((e: WebFetchError) => {
        error = e;
      }) as never,
    );
    expect((error as unknown as WebFetchError).code).toBe("address");

    const allowed = vettedLookup(baseLookup("93.184.216.34").lookup, policy);
    let single: { address: string; family?: number } | undefined;
    allowed(
      "allowed.test",
      {} as never,
      ((e: Error | null, address: string, family?: number) => {
        expect(e).toBeNull();
        single = { address, family };
      }) as never,
    );
    expect(single).toEqual({ address: "93.184.216.34", family: 4 });
  });

  it("passes a resolver failure through unchanged", () => {
    const failure = Object.assign(new Error("dns is down"), { code: "EAI_AGAIN" });
    const lookup = ((_hostname: string, _options: unknown, callback: (e: Error) => void) => {
      callback(failure);
    }) as unknown as Parameters<typeof vettedLookup>[0];
    const vetted = vettedLookup(lookup, policy);
    let error: Error | null = null;
    vetted(
      "failing.test",
      {} as never,
      ((e: Error) => {
        error = e;
      }) as never,
    );
    expect(error).toBe(failure);
  });

  it("refuses a name with no answer at all", () => {
    const vetted = vettedLookup(baseLookup([]).lookup, policy);
    let error: NodeJS.ErrnoException | null = null;
    vetted(
      "empty.test",
      { all: true, verbatim: true } as never,
      ((e: NodeJS.ErrnoException) => {
        error = e;
      }) as never,
    );
    expect(error).not.toBeNull();
    expect((error as unknown as NodeJS.ErrnoException).code).toBe("ENOTFOUND");
  });

  it("carries the policy version it was built with", () => {
    expect(policy.version).toBe(ADDRESS_POLICY_VERSION);
  });
});

describe("the fixed User-Agent and the character limit", () => {
  it("pins the production limits", () => {
    expect(MAX_BODY_BYTES).toBe(5 * 1024 * 1024);
    expect(TOTAL_DEADLINE_MS).toBe(15_000);
    expect(MAX_REDIRECTS).toBe(5);
    expect(ACCEPT_HEADER).toBe(
      "text/html, text/plain, text/markdown, application/json, application/xml, text/xml, application/rss+xml, application/atom+xml",
    );
  });

  it("names bob and its version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
    expect(USER_AGENT).toBe(`bob/${pkg.version}`);
  });

  it("never goes below one character or above the operator's ceiling", () => {
    expect(resolveMaxChars(undefined, 20_000)).toBe(20_000);
    expect(resolveMaxChars(0, 20_000)).toBe(1);
    expect(resolveMaxChars(-5, 20_000)).toBe(1);
    expect(resolveMaxChars(1.9, 20_000)).toBe(1);
    expect(resolveMaxChars(500, 100)).toBe(100);
    expect(resolveMaxChars(200_000, 100_000)).toBe(100_000);
    expect(resolveMaxChars(Number.NaN, 20_000)).toBe(20_000);
    expect(resolveMaxChars(Number.POSITIVE_INFINITY, 20_000)).toBe(20_000);
    expect(resolveMaxChars(999_999, 200_000)).toBe(100_000);
  });
});

describe("the capability surface", () => {
  it("registers no tool", async () => {
    process.env.BOB_CAP_WEB = "{}";
    const extension = (await import("../../../src/capabilities/web/index.js")).default as (
      pi: ExtensionAPI,
    ) => void;
    const registered: string[] = [];
    extension({
      registerTool: (tool: { name: string }) => {
        registered.push(tool.name);
      },
    } as unknown as ExtensionAPI);
    expect(registered).toEqual([]);
  });
});
