// `bob align` interactive flow.
//
// Counterpart to `runOnboard`: instead of an initial hiring interview,
// this is a recurring "what's changed?" check-in for an already-formed
// agent. The agent reads its own current soul.md and the human surfaces
// drift, new constraints, or fresh signal; the agent rewrites soul.md.
//
// Same session shape as onboard — bob's factory through pi's InteractiveMode,
// under the fixed setup policy (read + write) — and the same soul.md
// hash-before/after test of whether the alignment actually produced a persona
// update.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SessionRunner } from "./onboard.js";
import { mapBobProviderToPi, type RunSessionConfig, resolveRunConfig } from "./run.js";
import { runInteractiveSession, SETUP_TOOL_POLICY } from "./session.js";

// Same path-traversal + prompt-injection defense as runOnboard.
const AGENT_NAME = /^[a-z0-9-]+$/;

export interface AlignOptions {
  name: string;
  agentDir: string;
  provider: string;
  model: string;
  // Test seam: the interactive session. Defaults to pi's InteractiveMode over
  // bob's session runtime.
  sessionRunner?: SessionRunner;
}

export interface AlignResult {
  exitCode: number;
  soulUpdated: boolean;
  soulPath: string;
  soulHashBefore: string;
  soulHashAfter: string;
}

const META_PROMPT = (name: string, soulPath: string) =>
  `
You are ${name}. Time for a recurring alignment check — the founder is
reviewing how well your current persona still fits the role you do every day.

Your job in this session:
1. Read your current persona at ${soulPath}. This is who you are right now.
2. Surface what might be drifting:
   - Habits you've picked up that aren't in the persona
   - Things in the persona that aren't true anymore
   - New constraints, peers, channels, or rules that should be added
   - Pet peeves the founder has voiced lately
3. Ask short, specific questions. Don't fish — anchor on concrete signals.
4. When the human signals they're done ("ship it", "looks good", or similar),
   write the UPDATED full persona to ${soulPath} via the Write tool,
   OVERWRITING the previous version.
5. Summarize the deltas in one sentence after writing, then wait for exit.

Do NOT:
- Rewrite the persona from scratch when it just needs nudges.
- Treat alignment as re-onboarding. You already know who you are.
- Make up changes to feel productive. If nothing's drifted, say so and exit.

This is a 5-10 minute conversation, not a session. Keep it tight.
`.trim();

const FIRST_MESSAGE = (name: string, soulPath: string) =>
  `Hi ${name}. Quick alignment check — what feels off, what's drifted, what's new? Read your soul at ${soulPath} first.`;

export async function runAlign(opts: AlignOptions): Promise<AlignResult> {
  if (!AGENT_NAME.test(opts.name)) {
    throw new Error(`invalid agent name: ${JSON.stringify(opts.name)} (must match ${AGENT_NAME})`);
  }
  const soulPath = join(opts.agentDir, "soul.md");
  if (!existsSync(soulPath)) {
    throw new Error(`cannot align ${opts.name}: ${soulPath} not found — run 'bob onboard' first`);
  }
  const soulHashBefore = hashFile(soulPath);

  const { config } = resolveRunConfig({
    name: opts.name,
    agentsRoot: dirname(opts.agentDir),
  });
  const sessionConfig: RunSessionConfig = {
    ...config,
    provider: mapBobProviderToPi(opts.provider),
    model: opts.model,
    appendSystemPrompt: META_PROMPT(opts.name, soulPath),
  };

  const runner = opts.sessionRunner ?? runInteractiveSession;
  const exitCode = await runner({
    config: sessionConfig,
    policy: SETUP_TOOL_POLICY,
    initialMessage: FIRST_MESSAGE(opts.name, soulPath),
  });

  const soulHashAfter = hashFile(soulPath);
  return {
    exitCode,
    soulUpdated: soulHashBefore !== soulHashAfter,
    soulPath,
    soulHashBefore,
    soulHashAfter,
  };
}

function hashFile(path: string): string {
  if (!existsSync(path)) return "";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
