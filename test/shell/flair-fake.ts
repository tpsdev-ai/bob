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
  redirect?: "error";
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
  // Soul PUT enforces flair#1537: agent signatures are refused; only this
  // operator Basic credential is accepted. GET still accepts agent signatures.
  adminPassword?: string;
  adminUser?: string;
  // Force every Soul PUT to this status (for failure-path tests).
  soulPutStatus?: number;
  // A server or intermediary that reflects request headers into its error
  // bodies. When set, every non-2xx reply appends the request's credential:
  // "authorization" echoes the Authorization header verbatim; "decoded-basic"
  // echoes the decoded user:password of a Basic header.
  reflect?: "authorization" | "decoded-basic";
}

export interface FakeFlair {
  calls: RecordedCall[];
  // Every non-2xx body the fake served, in order — so a test can prove a
  // reflected credential really was on the wire back to bob.
  errorBodies: string[];
  agents: Record<string, FakeAgentRow>;
  souls: Record<string, string>;
  fetchImpl: (
    url: string,
    init: { method: string; headers: Record<string, string>; body?: string; redirect?: "error" },
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

  const errorBodies: string[] = [];

  const fetchImpl: FakeFlair["fetchImpl"] = async (url, init) => {
    const res = await route(url, init);
    if (res.ok) return res;
    let body = await res.text();
    if (opts.reflect) body = `${body} ${reflectedCredential(init.headers, opts.reflect)}`;
    errorBodies.push(body);
    return reply(res.status, body);
  };

  const route: FakeFlair["fetchImpl"] = async (url, init) => {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const body = init.body ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
    const call: RecordedCall = {
      method: init.method,
      url,
      path,
      headers: init.headers,
      redirect: init.redirect,
      body,
    };

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
        if (opts.soulPutStatus && opts.soulPutStatus >= 400) {
          return reply(opts.soulPutStatus, { error: "soul write refused" });
        }
        const expected = `Basic ${Buffer.from(`${opts.adminUser ?? "admin"}:${opts.adminPassword ?? "placeholder-not-a-real-admin-credential"}`).toString("base64")}`;
        if (init.headers.Authorization !== expected)
          return reply(403, { error: "soul_write_requires_operator" });
        if (!agents[String(body?.agentId)]) return reply(404, { error: "unknown_agent" });
        if (id !== `${String(body?.agentId)}:${String(body?.key)}`)
          return reply(400, { error: "soul id mismatch" });
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
    errorBodies,
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

// What a header-reflecting server appends to an error body.
function reflectedCredential(
  headers: Record<string, string>,
  mode: "authorization" | "decoded-basic",
): string {
  const raw = headers.authorization ?? headers.Authorization ?? "";
  if (mode === "authorization") return `(request Authorization: ${raw})`;
  const decoded = raw.startsWith("Basic ")
    ? Buffer.from(raw.slice("Basic ".length), "base64").toString("utf8")
    : raw;
  return `(authenticated as ${decoded})`;
}

// Every form an operator Basic credential can take in output: the header, its
// base64, the decoded user:password, and the bare password.
export function operatorCredentialForms(password: string, user = "admin"): string[] {
  const base64 = Buffer.from(`${user}:${password}`).toString("base64");
  return [`Basic ${base64}`, base64, `${user}:${password}`, password];
}

// Run `fn` and capture everything it writes to stdout/stderr — console.* and
// the raw process streams — whether it resolves or throws.
export async function captureOutput(
  fn: () => Promise<unknown>,
): Promise<{ error: unknown; output: string }> {
  const chunks: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug"] as const;
  const savedConsole = methods.map((m) => console[m]);
  const savedOut = process.stdout.write;
  const savedErr = process.stderr.write;
  for (const m of methods) {
    console[m] = (...args: unknown[]) => {
      chunks.push(args.map(String).join(" "));
    };
  }
  const sink = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stdout.write = sink;
  process.stderr.write = sink;
  let error: unknown;
  try {
    await fn();
  } catch (err) {
    error = err;
  } finally {
    methods.forEach((m, i) => {
      console[m] = savedConsole[i];
    });
    process.stdout.write = savedOut;
    process.stderr.write = savedErr;
  }
  return { error, output: chunks.join("\n") };
}
