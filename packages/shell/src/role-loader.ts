import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { MiltonRole } from "./index.js";

export interface RoleTemplate {
  role: MiltonRole;
  soul: string; // markdown persona file contents
  tools: {
    allow: string[];
  };
  default_provider?: string;
  default_model?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Roles ship in examples/roles/<role>/ relative to repo root. The shell
// resolves them via a lookup table so a Milton install (npm) finds them
// in node_modules/@tpsdev-ai/milton-shell/roles/, and a workspace install
// finds them in ../../examples/roles/.
const CANDIDATE_PATHS = [
  // Built into the package (post-npm-publish)
  join(__dirname, "..", "roles"),
  // Workspace dev (cloned repo)
  join(__dirname, "..", "..", "..", "examples", "roles"),
];

// Role names must be lowercase alphanumerics + hyphens. Defense against
// caller-controlled path traversal: a role like "../../../etc" would
// escape CANDIDATE_PATHS via join(); the regex blocks any such input
// before it reaches the filesystem.
const ROLE_NAME = /^[a-z0-9-]+$/;

export function loadRole(role: MiltonRole): RoleTemplate {
  if (!ROLE_NAME.test(role)) {
    throw new Error(`invalid role name: ${role} (must match ${ROLE_NAME})`);
  }
  for (const base of CANDIDATE_PATHS) {
    const dir = join(base, role);
    if (!existsSync(dir)) continue;
    const soulPath = join(dir, "soul.md");
    const configPath = join(dir, "role.json");
    if (!existsSync(soulPath) || !existsSync(configPath)) continue;
    const soul = readFileSync(soulPath, "utf8");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Omit<RoleTemplate, "soul" | "role">;
    return { role, soul, ...config };
  }
  throw new Error(`unknown role: ${role}. Looked in: ${CANDIDATE_PATHS.join(", ")}`);
}
