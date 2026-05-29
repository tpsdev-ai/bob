// The testable core of the flair (memory) capability, decoupled from pi's real
// ExtensionAPI so it can be unit-tested with fakes (no live Flair, no real key,
// no network). `index.ts` is the thin factory that builds the real
// FlairHttpClient and calls this.
//
// What this wires — three OUTBOUND tools via pi.registerTool:
//   flair_search  — semantic recall over the agent's long-term memory
//   flair_write   — store a durable memory (with a durability tier)
//   flair_get     — fetch a specific memory by id
// There is NO inbound listener (unlike cap-discord): memory is pull/push only,
// driven by the agent, so the capability does not "serve" a gateway.

import { type TSchema, Type } from "typebox";
import type { Durability, FlairClient } from "./client.js";

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
  client: FlairClient;
  // Logger seam — defaults to console.error. NOTHING here ever logs the key
  // (it lives only inside the client).
  log?: (msg: string) => void;
}

// Search results are rendered compactly; a single tool result is bounded so a
// huge recall can't blow the model's context.
const MAX_RESULT_CHARS = 6000;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 25;

const DURABILITY_VALUES: Durability[] = ["ephemeral", "standard", "persistent", "permanent"];

function ok(text: string): { content: Array<{ type: "text"; text: string }>; details: unknown } {
  return { content: [{ type: "text", text }], details: {} };
}

export function wireFlairCapability(opts: WireOptions): void {
  const { pi, client } = opts;
  const log = opts.log ?? ((m: string) => console.error(m));

  // --- flair_search ------------------------------------------------------
  pi.registerTool({
    name: "flair_search",
    label: "Flair Memory Search",
    description:
      "Semantic search over your own long-term memory. Use it to recall facts, decisions, and context from past sessions before answering.",
    parameters: Type.Object({
      query: Type.String({ minLength: 1, description: "What you want to recall." }),
      limit: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: MAX_SEARCH_LIMIT,
          description: `How many memories to return (1-${MAX_SEARCH_LIMIT}, default ${DEFAULT_SEARCH_LIMIT}).`,
        }),
      ),
    }),
    async execute(_id, params) {
      const query = params.query as string;
      const limit = Math.min((params.limit as number | undefined) ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
      const hits = await client.search(query, limit);
      if (hits.length === 0) return ok("(no memories found)");
      const rendered = hits
        .map((h) => {
          const score = typeof h.score === "number" ? h.score.toFixed(3) : "?";
          const date = h.createdAt?.slice(0, 10) ?? "?";
          return `[${score}] ${date} ${h.id}: ${h.content}`;
        })
        .join("\n");
      const trimmed =
        rendered.length <= MAX_RESULT_CHARS ? rendered : `${rendered.slice(0, MAX_RESULT_CHARS)}…`;
      return ok(trimmed);
    },
  });

  // --- flair_write -------------------------------------------------------
  pi.registerTool({
    name: "flair_write",
    label: "Flair Memory Write",
    description:
      "Store a durable memory worth remembering across sessions. Prefer persistent/permanent for stable facts; standard for working notes.",
    parameters: Type.Object({
      content: Type.String({ minLength: 1, description: "The memory to store." }),
      durability: Type.Optional(
        Type.Union(
          DURABILITY_VALUES.map((d) => Type.Literal(d)),
          {
            description:
              "ephemeral < standard < persistent < permanent (default standard). Higher = kept longer/through consolidation.",
          },
        ),
      ),
      supersedes: Type.Optional(
        Type.String({ description: "Id of an existing memory this one replaces." }),
      ),
    }),
    async execute(_id, params) {
      const content = params.content as string;
      const durability = params.durability as Durability | undefined;
      const supersedes = params.supersedes as string | undefined;
      const { id } = await client.write(content, { durability, supersedes });
      return ok(`stored memory ${id}`);
    },
  });

  // --- flair_get ---------------------------------------------------------
  pi.registerTool({
    name: "flair_get",
    label: "Flair Memory Get",
    description: "Fetch a single memory by its id (e.g. one returned by flair_search).",
    parameters: Type.Object({
      id: Type.String({ minLength: 1, description: "The memory id." }),
    }),
    async execute(_id, params) {
      const id = params.id as string;
      const mem = await client.get(id);
      if (!mem) return ok("(not found)");
      return ok(JSON.stringify(mem));
    },
  });

  log("flair capability: registered flair_search / flair_write / flair_get");
}
