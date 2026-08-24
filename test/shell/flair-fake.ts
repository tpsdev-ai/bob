// A fake Flair instance for the provisioning tests.
//
// Serves BOTH surfaces bob talks to, at the seam bob already injects
// everywhere else (`fetchImpl`), and RECORDS every call in order — the order
// is the thing under test for #93/#94, so it has to be observable.
//
//   Harper ops API  (POST <opsUrl>/)     — search_by_id | insert | update
//   Flair REST      (GET/PUT <url>/…)    — /Agent/<id>, /Soul/<agentId:key>
//
// Deliberately NOT a mock of bob's own functions: the point is to exercise the
// real request bodies, the real signing path and the real ordering, so a fake
// that agreed with a wrong implementation would still fail against the shapes
// flair actually serves.

export interface RecordedCall {
  method: string;
  url: string;
  path: string;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
  // For ops-API calls: the `operation` field, so ordering assertions read.
  op?: string;
  // For ops-API calls: the target table.
  table?: string;
}

export interface FakeAgentRow {
  id: string;
  publicKey?: string;
  [k: string]: unknown;
}

export interface FakeFlairOptions {
  // Pre-existing Agent rows, keyed by id.
  agents?: Record<string, FakeAgentRow>;
  // Pre-existing Soul rows, keyed by "<agentId>:<key>".
  souls?: Record<string, string>;
  // When true, /Agent/<id> answers 401 unknown_agent for ids with no row —
  // this is Flair's real behavior (the signed-auth middleware rejects before
  // the resource is reached), and it is what checkFlairRegistration decodes.
  unknownAgentIs401?: boolean;
  // Force every ops-API call to this status (for failure-path tests).
  opsStatus?: number;
}

export interface FakeFlair {
  calls: RecordedCall[];
  agents: Record<string, FakeAgentRow>;
  souls: Record<string, string>;
  fetchImpl: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string },
  ) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  // Call sequence as "<surface>:<what>" strings — the ordering assertion.
  sequence(): string[];
}

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

export function makeFakeFlair(opts: FakeFlairOptions = {}): FakeFlair {
  const calls: RecordedCall[] = [];
  const agents: Record<string, FakeAgentRow> = { ...(opts.agents ?? {}) };
  const souls: Record<string, string> = { ...(opts.souls ?? {}) };

  const fetchImpl: FakeFlair["fetchImpl"] = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const call: RecordedCall = { method: init.method, url, path, headers: init.headers, body };

    // ── Harper ops API: everything POSTs to "/" with an `operation` ──────────
    if (path === "/" && init.method === "POST" && body?.operation) {
      call.op = String(body.operation);
      call.table = String(body.table ?? "");
      calls.push(call);
      if (opts.opsStatus && opts.opsStatus >= 400) {
        return reply(opts.opsStatus, { error: "ops api refused" });
      }
      const records = (body.records as FakeAgentRow[] | undefined) ?? [];
      switch (body.operation) {
        case "search_by_id": {
          const ids = (body.ids as string[]) ?? [];
          return reply(
            200,
            ids.filter((id) => agents[id]).map((id) => ({ ...agents[id] })),
          );
        }
        case "insert": {
          const skipped: string[] = [];
          const inserted: string[] = [];
          for (const rec of records) {
            if (agents[rec.id]) skipped.push(rec.id);
            else {
              agents[rec.id] = { ...rec };
              inserted.push(rec.id);
            }
          }
          // Harper's shape: a 200 whose body says nothing was written.
          return reply(200, { inserted_hashes: inserted, skipped_hashes: skipped });
        }
        case "update": {
          for (const rec of records) {
            agents[rec.id] = { ...(agents[rec.id] ?? { id: rec.id }), ...rec };
          }
          return reply(200, { update_hashes: records.map((r) => r.id) });
        }
        default:
          return reply(400, { error: `fake flair: unhandled operation ${String(body.operation)}` });
      }
    }

    calls.push(call);

    // ── Flair REST ──────────────────────────────────────────────────────────
    const agentMatch = /^\/Agent\/(.+)$/.exec(path);
    if (agentMatch && init.method === "GET") {
      const id = decodeURIComponent(agentMatch[1]);
      if (agents[id]) return reply(200, agents[id]);
      // Flair's signed-auth middleware rejects an unresolvable signing
      // identity BEFORE the Agent resource, so a missing agent is 401
      // unknown_agent, not 404 (flair checkAgentRegistered).
      return opts.unknownAgentIs401 === false
        ? reply(404, { error: "not found" })
        : reply(401, { error: "unknown_agent" });
    }

    const soulMatch = /^\/Soul\/(.+)$/.exec(path);
    if (soulMatch) {
      const id = decodeURIComponent(soulMatch[1]);
      const signerId = signingAgentId(init.headers);
      if (init.method === "PUT") {
        // Mirror Soul.put()'s enforceWriteAuth: the row is attributed to the
        // SIGNING identity and a body claiming another agent is refused.
        if (!signerId) return reply(401, { error: "authentication required" });
        if (!agents[signerId]) return reply(401, { error: "unknown_agent" });
        if (body?.agentId !== signerId) {
          return reply(403, { error: "forbidden: agentId must match authenticated agent" });
        }
        souls[id] = String(body?.value ?? "");
        return reply(200, { id });
      }
      if (init.method === "GET") {
        if (!signerId || !agents[signerId]) return reply(401, { error: "unknown_agent" });
        if (!(id in souls)) return reply(404, { error: "not found" });
        const [agentId, key] = id.split(":");
        return reply(200, { id, agentId, key, value: souls[id], durability: "permanent" });
      }
    }

    return reply(404, { error: `fake flair: no route for ${init.method} ${path}` });
  };

  return {
    calls,
    agents,
    souls,
    fetchImpl,
    sequence: () =>
      calls.map((c) => (c.op ? `ops:${c.op}:${c.table}` : `rest:${c.method}:${c.path}`)),
  };
}

// Pull the agent id out of a TPS-Ed25519 header without verifying the
// signature — the fake is checking ATTRIBUTION rules, not crypto (the real
// signing code path is still exercised: a malformed header yields no id).
function signingAgentId(headers: Record<string, string>): string | undefined {
  const raw = headers.authorization ?? headers.Authorization;
  if (!raw?.startsWith("TPS-Ed25519 ")) return undefined;
  const [agentId, ts, nonce, sig] = raw.slice("TPS-Ed25519 ".length).split(":");
  if (!agentId || !ts || !nonce || !sig) return undefined;
  // tsMs must be MILLISECONDS — a seconds-precision value is the 1000x defect
  // that answers 401 in production, so the fake rejects it too.
  if (Number(ts) < 1e12) return undefined;
  return agentId;
}
