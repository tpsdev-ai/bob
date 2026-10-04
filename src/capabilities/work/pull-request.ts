import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { publicationEnvironment } from "./publication-environment.js";

export interface CreatePullRequestInput {
  // The authorized repository: the resolved publication endpoint.
  repository: string;
  head: string;
  base: string;
  title: string;
  body: string;
}

export interface PullRequestRecord {
  url: string;
  head: string;
  base: string;
  body: string;
  repository: string;
  headRepository: string;
  commitOid: string;
  author: string;
  number?: number;
  state?: string;
}

export interface PullRequestService {
  identity(): Promise<string>;
  supportsEndpoint?(endpoint: string): boolean;
  create(input: CreatePullRequestInput): Promise<PullRequestRecord>;
  // Every pull request for the repository and branch pair, open, closed and
  // merged. A list that cannot be read throws; an empty list is an answer.
  list(input: { repository: string; head: string; base: string }): Promise<PullRequestRecord[]>;
}

export function publicationMarker(publicationId: string): string {
  return `<!-- bob-publication:${publicationId}:${randomBytes(32).toString("hex")} -->`;
}

export function bodyWithMarker(body: string, marker: string): string {
  const trimmed = body
    .replace(/<!--\s*bob-publication:[\s\S]*?(?:-->|$)/gi, "")
    .replace(/bob-publication:[^\s<>]*/gi, "")
    .replace(/\s+$/, "");
  return trimmed === "" ? marker : `${trimmed}\n\n${marker}`;
}

// owner/repo from a GitHub endpoint, or null when it is not a GitHub remote.
export function githubRepositorySlug(endpoint: string): { owner: string; name: string } | null {
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
    /^(?:ssh:\/\/)?(?:[^@/]+@)?github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
    /^git:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/,
  ];
  for (const re of patterns) {
    const m = re.exec(endpoint);
    if (m !== null) return { owner: m[1], name: m[2] };
  }
  return null;
}

function runGh(gh: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(gh, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    child.stdout.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      err += chunk.toString("utf8");
    });
    child.on("error", (e) =>
      finish(() => reject(new Error(`gh could not be started (${e.message})`))),
    );
    child.on("close", (code) =>
      finish(() => {
        if (code === 0) resolve(out);
        else reject(new Error(`gh exited ${code ?? "unknown"}: ${err.trim() || out.trim()}`));
      }),
    );
  });
}

export function ghPullRequestService(
  gh = "gh",
  env: NodeJS.ProcessEnv = publicationEnvironment(),
): PullRequestService {
  return {
    supportsEndpoint: (endpoint) =>
      /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/.test(endpoint),
    async identity() {
      const raw = JSON.parse(await runGh(gh, ["api", "user"], env)) as { login?: unknown };
      if (typeof raw?.login !== "string" || raw.login === "")
        throw new Error("gh returned no publishing identity");
      return raw.login;
    },
    async create(input: CreatePullRequestInput): Promise<PullRequestRecord> {
      const slug = githubRepositorySlug(input.repository);
      if (slug === null)
        throw new Error(`the authorized endpoint ${input.repository} is not a GitHub repository`);
      const out = await runGh(
        gh,
        [
          "api",
          "--method",
          "POST",
          `repos/${slug.owner}/${slug.name}/pulls`,
          "-f",
          `head=${input.head}`,
          "-f",
          `base=${input.base}`,
          "-f",
          `title=${input.title}`,
          "-f",
          `body=${input.body}`,
        ],
        env,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(out);
      } catch {
        throw new Error("gh returned no pull request JSON");
      }
      return parsePullRequest(parsed);
    },
    async list(input: {
      repository: string;
      head: string;
      base: string;
    }): Promise<PullRequestRecord[]> {
      const slug = githubRepositorySlug(input.repository);
      if (slug === null)
        throw new Error(`the authorized endpoint ${input.repository} is not a GitHub repository`);
      const out = await runGh(
        gh,
        [
          "api",
          "--method",
          "GET",
          `repos/${slug.owner}/${slug.name}/pulls`,
          "-f",
          "state=all",
          "-f",
          `head=${slug.owner}:${input.head}`,
          "-f",
          `base=${input.base}`,
          "--paginate",
          "--slurp",
        ],
        env,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(out);
      } catch {
        throw new Error("gh returned no pull request list");
      }
      if (!Array.isArray(parsed) || !parsed.every(Array.isArray))
        throw new Error("gh returned no pull request pages");
      return parsed.flatMap((page) => page.map(parsePullRequest));
    },
  };
}

function parsePullRequest(raw: unknown): PullRequestRecord {
  const r = raw as {
    html_url?: unknown;
    body?: unknown;
    head?: { ref?: unknown; sha?: unknown; repo?: { html_url?: unknown } };
    base?: { ref?: unknown; repo?: { html_url?: unknown } };
    user?: { login?: unknown };
    number?: unknown;
    state?: unknown;
  } | null;
  if (r === null || typeof r !== "object") throw new Error("gh returned no pull request");
  return {
    url: typeof r.html_url === "string" ? r.html_url : "",
    head: typeof r.head?.ref === "string" ? r.head.ref : "",
    base: typeof r.base?.ref === "string" ? r.base.ref : "",
    body: typeof r.body === "string" ? r.body : "",
    repository: typeof r.base?.repo?.html_url === "string" ? r.base.repo.html_url : "",
    headRepository: typeof r.head?.repo?.html_url === "string" ? r.head.repo.html_url : "",
    commitOid: typeof r.head?.sha === "string" ? r.head.sha : "",
    author: typeof r.user?.login === "string" ? r.user.login : "",
    ...(typeof r.number === "number" ? { number: r.number } : {}),
    ...(typeof r.state === "string" ? { state: r.state } : {}),
  };
}
