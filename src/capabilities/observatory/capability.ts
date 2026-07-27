// The testable core of the observatory (team-view producer) capability, decoupled
// from pi's real ExtensionAPI so it can be unit-tested with fakes (no live
// observatory, no real office key, no network). `index.ts` is the thin factory
// that builds the real ObservatoryHttpClient + reader and calls this.
//
// What this wires — ONE OUTBOUND tool via pi.registerTool:
//   observatory_report — build the office's snapshots/events, sanitize, sign with
//                        the OFFICE key, and POST ONE batched call to /IngestEvents.
//
// CRON MODEL (see bob/packages/shell/src/cron.ts): cron does NOT call the
// capability directly — it injects a prompt into the AGENT, which then calls this
// tool. So the capability EXPOSES the report logic as a tool; bob.yaml wires a
// `cron:` entry whose prompt says "report your status to the observatory". Same
// shape as flair_write / discord_send. There is NO inbound listener (serves:false).

import { type TSchema, Type } from "typebox";
import type { IngestBatch, ObservatoryClient } from "./client.js";
import type { AgentSignal } from "./snapshot.js";
import { buildBatch } from "./snapshot.js";

// The minimal slice of pi's ExtensionAPI this core needs — declared structurally
// so a tiny test fake and the real ExtensionAPI both satisfy it.
export interface PiLike {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    parameters: TSchema;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: unknown }>;
  }): void;
}

export interface WireOptions {
  pi: PiLike;
  client: ObservatoryClient;
  // Reads the office's live signals each tick (fs seam). Returns the AgentSignal[]
  // the builder turns into the batched snapshot/event payload.
  readSignals: () => AgentSignal[];
  // Threshold (s) past which an agent is reported stale. Defaults to 600.
  staleThresholdSeconds?: number;
  // Logger seam — defaults to console.error. NOTHING here ever logs the key (it
  // lives only inside the client) or a raw signal (only counts/status).
  log?: (msg: string) => void;
}

function ok(text: string): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text }], details: {} };
}

export function wireObservatoryCapability(opts: WireOptions): void {
  const { pi, client, readSignals } = opts;
  const log = opts.log ?? ((m: string) => console.error(m));

  // --- observatory_report ------------------------------------------------
  pi.registerTool({
    name: "observatory_report",
    label: "Observatory Report",
    description:
      "Report this office's live status to the team observatory. Builds each agent's snapshot (role/model/status/current-task) + the events they caused, sanitizes them (no paths/secrets/bodies), signs with the office key, and POSTs ONE batched call. Call this on each cron tick.",
    parameters: Type.Object({}),
    async execute() {
      const signals = readSignals();
      const batch: IngestBatch = buildBatch(signals, {
        staleThresholdSeconds: opts.staleThresholdSeconds,
      });
      // post() runs sanitize() + the office-key signature internally — exactly
      // one redacted, signed path to the wire.
      const result = await client.post(batch);
      // Status line names counts + per-agent status ONLY — never a task summary,
      // a path, or the key.
      const byStatus = batch.agents.reduce<Record<string, number>>((acc, a) => {
        acc[a.status] = (acc[a.status] ?? 0) + 1;
        return acc;
      }, {});
      const statusLine = Object.entries(byStatus)
        .map(([s, n]) => `${n} ${s}`)
        .join(", ");
      const msg = `reported ${result.agents} agent(s) [${statusLine}] + ${result.events} event(s) to the observatory`;
      log(`observatory capability: ${msg}`);
      return ok(msg);
    },
  });

  log("observatory capability: registered observatory_report");
}
