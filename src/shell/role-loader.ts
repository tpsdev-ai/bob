import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { BobRole } from "./index.js";
import { ModelBudgetError, parseSessionBudget, type SessionBudget } from "./session-budget.js";

export interface RoleTemplate {
  role: BobRole;
  soul: string; // markdown persona file contents
  // The role's tool policy — the CEILING an agent's bob.yaml can narrow but
  // never widen (tool-allowlist.ts). `allowResidentShell` moves the residency
  // opt-in here, out of bob.yaml: whether an unattended agent keeps a shell is
  // a property of the ROLE, not of a file the agent itself can edit.
  tools: {
    allow: string[];
    allowResidentShell?: boolean;
    // bob#244: removes the resident egress exclusion for the web tools (an
    // explicit tools.exclude entry still wins). The shell grant above does not
    // cover them.
    allowResidentWeb?: boolean;
  };
  default_provider?: string;
  default_model?: string;
  // bob#214: the role's session budget — when to compact (a fraction of the
  // model's context window, checked between model calls) and how much to think
  // (off | low | high). bob.yaml's `session:` block overrides either key for
  // one agent. Absent: pi's own defaults. Validated at load: an unknown key or
  // a malformed value is a load error, like any other role.json defect.
  session?: SessionBudget;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Roles ship at <repo>/roles/<role>/ in a checkout AND at
// node_modules/@tpsdev-ai/bob/roles/<role>/ after npm install (the
// `files: ["dist", "bin", "roles"]` in package.json puts them in the
// published tarball). This module sits two levels below the package
// root in BOTH shapes — src/shell/role-loader.ts in a checkout,
// dist/shell/role-loader.js once built — so one path covers both.
const CANDIDATE_PATHS = [join(__dirname, "..", "..", "roles")];

// Role names must be lowercase alphanumerics + hyphens. Defense against
// caller-controlled path traversal: a role like "../../../etc" would
// escape CANDIDATE_PATHS via join(); the regex blocks any such input
// before it reaches the filesystem.
const ROLE_NAME = /^[a-z0-9-]+$/;

export function loadRole(role: BobRole): RoleTemplate {
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
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Omit<
      RoleTemplate,
      "soul" | "role"
    > & { session?: unknown };
    let session: SessionBudget | undefined;
    if (config.session !== undefined) {
      if (
        config.session === null ||
        typeof config.session !== "object" ||
        Array.isArray(config.session)
      ) {
        throw new ModelBudgetError(`${configPath}: "session" must be an object.`);
      }
      session = parseSessionBudget(
        config.session as Record<string, unknown>,
        `${configPath} "session"`,
      );
    }
    return { role, soul, ...config, ...(session !== undefined ? { session } : {}) } as RoleTemplate;
  }
  throw new Error(`unknown role: ${role}. Looked in: ${CANDIDATE_PATHS.join(", ")}`);
}
