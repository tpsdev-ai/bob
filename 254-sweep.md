# bob#254 sweep — every sentence this PR adds or changes

Scanned: prose added/changed in `git diff origin/main...HEAD` (module/function
docs, inline comments, operator strings, README, changelog fragment, test names
and comments) and the PR body. Each entry is the sentence and the call: `true`
(checked against the code / a run), `fixed` (was over-broad or false; this round),
or `n/a`.

## `src/capabilities/flair/client.ts`

- "Read a response body as text, refusing it once its UTF-8 BYTES exceed
  `maxBytes` … the read stops and the stream is cancelled at the bound, so an
  oversized body is never fully buffered. A fake without a stream falls back to
  `text()`, bounded by the decoded text's byte length." — `fixed` (this round)
  and true: the stream test serves 3×1000-byte chunks against a 2500-byte bound,
  observes `cancel()`, and gets `too_large`; the multibyte test (600k code units,
  ~1.2M bytes, bound 1,000,000) gets `too_large`.
- "Kept OFF FetchLike so the fetch seam every caller injects stays the minimal
  `{ ok, status, text() }` shape; signedFetch reads the stream off the response
  object directly." — `fixed` (this round) and true: widening `FetchLike` broke
  `flair-soul.ts`, so `body` is read structurally instead.
- "A bootstrap response is bounded by BYTES while it is read … Every other call
  reads the whole body." — true (`extra?.maxResponseBytes` selects the reader).
- "The size bound is counted off the response's byte stream when it has one (a
  real fetch response), else off the decoded text's UTF-8 byte length." — true.
- `FlairBootstrap`: "`context` is candidate content: Flair's rendered block which
  bob may append under its own heading, or omit (a blank, over-budget, or
  web-session response appends nothing)." — `fixed` (this round) and true: the
  loader returns `""` for a blank context, the failure note for over-budget, and
  the web gate returns `""`.
- "`tokenEstimate` measures the whole response Flair serialized, optional
  because the caller does not rely on it." — `fixed` (this round) and true.
- "an oversized body is refused rather than parsed and appended" — true.
- bootstrap(): "A non-2xx, a response that never arrives (timeout), one over the
  size bound, or a body whose `context` is missing or not a string is an ERROR …
  A `context` that is present but BLANK is a successful empty response" — true
  (one test per branch).

## `src/shell/flair-bootstrap.ts`

- "Over the bound, and on a request, response, timeout or budget failure, the
  session STARTS with ONE line … An identity mismatch is not one of these: it
  refuses launch (flairBootstrapTarget)." — `fixed` (this round) and true:
  `flairBootstrapTarget` throws on the mismatch (the unit test asserts the
  throw); the loader's other failures return `failureNote(...)`.
- The `tokenEstimate` comment ("measures the whole response Flair serialized …
  does not measure the block bob appends") — `fixed` (this round) and true.
- "bob appends soul.md first and Flair's block second" — true (README and the
  assembled-prompt test).

## `README.md`

- "on a request, response, timeout or budget failure the session still starts
  with one line saying the context could not be loaded (an identity mismatch
  instead refuses launch)" — `fixed` (this round) and true.

## `.changelog/unreleased/added-254-flair-bootstrap-at-session-start.md`

- The lede and body — true. The failure sentence is now scoped to "a request,
  response, timeout or budget failure" — `fixed` (this round). Updated in place:
  this is the fragment for the same unreleased feature, so a second fragment
  would list the feature twice.

## Tests

- `test/capabilities/flair/bootstrap.test.ts` — the two new byte-bound cases name
  what they assert; the multibyte case asserts both the code-unit length (under
  the bound) and the byte length (over it) before the call.
- `test/shell/flair-bootstrap.test.ts:438` — `fixed` (this round): renamed to
  "the factory config carries the 'could not load' block" (it inspects the
  injected factory's config, not the assembled prompt; the assembled prompt is
  checked in `flair-bootstrap-prompt.test.ts`).

## Deliberately not changed

- Follow-ups the verdict names: the unchanged `README.md:53` ("local `soul.md`
  wins"), interactive/resumed sessions reusing the launch-time bootstrap
  (`run.ts:1294`, `session.ts:1136`), and the unchanged `client.ts` note about a
  server-provided error reason are outside this PR's changed lines.
- The brief says bob has no `.changelog/`; it does
  (`.changelog/unreleased/` with `scripts/changelog-fragments.mjs check`), so the
  fragment convention was followed rather than `CHANGELOG.md`.
