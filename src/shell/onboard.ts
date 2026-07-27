// `bob onboard` interactive flow.
//
// The Office Space "restructuring consultants" pattern: spawn pi-coding-agent
// with a meta-system-prompt that frames the session as a hiring interview.
// The agent interviews the human about the role, then writes its own
// persona to soul.md. When the human exits the session, Bob reads back
// soul.md and reports whether it was updated.
//
// We delegate the entire conversation to pi — Bob is just the dispatcher
// that arms the right system prompt, points pi at the right session dir,
// and observes the soul.md before/after.

import { type ChildProcess, spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface OnboardOptions {
  // Agent identity (must already exist on disk via initAgent).
  name: string;
  role: string;
  agentDir: string;
  // Provider + model passed through to pi. Defaults pulled from the role
  // template if not given. Caller wires this.
  provider: string;
  model: string;
  // Override the pi binary (tests). Defaults to "pi".
  piBin?: string;
  // Override child_process.spawn (tests).
  spawnFn?: SpawnFn;
}

export interface OnboardResult {
  exitCode: number;
  soulUpdated: boolean;
  soulPath: string;
  soulHashBefore: string;
  soulHashAfter: string;
}

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

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

export async function runOnboard(opts: OnboardOptions): Promise<OnboardResult> {
  if (!AGENT_NAME.test(opts.name)) {
    throw new Error(`invalid agent name: ${JSON.stringify(opts.name)} (must match ${AGENT_NAME})`);
  }
  if (!ROLE_NAME.test(opts.role)) {
    throw new Error(`invalid role: ${JSON.stringify(opts.role)} (must match ${ROLE_NAME})`);
  }
  const soulPath = join(opts.agentDir, "soul.md");
  const soulHashBefore = hashFile(soulPath);
  // TODO(phase1): migrate to SDK — embed pi via createAgentSession instead of
  // spawning the `pi` binary (mirrors run.ts). Kept as a subprocess for now;
  // PR1 only migrates the non-interactive prompt path in run.ts.
  const spawnFn = opts.spawnFn ?? (nodeSpawn as SpawnFn);
  const piBin = opts.piBin ?? "pi";

  const sessionDir = join(opts.agentDir, ".pi-agent");
  const workDir = join(opts.agentDir, "work");

  const args = [
    "--provider",
    opts.provider,
    "--model",
    opts.model,
    "--session-dir",
    sessionDir,
    "--append-system-prompt",
    META_PROMPT(opts.name, opts.role, soulPath),
    `Hello ${opts.name}. We're going to shape your persona for the ${opts.role} role. Start by reading your seed soul at ${soulPath}, then interview me. When you have what you need, write the refined persona back.`,
  ];

  const exitCode = await spawnAndWait(spawnFn, piBin, args, {
    cwd: workDir,
    stdio: "inherit",
    env: process.env,
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

function spawnAndWait(
  spawnFn: SpawnFn,
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawnFn(command, args, options);
    child.on("error", reject);
    child.on("exit", (code) => resolve(code ?? 0));
  });
}

function hashFile(path: string): string {
  if (!existsSync(path)) return "";
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
