// `bob align` interactive flow.
//
// Counterpart to `runOnboard`: instead of an initial hiring interview,
// this is a recurring "what's changed?" check-in for an already-formed
// agent. The agent reads its own current soul.md and the human surfaces
// drift, new constraints, or fresh signal; the agent rewrites soul.md.
//
// Same spawn/observe shape as onboard — soul.md hash before/after tells
// us whether the alignment actually produced a persona update.

import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SpawnFn } from "./onboard.js";

export interface AlignOptions {
  name: string;
  agentDir: string;
  provider: string;
  model: string;
  piBin?: string;
  spawnFn?: SpawnFn;
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

export async function runAlign(opts: AlignOptions): Promise<AlignResult> {
  const soulPath = join(opts.agentDir, "soul.md");
  if (!existsSync(soulPath)) {
    throw new Error(`cannot align ${opts.name}: ${soulPath} not found — run 'bob onboard' first`);
  }
  const soulHashBefore = hashFile(soulPath);
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
    META_PROMPT(opts.name, soulPath),
    `Hi ${opts.name}. Quick alignment check — what feels off, what's drifted, what's new? Read your soul at ${soulPath} first.`,
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
