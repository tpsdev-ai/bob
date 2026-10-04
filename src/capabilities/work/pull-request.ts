// Pull-request creation for `publish` (bob#275, slice S2b).
//
// PR creation reaches the authorized repository through the SAME credential the
// push uses. On this fleet git's credential helper for github.com is
// `gh auth git-credential`, so `gh` reads exactly the credential `git push`
// already used. No token is read from a new environment variable and nothing is
// added to the agent's environment: the production service runs `gh`, which the
// agent already has.
//
// `publish` never calls this module directly — it drives an injected
// `PullRequestService` (deps.pr). Tests supply a fake, so no network is used.

import { spawn } from "node:child_process";

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
  repository?: string;
  number?: number;
  state?: string;
}

export interface PullRequestService {
  create(input: CreatePullRequestInput): Promise<PullRequestRecord>;
  // Every pull request for the repository and branch pair, open, closed and
  // merged. A list that cannot be read throws; an empty list is an answer.
  list(input: { repository: string; head: string; base: string }): Promise<PullRequestRecord[]>;
}

// The marker persisted in the PR body, so recovery can recognize the PR THIS
// publication created. It is derived from the publication identity, not from
// the title or the free-form body the caller supplies.
export function publicationMarker(publicationId: string): string {
  return `<!-- bob-publication:${publicationId} -->`;
}

// The effective PR body: the caller's body, with the marker appended on its own
// paragraph so a reader never sees it as part of the description.
export function bodyWithMarker(body: string, marker: string): string {
  const trimmed = body.replace(/\s+$/, "");
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

// The production service: `gh api`, using the credential git's push used.
export function ghPullRequestService(
  gh = "gh",
  env: NodeJS.ProcessEnv = process.env,
): PullRequestService {
  return {
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
      const url = (parsed as { html_url?: unknown } | null)?.html_url;
      if (typeof url !== "string" || url === "") throw new Error("gh returned no pull request URL");
      return { url, head: input.head, base: input.base, body: input.body };
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
        ],
        env,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(out);
      } catch {
        throw new Error("gh returned no pull request list");
      }
      if (!Array.isArray(parsed)) throw new Error("gh returned no pull request list");
      return parsed.map((raw) => {
        const r = raw as {
          html_url?: unknown;
          body?: unknown;
          head?: { ref?: unknown };
          base?: { ref?: unknown };
          number?: unknown;
          state?: unknown;
        };
        return {
          url: typeof r.html_url === "string" ? r.html_url : "",
          head: typeof r.head?.ref === "string" ? r.head.ref : "",
          base: typeof r.base?.ref === "string" ? r.base.ref : "",
          body: typeof r.body === "string" ? r.body : "",
          ...(typeof r.number === "number" ? { number: r.number } : {}),
          ...(typeof r.state === "string" ? { state: r.state } : {}),
        };
      });
    },
  };
}
