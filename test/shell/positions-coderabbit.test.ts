import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_POSITIONS_ROOT } from "../../src/shell/index.js";

function child(source: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["-e", source], {
    cwd: join(import.meta.dir, "..", ".."),
    env: { ...process.env, ...env },
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("CodeRabbit positions regressions", () => {
  it("override repo ignores operator signing, hooksPath and template hooks", () => {
    const base = mkdtempSync(join(tmpdir(), "bob-override-git-"));
    try {
      const hooks = join(base, "hooks");
      const templateHooks = join(base, "template", "hooks");
      mkdirSync(hooks, { recursive: true });
      mkdirSync(templateHooks, { recursive: true });
      const hook = '#!/bin/sh\nprintf run > "$BOB_HOOK_SENTINEL"\n';
      for (const dir of [hooks, templateHooks]) {
        const path = join(dir, "pre-commit");
        writeFileSync(path, hook);
        chmodSync(path, 0o755);
      }
      const globalConfig = join(base, "gitconfig");
      writeFileSync(
        globalConfig,
        `[commit]\n\tgpgsign = true\n[core]\n\thooksPath = ${hooks}\n[init]\n\ttemplateDir = ${join(base, "template")}\n`,
      );
      const sentinel = join(base, "hook-ran");
      const agentDir = join(base, "agent");
      mkdirSync(agentDir);
      const result = child(
        'import { initOverrideRepo } from "./src/shell/index.ts"; initOverrideRepo(process.env.BOB_AGENT_DIR!);',
        {
          GIT_CONFIG_GLOBAL: globalConfig,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TEMPLATE_DIR: join(base, "template"),
          BOB_AGENT_DIR: agentDir,
          BOB_HOOK_SENTINEL: sentinel,
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(existsSync(sentinel)).toBe(false);
      expect(existsSync(join(agentDir, "overrides", ".git"))).toBe(true);
      expect(existsSync(join(agentDir, "overrides", ".git", "hooks", "pre-commit"))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("hire interview uses the supplied host and positions roots despite a conflicting default grant", () => {
    const base = mkdtempSync(join(tmpdir(), "bob-hire-roots-"));
    try {
      const agentsRoot = join(base, "agents");
      const hostRoot = join(base, "host");
      const positionsRoot = join(base, "positions");
      mkdirSync(agentsRoot);
      mkdirSync(positionsRoot);
      cpSync(join(DEFAULT_POSITIONS_ROOT, "builder"), join(positionsRoot, "builder"), {
        recursive: true,
      });
      const result = child(
        `
        import { defaultHostRoot, grantPath, hireAgent } from "./src/shell/index.ts";
        import { mkdirSync, writeFileSync } from "node:fs";
        import { dirname } from "node:path";
        const path = grantPath(defaultHostRoot(), "roots");
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, JSON.stringify({agent:"roots", role:"coder", position:{name:"ghost", version:"1", hash:"h"}, maxTools:[], maxCapabilities:[], allowResidentShell:false, ratifiedAt:"now"}));
        let seen;
        await hireAgent({name:"roots", positionName:"builder", agentsRoot:process.env.BOB_AGENTS_ROOT, hostRoot:process.env.BOB_HOST_ROOT, positionsRoot:process.env.BOB_POSITIONS_ROOT, skipFlair:true, interview:async ({policy}) => { seen = policy; return 0; }});
        process.stdout.write(JSON.stringify(seen));
      `,
        {
          HOME: base,
          BOB_AGENTS_ROOT: agentsRoot,
          BOB_HOST_ROOT: hostRoot,
          BOB_POSITIONS_ROOT: positionsRoot,
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      const policy = JSON.parse(result.stdout) as { tools: string[] };
      expect(policy.tools).toEqual(["read", "write"]);
      expect(existsSync(join(hostRoot, "grants", "roots.json"))).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("hire interview resolves a position from the supplied positions root", () => {
    const base = mkdtempSync(join(tmpdir(), "bob-hire-position-root-"));
    try {
      const agentsRoot = join(base, "agents");
      const hostRoot = join(base, "host");
      const positionsRoot = join(base, "positions");
      mkdirSync(agentsRoot);
      mkdirSync(positionsRoot);
      cpSync(join(DEFAULT_POSITIONS_ROOT, "builder"), join(positionsRoot, "local"), {
        recursive: true,
      });
      const manifestPath = join(positionsRoot, "local", "position.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { name: string };
      manifest.name = "local";
      writeFileSync(manifestPath, JSON.stringify(manifest));
      const result = child(
        `
        import { hireAgent, loadPosition, writeGrant } from "./src/shell/index.ts";
        const name = "local-roots";
        const positionsRoot = process.env.BOB_POSITIONS_ROOT;
        const hostRoot = process.env.BOB_HOST_ROOT;
        const p = loadPosition("local", {root:positionsRoot});
        await hireAgent({name, positionName:"local", agentsRoot:process.env.BOB_AGENTS_ROOT, hostRoot, positionsRoot, skipFlair:true,
          commitHook(step) { if (step === "scaffold") writeGrant(hostRoot, {agent:name, role:p.manifest.role, position:{name:p.manifest.name, version:p.manifest.version, hash:p.hash}, maxTools:p.manifest.tools, maxCapabilities:p.manifest.capabilities.permitted, allowResidentShell:true, ratifiedAt:"now"}); },
          interview:async () => 0});
      `,
        {
          HOME: base,
          BOB_AGENTS_ROOT: agentsRoot,
          BOB_HOST_ROOT: hostRoot,
          BOB_POSITIONS_ROOT: positionsRoot,
        },
      );
      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
