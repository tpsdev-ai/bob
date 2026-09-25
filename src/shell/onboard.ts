// `bob onboard` interactive flow.
//
// The Office Space "restructuring consultants" pattern: start pi's interactive
// TUI with a meta-system-prompt that frames the session as a hiring interview.
// The agent interviews the human about the role, then writes its own persona to
// soul.md. When the human exits the session, bob reads back soul.md and reports
// whether it was updated.
//
// The session comes from bob's ONE factory through pi's InteractiveMode
// (session.ts) — bob never spawns the pi CLI, and no argument reaches the
// session. The interview runs under the FIXED setup policy
// (read + write, session.ts SETUP_TOOL_POLICY), which may exceed the role's
// ceiling: onboarding and alignment are privileged local setup commands
// available to whoever runs bob as that OS user (see README "Stated
// exceptions"). A model can only reach them through a shell tool, and a role
// with a shell already has write.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { mapBobProviderToPi, type RunSessionConfig, resolveRunConfig } from "./run.js";
import { runInteractiveSession, SETUP_TOOL_POLICY, type SessionDeps } from "./session.js";
import type { ToolPolicy } from "./tool-allowlist.js";

export interface OnboardOptions {
  // Agent identity (must already exist on disk via initAgent).
  name: string;
  role: string;
  agentDir: string;
  // Provider + model for the interview. bob.yaml is stamped from these at init
  // time; when given here they override the file for this session only (the
  // same per-call semantics as `bob run --model`).
  provider: string;
  model: string;
  // Test seam: run the interactive session. Defaults to pi's InteractiveMode
  // over bob's session runtime.
  sessionRunner?: SessionRunner;
  deps?: SessionDeps;
}

// The interactive-session seam. Defaults to pi's InteractiveMode; tests inject
// one that drives a fake session (no TTY, no model).
export type SessionRunner = (input: {
  config: RunSessionConfig;
  policy: ToolPolicy;
  initialMessage: string;
  deps?: SessionDeps;
}) => Promise<number>;

export interface OnboardResult {
  exitCode: number;
  soulUpdated: boolean;
  soulPath: string;
  soulHashBefore: string;
  soulHashAfter: string;
}

// Mirror of init.ts AGENT_NAME — agent names are filesystem paths AND get
// embedded in system prompts, so the regex doubles as path-traversal +
// prompt-injection defense (no `..`, no `/`, no newlines).
const AGENT_NAME = /^[a-z0-9-]+$/;
const ROLE_NAME = /^[a-z0-9-]+$/;

const META_PROMPT = (name: string, role: string, soulPath: string) =>
  `
You are being onboarded as a new agent named "${name}" into the "${role}" role at TPS / LifestyleLab.
This session is a hiring interview — the human in front of you is shaping your persona through conversation.

Your job in this session:
1. Read the seed persona at ${soulPath}. Treat it as a starting point, not a final answer.
2. Interview the human. Open with the Bob question — "What would you say... you'd want me to do here?" — and follow up with whatever you need to do the job well:
   - What's the founder's working style? Tone? What gets surfaced, what gets filtered?
   - What does "good" look like in this role? What does "bad" look like?
   - What channels do you operate in? Who are your peers?
   - What hard rules exist? What's off-limits?
   - What's the founder's pet peeve about people in this role?
3. As you learn, refine the persona DRAFT in your head. Don't write to disk yet.
4. When the human signals they're done ("ship it", "that's enough", "we're good", or similar),
   write the FULL refined persona to ${soulPath} using the Write tool, OVERWRITING whatever is there.
   The persona should be markdown, first-person, written in YOUR voice as ${name}.
5. After writing, summarize in one sentence what you wrote, then wait for the human to exit.

Do NOT:
- Treat this as a coding task — it's a conversation.
- Write to soul.md prematurely or repeatedly.
- Make up facts about the team or environment. Ask.
- Be servile. You're being hired as a peer, not a butler.

The conversation should feel like a real interview — short turns, real curiosity,
and ending with a persona that's recognizably ${name}, not a template.
`.trim();

const FIRST_MESSAGE = (name: string, role: string, soulPath: string) =>
  `Hello ${name}. We're going to shape your persona for the ${role} role. Start by reading your seed soul at ${soulPath}, then interview me. When you have what you need, write the refined persona back.`;

export async function runOnboard(opts: OnboardOptions): Promise<OnboardResult> {
  if (!AGENT_NAME.test(opts.name)) {
    throw new Error(`invalid agent name: ${JSON.stringify(opts.name)} (must match ${AGENT_NAME})`);
  }
  if (!ROLE_NAME.test(opts.role)) {
    throw new Error(`invalid role: ${JSON.stringify(opts.role)} (must match ${ROLE_NAME})`);
  }
  const soulPath = join(opts.agentDir, "soul.md");
  const soulHashBefore = hashFile(soulPath);

  // The interview session runs the agent's OWN config (bob.yaml capabilities,
  // cwd, credentials) with the interview meta-prompt appended, and the fixed
  // setup policy — never the role's ceiling, which is what makes the interview
  // able to write soul.md at all.
  const { config } = resolveRunConfig({
    name: opts.name,
    agentsRoot: dirname(opts.agentDir),
  });
  const sessionConfig: RunSessionConfig = {
    ...config,
    provider: mapBobProviderToPi(opts.provider),
    model: opts.model,
    appendSystemPrompt: META_PROMPT(opts.name, opts.role, soulPath),
  };

  const runner = opts.sessionRunner ?? runInteractiveSession;
  const exitCode = await runner({
    config: sessionConfig,
    policy: SETUP_TOOL_POLICY,
    initialMessage: FIRST_MESSAGE(opts.name, opts.role, soulPath),
    deps: opts.deps,
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
