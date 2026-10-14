// A local HTTP Flair double for the reachy audit path (bob#356 round 2). It is a
// real HTTP server the real FlairHttpClient talks to, and it models the two
// Flair checks a Memory PUT meets:
//   * the TPS-Ed25519 signature: `Authorization: TPS-Ed25519
//     <agentId>:<tsMs>:<nonce>:<sig>` over `<agentId>:<ts>:<nonce>:<METHOD>:<path>`,
//     verified with the agent's public key (401 when it does not verify);
//   * the Memory OWNER guard: a non-admin agent may only write a Memory whose
//     body `agentId` is itself (403 otherwise — what Flair's Memory.put does
//     for a body owned by another agent).
// An unsigned or badly signed request gets 401 first, on any route; a signed
// request to any other route gets 404. It accepts no admin credential: every
// caller here is an ordinary agent.

import { createPublicKey, type KeyObject, verify } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface FlairDouble {
  url: string;
  /** OrgEvents written (parsed from the Memory content), in order. */
  audits: Array<{ kind: string; summary: string; owner: string }>;
  /** Every refusal, with its reason. */
  refusals: Array<{ status: number; reason: string }>;
  close(): void;
}

export async function startFlairDouble(agents: Record<string, KeyObject>): Promise<FlairDouble> {
  const audits: FlairDouble["audits"] = [];
  const refusals: FlairDouble["refusals"] = [];
  const keys = new Map(Object.entries(agents).map(([id, k]) => [id, createPublicKey(k)]));
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const refuse = (status: number, reason: string) => {
        refusals.push({ status, reason });
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: reason }));
      };
      const auth = req.headers.authorization ?? "";
      const m = /^TPS-Ed25519 ([a-z0-9-]+):(\d+):([^:]+):(.+)$/.exec(auth);
      if (!m) return refuse(401, "missing signature");
      const [, agentId, ts, nonce, sig] = m;
      const key = keys.get(agentId ?? "");
      const path = req.url ?? "";
      const payload = `${agentId}:${ts}:${nonce}:${req.method}:${path}`;
      if (!key || !verify(null, Buffer.from(payload), key, Buffer.from(sig ?? "", "base64"))) {
        return refuse(401, "signature does not verify");
      }
      if (req.method === "PUT" && path.startsWith("/Memory/")) {
        let parsed: { agentId?: string; content?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          return refuse(400, "not JSON");
        }
        if (parsed.agentId !== agentId) {
          return refuse(403, `owner ${parsed.agentId} is not the signing agent ${agentId}`);
        }
        try {
          const event = JSON.parse(parsed.content ?? "") as { kind: string; summary: string };
          audits.push({ kind: event.kind, summary: event.summary, owner: parsed.agentId });
        } catch {
          /* a memory that is not an OrgEvent */
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return { url: `http://127.0.0.1:${port}`, audits, refusals, close: () => server.close() };
}
