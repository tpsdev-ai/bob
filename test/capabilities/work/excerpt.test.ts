// The excerpt the model sees (bob#211): a bounded tail of the capture, run
// through bob's existing secret redaction BEFORE it is cut, so a secret that
// straddles a cut cannot survive as a fragment.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactSecrets, sanitizeString } from "../../../src/capabilities/observatory/sanitize.js";
import { readExcerpt } from "../../../src/capabilities/work/run.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bob-work-excerpt-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const TOKEN = `ghp_${"Z9y8X7w6V5".repeat(4)}`;

describe("readExcerpt", () => {
  it("a small capture comes back whole", () => {
    const p = join(dir, "a.log");
    writeFileSync(p, "one\ntwo\n");
    expect(readExcerpt(p)).toEqual({
      text: "one\ntwo\n",
      truncated: false,
      redactions: 0,
      withheld: 0,
      missing: false,
      bytes: 8,
    });
  });

  it("a secret straddling the READ WINDOW's start shows no fragment (the partial line is dropped)", () => {
    const p = join(dir, "b.log");
    const secretLine = `export GITHUB_TOKEN=${TOKEN}`;
    const tail = "t ".repeat(45).trimEnd();
    writeFileSync(p, `${"x".repeat(500)}\n${secretLine}\n${tail}\n`);
    // Window = 100 + 20 bytes from the end: it starts inside the secret line.
    const e = readExcerpt(p, { maxBytes: 100, marginBytes: 20 });
    expect(e.truncated).toBe(true);
    for (let n = 6; n <= TOKEN.length; n++) {
      expect(e.text).not.toContain(TOKEN.slice(TOKEN.length - n));
    }
    expect(e.text).toContain(tail);
  });

  it("a secret straddling the EXCERPT cut is redacted whole before the cut", () => {
    const p = join(dir, "c.log");
    // One long last line: the tail cut falls inside the token. Redaction first
    // replaces the token, so no tail fragment of it can be shown.
    // Unredacted, the last 100 bytes would start 19 bytes before the token's end.
    writeFileSync(p, `${"w ".repeat(100)}${TOKEN} ${"z ".repeat(40)}\n`);
    const e = readExcerpt(p, { maxBytes: 100, marginBytes: 4096 });
    expect(e.truncated).toBe(true);
    expect(e.redactions).toBe(1);
    expect(e.text).toContain("[redacted]");
    for (let n = 6; n <= TOKEN.length; n++) {
      expect(e.text).not.toContain(TOKEN.slice(TOKEN.length - n));
    }
  });

  it("terminal escapes and stray control bytes are stripped", () => {
    const p = join(dir, "d.log");
    writeFileSync(p, "\u001b[31mred\u001b[0m\u0007 plain\ttab\n");
    expect(readExcerpt(p).text).toBe("red plain\ttab\n");
  });

  it("a missing capture is an empty excerpt that SAYS it is missing, not a throw", () => {
    expect(readExcerpt(join(dir, "none.log"))).toEqual({
      text: "",
      truncated: false,
      redactions: 0,
      bytes: 0,
      withheld: 0,
      missing: true,
    });
  });

  it("an incomplete capture withholds its unterminated final line BEFORE redaction", () => {
    const p = join(dir, "e.log");
    // A capture cut mid-token: the prefix and 14 of the token's 40 characters,
    // too short for any token rule to recognize — the fragment must never show.
    const fragment = TOKEN.slice(0, 18);
    writeFileSync(p, `safe line\n${fragment}`);
    const e = readExcerpt(p, { complete: false });
    expect(e.text).toBe("safe line\n");
    expect(e.withheld).toBe(Buffer.byteLength(fragment));
    expect(e.text).not.toContain("ghp_");
    // The same bytes as a COMPLETE capture show the final line (it is the end).
    expect(readExcerpt(p, { complete: true }).text).toContain(fragment);
  });
});

describe("the shared redaction set (observatory sanitize.ts)", () => {
  it("redactSecrets counts what it replaced and leaves paths alone", () => {
    const r = redactSecrets(`token=abcdef123456 at /Users/someone/work ${TOKEN}`);
    expect(r.redactions).toBe(2);
    expect(r.text).toContain("/Users/someone/work");
    expect(r.text).not.toContain(TOKEN);
  });

  it("covers env-style *_TOKEN / *_PASSWORD / *_SECRET_ACCESS_KEY assignments", () => {
    for (const line of [
      "GITHUB_TOKEN=abc123def456",
      "DB_PASSWORD: hunter2hunter2",
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMIK7MDENG",
      "npm_config__auth_token=s3cr3tvalue",
    ]) {
      const r = redactSecrets(line);
      expect(r.redactions, line).toBeGreaterThanOrEqual(1);
      expect(r.text, line).toContain("[redacted]");
    }
    // A plain word that merely ends in TOKEN with no assignment is left alone.
    expect(redactSecrets("the CSRF_TOKEN header is required").redactions).toBe(0);
  });

  it("redacts an Authorization value after any amount of spacing, and a value that only STARTS with the placeholder", () => {
    const spaced = redactSecrets("Authorization:         Basic short-secret\n");
    expect(spaced.text).toBe("Authorization: [redacted]\n");
    expect(spaced.redactions).toBe(1);
    const prefixed = redactSecrets('Authorization: [redacted], nonce="secret123"\n');
    expect(prefixed.text).not.toContain("secret123");
    expect(prefixed.text).toBe("Authorization: [redacted]\n");
    expect(prefixed.redactions).toBe(1);
    // Only a value that IS entirely the placeholder is left alone (no double count).
    const done = redactSecrets("Authorization: [redacted]\n");
    expect(done.text).toBe("Authorization: [redacted]\n");
    expect(done.redactions).toBe(0);
  });

  it("redacts Authorization header values whatever the scheme, keeping the header name", () => {
    for (const [line, secret] of [
      ["Authorization: Basic dXNlcjpwYXNz", "dXNlcjpwYXNz"],
      ["authorization: Token abcdef", "abcdef"],
      ['curl -H "Authorization: Bearer abcdefgh12345678" https://x', "abcdefgh12345678"],
      ['{"Authorization": "Digest username=u, response=r"}', "response=r"],
      ["Proxy-Authorization: Basic Zm9vOmJhcg==", "Zm9vOmJhcg=="],
    ]) {
      const r = redactSecrets(line);
      expect(r.text, line).not.toContain(secret);
      expect(r.text, line).toMatch(/authorization["']?\s*[:=]\s*["']?\[redacted\]/i);
      expect(r.redactions, line).toBe(1);
    }
    // Already redacted: not counted again. A prose mention is left alone.
    expect(redactSecrets("Authorization: [redacted]").redactions).toBe(0);
    expect(redactSecrets("the authorization step passed").redactions).toBe(0);
  });

  it("redacts the WHOLE header value through the end of its line: quoted Digest parameters, any length", () => {
    // A quoted Digest header: every parameter goes, not just the text up to the
    // first quote.
    const digest = redactSecrets(
      `Authorization: Digest username="alice", realm="example.org", nonce="secret123", uri="/api", response="6629fae49393a05397450978507c4ef1"`,
    );
    expect(digest).toEqual({ text: "Authorization: [redacted]", redactions: 1 });
    // A value longer than any fixed cap, made of pieces no other rule matches
    // (dots and dashes break the long-opaque-run rules).
    const longBasic = `Proxy-Authorization: Basic ${"a1.b2-".repeat(1200)}tail-secret-9`;
    expect(longBasic.length).toBeGreaterThan(7000);
    expect(redactSecrets(longBasic)).toEqual({
      text: "Proxy-Authorization: [redacted]",
      redactions: 1,
    });
    // The value ends at its own line: the next line is left alone, and a header
    // with an empty value does not swallow the next line.
    expect(redactSecrets(`Authorization: Basic abc\nnext line`).text).toBe(
      "Authorization: [redacted]\nnext line",
    );
    expect(redactSecrets("Authorization:\r\nnext line")).toEqual({
      text: "Authorization:\r\nnext line",
      redactions: 0,
    });
  });

  it("covers credentials in a URL's userinfo, keeping the host", () => {
    const r = redactSecrets("cloning https://bob:pa55word@github.com/org/repo.git");
    expect(r.text).not.toContain("pa55word");
    expect(r.text).toContain("github.com/org/repo.git");
  });

  it("sanitizeString (the observatory boundary) still redacts secrets AND paths", () => {
    const out = sanitizeString(`GITHUB_TOKEN=${TOKEN} in /Users/someone/x`);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain("/Users/someone");
  });
});
