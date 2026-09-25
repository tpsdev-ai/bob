// Unit tests for the turn-origin registry (round 4 — the single pending-origin
// slot, replacing the prompt-keyed map).
//
// A trusted injector (cron, later discord / mail) records an origin in a single
// pending slot immediately before session.prompt. Presence takes + empties the
// slot on before_agent_start. The injector clears the slot in a finally (whatever
// happens to the prompt) and the host clears it on shutdown, so a rejected /
// aborted turn leaves no stale origin for the next turn. A turn whose injector
// did not set an origin (the empty slot) reads as {kind:"run"}. The origin is
// NEVER read from prompt text, so a prompt, whatever it contains, can never set
// an origin.

import { beforeEach, describe, expect, it } from "bun:test";
import type { TurnOrigin } from "../../src/shell/turn-origin.js";
import {
  clearPendingOrigin,
  isValidOrigin,
  setPendingOrigin,
  takePendingOrigin,
} from "../../src/shell/turn-origin-registry.js";

// Isolate every test: the registry is a module singleton (a single pending
// slot), so clear it between cases so no leftover entry leaks its origin into
// the next test.
beforeEach(() => clearPendingOrigin());

// ── Round-trips ──────────────────────────────────────────────────────────────
describe("setPendingOrigin + takePendingOrigin — round-trips each kind", () => {
  it("mail origin round-trips (set -> take returns it, then run)", () => {
    expect(setPendingOrigin({ kind: "mail", from: "flint" })).toBe(true);
    expect(takePendingOrigin()).toEqual({ kind: "mail", from: "flint" });
    // The take emptied the slot; a second read is run (one origin per turn).
    expect(takePendingOrigin()).toEqual({ kind: "run" });
  });

  it("cron origin round-trips", () => {
    expect(setPendingOrigin({ kind: "cron", job: "daily-brief" })).toBe(true);
    expect(takePendingOrigin()).toEqual({ kind: "cron", job: "daily-brief" });
  });

  it("discord origin round-trips", () => {
    expect(setPendingOrigin({ kind: "discord", channelId: "123456789" })).toBe(true);
    expect(takePendingOrigin()).toEqual({ kind: "discord", channelId: "123456789" });
  });
});

// ── Round-4 item 1: a single call-scoped slot, not a prompt key ─────────────────
describe("round-4 item 1: a single call-scoped slot, not a prompt key", () => {
  it("a turn with no injector-set origin is run (the empty slot is the default)", () => {
    // Nothing was set this turn; the slot is empty -> take is run.
    expect(takePendingOrigin()).toEqual({ kind: "run" });
  });

  it("the same origin set twice: each take returns its own (no prompt-key collision)", () => {
    // Two turns with identical injector-set origins: the old keyed map keyed by
    // prompt text would overwrite the first with the second; the single slot is
    // consumed on each take, so each turn resolves its own origin in order.
    setPendingOrigin({ kind: "cron", job: "brief-a" });
    expect(takePendingOrigin()).toEqual({ kind: "cron", job: "brief-a" });
    setPendingOrigin({ kind: "cron", job: "brief-a" });
    expect(takePendingOrigin()).toEqual({ kind: "cron", job: "brief-a" });
  });

  it("a rejected / aborted prompt (no take) leaves no origin for the next turn", () => {
    // Turn 1's injector sets an origin, but the prompt is rejected before
    // before_agent_start -> no take happens. The injector's finally clears the
    // slot whatever the prompt does, so it cannot leak into turn 2.
    setPendingOrigin({ kind: "cron", job: "brief-a" });
    // (no take — the prompt was aborted before before_agent_start)
    clearPendingOrigin(); // the injector's finally
    // Turn 2 takes an empty slot -> run (NOT brief-a).
    expect(takePendingOrigin()).toEqual({ kind: "run" });
  });
});

// ── Round-4 item 3: registration stores a newly constructed origin ──────────────
describe("round-4 item 3: registration stores a newly constructed origin", () => {
  it("an extra field on the caller's origin never reaches take (only approved fields)", () => {
    // The caller passes an origin with a non-approved extra field carrying a
    // secret. setPendingOrigin projects it to only the approved fields, so the
    // extra key (and its value) must not survive into what take returns.
    const forged = { kind: "cron", job: "valid", extra: "PROMPT_SECRET" };
    setPendingOrigin(forged as unknown as Parameters<typeof setPendingOrigin>[0]);
    const got = takePendingOrigin();
    expect(got).toEqual({ kind: "cron", job: "valid" });
    expect("extra" in got).toBe(false);
    expect(JSON.stringify(got as object)).not.toContain("PROMPT_SECRET");
  });

  it("the stored origin is a new object, not the caller's by reference", () => {
    // Mutating the caller's object AFTER set must not change what take returns:
    // registration built a fresh object holding only the approved field.
    const caller = { kind: "mail", from: "flint" };
    setPendingOrigin(caller);
    (caller as { extra?: string }).extra = "PROMPT_SECRET"; // mutate after set
    const got = takePendingOrigin();
    expect(got).toEqual({ kind: "mail", from: "flint" });
    expect("extra" in got).toBe(false);
  });
});

// ── Field whitelist (round-3 item 2): char class AND length at registration ──────
describe("setPendingOrigin — item 2: the field whitelist (char class + length)", () => {
  // A 300-character value is the explicit round-3 item-2 test: it exceeds the
  // 64-char bound for agent/job and the 20-char bound for a channel id, so it
  // must be rejected at registration and the turn must run.
  it("rejects a 300-character agent (mail) value -> run", () => {
    expect(setPendingOrigin({ kind: "mail", from: "a".repeat(300) })).toBe(false);
    expect(takePendingOrigin()).toEqual({ kind: "run" });
  });

  it("rejects a 300-character cron job value -> run", () => {
    expect(setPendingOrigin({ kind: "cron", job: "a".repeat(300) })).toBe(false);
    expect(takePendingOrigin()).toEqual({ kind: "run" });
  });

  it("rejects a 300-character (and any >20) discord channel id -> run", () => {
    expect(setPendingOrigin({ kind: "discord", channelId: "1".repeat(300) })).toBe(false);
    expect(takePendingOrigin()).toEqual({ kind: "run" });
    expect(setPendingOrigin({ kind: "discord", channelId: "1".repeat(21) })).toBe(false);
  });

  it("rejects an uppercase letter outside [a-z0-9-] (a secret-bearing from)", () => {
    expect(setPendingOrigin({ kind: "mail", from: "SECRET" })).toBe(false);
    expect(setPendingOrigin({ kind: "cron", job: "Cron-Job" })).toBe(false);
  });

  it("rejects a space or colon inside a name value", () => {
    expect(setPendingOrigin({ kind: "mail", from: "flint the boss" })).toBe(false);
    expect(setPendingOrigin({ kind: "mail", from: "flint:x" })).toBe(false);
  });

  it("rejects a non-digit discord channel id", () => {
    expect(setPendingOrigin({ kind: "discord", channelId: "12abc" })).toBe(false);
    expect(setPendingOrigin({ kind: "discord", channelId: "12-34" })).toBe(false);
  });

  it("rejects an empty value (below the 1-char minimum)", () => {
    expect(setPendingOrigin({ kind: "mail", from: "" })).toBe(false);
    expect(setPendingOrigin({ kind: "discord", channelId: "" })).toBe(false);
  });

  it("accepts valid values at the length boundary (64 for names, 20 for a channel)", () => {
    const name64 = "a".repeat(64);
    const ch20 = "1".repeat(20);
    expect(setPendingOrigin({ kind: "mail", from: name64 })).toBe(true);
    expect(takePendingOrigin()).toEqual({ kind: "mail", from: name64 });
    expect(setPendingOrigin({ kind: "cron", job: name64 })).toBe(true);
    expect(takePendingOrigin()).toEqual({ kind: "cron", job: name64 });
    expect(setPendingOrigin({ kind: "discord", channelId: ch20 })).toBe(true);
    expect(takePendingOrigin()).toEqual({ kind: "discord", channelId: ch20 });
  });

  it("a turn with no set origin is run even after a rejected (invalid) set", () => {
    // An invalid origin is rejected at set (the slot stays empty); take is run.
    setPendingOrigin({ kind: "mail", from: "BAD" });
    expect(takePendingOrigin()).toEqual({ kind: "run" });
  });
});

// ── isValidOrigin: the whitelist predicate ─────────────────────────────────────
describe("isValidOrigin — the whitelist predicate", () => {
  it("run is always valid", () => {
    expect(isValidOrigin({ kind: "run" })).toBe(true);
  });

  it("valid field values across all kinds", () => {
    const good: TurnOrigin[] = [
      { kind: "mail", from: "flint" },
      { kind: "cron", job: "daily-brief" },
      { kind: "discord", channelId: "123456789" },
    ];
    for (const o of good) expect(isValidOrigin(o)).toBe(true);
  });

  it("invalid field values are rejected", () => {
    const bad: TurnOrigin[] = [
      { kind: "mail", from: "SECRET" },
      { kind: "mail", from: "a".repeat(65) },
      { kind: "cron", job: "" },
      { kind: "discord", channelId: "12-34" },
      { kind: "discord", channelId: "1".repeat(21) },
    ];
    for (const o of bad) expect(isValidOrigin(o)).toBe(false);
  });
});
