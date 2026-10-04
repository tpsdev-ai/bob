// publish — PR creation inside `publish` (bob#275, S2b).
//
// Local git fixtures and a fake PR service; no network. Cases drive `publish`
// directly with real Git (a real builder repository and a real bare remote in
// the test's temp dir).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyPatch,
  type GitInvocation,
  type GitResult,
} from "../../../src/capabilities/work/apply-patch.js";
import {
  bodyWithMarker,
  type CheckReport,
  type CheckRunner,
  githubRepositorySlug,
  type PublishParams,
  type PublishPrRequest,
  type PullRequestService,
  publicationMarker,
  publish,
  publishJournalPath,
} from "../../../src/capabilities/work/index.js";
import type { TaskBinding } from "../../../src/capabilities/work/task-binding.js";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "bob-publish-pr-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function gitEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@t",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@t",
  };
}

function realGit(args: string[], inv: GitInvocation): GitResult {
  const env: NodeJS.ProcessEnv = { ...gitEnv() };
  if (inv.indexFile !== undefined) env.GIT_INDEX_FILE = inv.indexFile;
  const r = spawnSync("git", args, {
    cwd: inv.cwd,
    env,
    input: inv.input,
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.error) return { status: -1, stdout: "", stderr: r.error.message };
  return {
    status: r.status ?? -1,
    stdout: (r.stdout ?? Buffer.alloc(0)).toString("utf8"),
    stderr: (r.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

function git(args: string[], cwd: string): string {
  const r = realGit(args, { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Fixture {
  repo: string;
  bare: string;
  artifactRoot: string;
  base: string;
  stateRoot: string;
}

function makeFixture(name = "fx"): Fixture {
  const root = join(scratch, name);
  const repo = join(root, "repo");
  const bare = join(root, "remote.git");
  const artifactRoot = join(root, "artifacts");
  const stateRoot = join(root, "state");
  mkdirSync(repo, { recursive: true });
  mkdirSync(artifactRoot, { recursive: true });
  git(["init", "-q"], repo);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "widget.ts"), "export const widget = 1;\n");
  writeFileSync(join(repo, "README.md"), "readme\n");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "base"], repo);
  git(["init", "-q", "--bare", bare], root);
  const base = git(["rev-parse", "HEAD"], repo);
  return { repo, bare, artifactRoot, base, stateRoot };
}

function seedRemote(fx: Fixture): void {
  git(["push", fx.bare, "HEAD:refs/heads/main"], fx.repo);
}

function patchFrom(fx: Fixture, mutate: (repo: string) => void): { patch: Buffer; tree: string } {
  mutate(fx.repo);
  git(["add", "-A"], fx.repo);
  git(["commit", "-qm", "change"], fx.repo);
  const tree = git(["rev-parse", "HEAD^{tree}"], fx.repo);
  const diff = realGit(["diff", "--binary", "-M", "-C", fx.base, "HEAD"], { cwd: fx.repo });
  if (diff.status !== 0) throw new Error(`git diff failed: ${diff.stderr}`);
  const patch = Buffer.from(diff.stdout, "utf8");
  git(["reset", "--hard", "-q", fx.base], fx.repo);
  return { patch, tree };
}

function binding(fx: Fixture, over: Partial<TaskBinding> = {}): TaskBinding {
  return {
    task_id: "task-1",
    publication_id: "pub-pr",
    repository: fx.repo,
    workspace: fx.repo,
    base_oid: fx.base,
    mode: "build",
    artifact_root: fx.artifactRoot,
    declared_paths: ["src/widget.ts"],
    check_commands: [],
    destination: { remote: fx.bare, ref: "refs/heads/main", create: true },
    ...over,
  };
}

function buildCandidate(
  fx: Fixture,
  b: TaskBinding,
  mutate: (repo: string) => void,
): { candidate_id: string; tree_oid: string } {
  const { patch, tree } = patchFrom(fx, mutate);
  writeFileSync(join(fx.artifactRoot, "p.patch"), patch);
  const out = applyPatch({
    binding: b,
    params: {
      patch_artifact: { path: "p.patch", sha256: sha256(patch) },
      expected_base: b.base_oid,
    },
    stateRoot: fx.stateRoot,
    deps: { git: realGit },
  });
  if (!out.ok) throw new Error(`applyPatch refused: ${out.reason} ${out.message}`);
  expect(out.tree_oid).toBe(tree);
  return { candidate_id: out.candidate_id, tree_oid: out.tree_oid };
}

const okCheck: CheckRunner = async (): Promise<CheckReport> => ({
  outcome: "exited",
  exit_code: 0,
  cleanup_state: "group_empty",
  output_complete: true,
});

function prParams(
  built: { candidate_id: string },
  over: Partial<PublishPrRequest> = {},
): PublishParams {
  return {
    candidate_id: built.candidate_id,
    commit_message: "feat: a change",
    pr: { title: "A change", body: "Why.", ...over },
  };
}

function remoteOid(fx: Fixture): string | null {
  const r = realGit(["ls-remote", fx.bare, "refs/heads/main"], { cwd: fx.repo });
  if (r.status !== 0) throw new Error(`ls-remote failed: ${r.stderr}`);
  const line = r.stdout.trim();
  return line === "" ? null : line.split(/\s+/)[0];
}

interface FakePr {
  url: string;
  head: string;
  base: string;
  body: string;
  repository?: string;
  headRepository?: string;
  commitOid?: string;
  author?: string;
  state?: string;
}

interface FakePrService {
  service: PullRequestService;
  created: Array<{ repository: string; head: string; base: string; title: string; body: string }>;
  listCalls: Array<{ repository: string; head: string; base: string }>;
  store: FakePr[];
  state: { failList: boolean; failCreateBeforeRecord: boolean; failCreateAfterRecord: boolean };
}

function fakePullRequests(fx: Fixture, seed: FakePr[] = []): FakePrService {
  const created: FakePrService["created"] = [];
  const listCalls: FakePrService["listCalls"] = [];
  const store: FakePr[] = seed.slice();
  const state = { failList: false, failCreateBeforeRecord: false, failCreateAfterRecord: false };
  let seq = 0;
  const service: PullRequestService = {
    async identity() {
      return "publisher";
    },
    async create(input) {
      created.push(input);
      if (state.failCreateBeforeRecord) throw new Error("connection reset");
      seq += 1;
      const rec: FakePr = {
        url: `https://pr.example/acme/pull/${seq}`,
        head: input.head,
        base: input.base,
        body: input.body,
        repository: input.repository,
        headRepository: input.repository,
        commitOid: remoteOid(fx) as string,
        author: "publisher",
      };
      store.push(rec);
      if (state.failCreateAfterRecord) throw new Error("response lost");
      return rec as Awaited<ReturnType<PullRequestService["create"]>>;
    },
    async list(input) {
      listCalls.push({ repository: input.repository, head: input.head, base: input.base });
      if (state.failList) throw new Error("the PR service is unavailable");
      return store.slice() as Awaited<ReturnType<PullRequestService["list"]>>;
    },
  };
  return { service, created, listCalls, store, state };
}

describe("publish — PR creation", () => {
  it("refuses pr by name before any external effect when the binding does not authorize it", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx); // no pr authorization
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const fake = fakePullRequests(fx);
    const before = remoteOid(fx);
    const out = await publish({
      binding: b,
      params: prParams(built),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck, pr: fake.service },
    });
    expect(out.status).toBe("refused");
    expect(out.reason).toBe("pr_unsupported");
    expect(fake.created).toHaveLength(0);
    expect(remoteOid(fx)).toBe(before);
  });

  it("refuses an authorized PR head different from the pushed ref", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx, { pr: { base: "main", head: "other" } });
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const fake = fakePullRequests(fx);
    const input = {
      binding: b,
      params: prParams(built),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck, pr: fake.service },
    };
    for (const out of [await publish(input), await publish(input)]) {
      expect(out.status, JSON.stringify(out)).toBe("refused");
      expect(out.reason).toBe("pr_head_mismatch");
      expect(out.message).toContain("publisher");
      expect(out.message).toContain("no PR was created");
      expect(out.message).toContain("launcher");
      expect(out.commit_oid).toBe(remoteOid(fx));
      expect(out.pr_url).toBeUndefined();
    }
    expect(fake.created).toHaveLength(0);
    const journal = JSON.parse(
      readFileSync(publishJournalPath(fx.stateRoot, b.publication_id), "utf8"),
    );
    expect(journal.pr).toBeUndefined();
  });

  it("refuses PR creation after the remote branch advances past the journaled commit", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx, { pr: { base: "main", head: "main" } });
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const fake = fakePullRequests(fx);
    let terminate = true;
    const input = {
      binding: b,
      params: prParams(built),
      stateRoot: fx.stateRoot,
      deps: {
        git: realGit,
        runCheck: okCheck,
        pr: fake.service,
        afterPrIntentStored: () => {
          if (terminate) {
            terminate = false;
            throw new Error("publisher terminated");
          }
        },
      },
    };
    await expect(publish(input)).rejects.toThrow("publisher terminated");
    const commit = remoteOid(fx) as string;
    const tip = git(["commit-tree", built.tree_oid, "-p", commit, "-m", "another writer"], fx.repo);
    git(["push", fx.bare, `${tip}:refs/heads/main`], fx.repo);
    const ancestry: string[][] = [];
    input.deps.git = (args, inv) => {
      if (args[0] === "merge-base") ancestry.push(args);
      return realGit(args, inv);
    };
    for (const out of [await publish(input), await publish(input)]) {
      expect(out.status, JSON.stringify(out)).toBe("refused");
      expect(out.reason).toBe("pr_head_moved");
      expect(out.message).toContain("publisher");
      expect(out.message).toContain("no PR was created");
      expect(out.message).toContain("launcher");
      expect(out.commit_oid).toBe(commit);
      expect(out.pr_url).toBeUndefined();
    }
    expect(ancestry).toContainEqual(["merge-base", "--is-ancestor", commit, tip]);
    expect(fake.created).toHaveLength(0);
    expect(remoteOid(fx)).toBe(tip);
    const journal = JSON.parse(
      readFileSync(publishJournalPath(fx.stateRoot, b.publication_id), "utf8"),
    );
    expect(journal.pr.state).toBe("intent");
  });

  it("persists the PR intent before the create call: a termination after persist recovers with one PR", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx, { publication_id: "pub-pr-intent", pr: { base: "main" } });
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const fake = fakePullRequests(fx);
    let marker = "";
    let seen: { state?: string; marker?: string; url?: string } | undefined;
    let terminate = true;
    const deps = {
      git: realGit,
      runCheck: okCheck,
      pr: fake.service,
      afterPrIntentStored: (id: string) => {
        const journal = JSON.parse(readFileSync(publishJournalPath(fx.stateRoot, id), "utf8")) as {
          pr?: { state?: string; marker?: string; url?: string };
        };
        seen = journal.pr;
        marker = seen?.marker ?? "";
        if (terminate) {
          terminate = false;
          throw new Error("publisher terminated");
        }
      },
    };
    await expect(
      publish({ binding: b, params: prParams(built), stateRoot: fx.stateRoot, deps }),
    ).rejects.toThrow("publisher terminated");
    // The intent is durable before the create request, and no request was sent.
    expect(seen?.state).toBe("intent");
    expect(seen?.marker).toMatch(/^<!-- bob-publication:pub-pr-intent:[0-9a-f]{64} -->$/);
    expect(seen?.url).toBeUndefined();
    expect(fake.created).toHaveLength(0);

    const recovered = await publish({
      binding: b,
      params: prParams(built),
      stateRoot: fx.stateRoot,
      deps,
    });
    expect(recovered.status).toBe("published");
    expect(recovered.pr_url).toBe(fake.store[0].url);
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0].body).toContain(marker);
    expect(fake.store).toHaveLength(1);
  });

  it("reuses an existing PR with the marker for open, closed and merged states, issuing no create", async () => {
    for (const state of ["open", "closed", "merged"]) {
      const fx = makeFixture(`reuse-${state}`);
      seedRemote(fx);
      const b = binding(fx, { publication_id: `pub-pr-reuse-${state}`, pr: { base: "main" } });
      const built = buildCandidate(fx, b, (r) =>
        writeFileSync(join(r, "src", "widget.ts"), `export const widget = "${state}";\n`),
      );
      const fake = fakePullRequests(fx);
      fake.state.failCreateAfterRecord = true;
      const deps = { git: realGit, runCheck: okCheck, pr: fake.service };
      const first = await publish({
        binding: b,
        params: prParams(built),
        stateRoot: fx.stateRoot,
        deps,
      });
      expect(first.status).toBe("indeterminate");
      const url = fake.store[0].url;
      fake.store[0].state = state;
      const out = await publish({
        binding: b,
        params: prParams(built),
        stateRoot: fx.stateRoot,
        deps,
      });
      expect(out.status, state).toBe("published");
      expect(out.pr_url, state).toBe(url);
      expect(fake.created, state).toHaveLength(1);
      expect(fake.listCalls[0]).toEqual({
        repository: fx.bare,
        head: "main",
        base: "main",
      });
    }
  });

  it("never reuses a PR with a mismatched marker or a different head/base pair", async () => {
    const cases: Array<{ what: string; make: (ctx: { marker: string; url: string }) => FakePr }> = [
      {
        what: "marker",
        make: (ctx) => ({
          url: ctx.url,
          head: "main",
          base: "main",
          body: "a different publication's body, no marker",
        }),
      },
      {
        what: "head",
        make: (ctx) => ({ url: ctx.url, head: "other", base: "main", body: `${ctx.marker}` }),
      },
      {
        what: "base",
        make: (ctx) => ({ url: ctx.url, head: "main", base: "other", body: `${ctx.marker}` }),
      },
    ];
    for (const c of cases) {
      const fx = makeFixture(`mismatch-${c.what}`);
      seedRemote(fx);
      const b = binding(fx, { publication_id: `pub-pr-mismatch-${c.what}`, pr: { base: "main" } });
      const built = buildCandidate(fx, b, (r) =>
        writeFileSync(join(r, "src", "widget.ts"), `export const widget = "${c.what}";\n`),
      );
      const marker = "";
      const seedUrl = `https://pr.example/acme/pull/seed-${c.what}`;
      const fake = fakePullRequests(fx, [c.make({ marker, url: seedUrl })]);
      const out = await publish({
        binding: b,
        params: prParams(built),
        stateRoot: fx.stateRoot,
        deps: {
          git: realGit,
          runCheck: okCheck,
          pr: fake.service,
          afterPrIntentStored: (id) => {
            const journal = JSON.parse(readFileSync(publishJournalPath(fx.stateRoot, id), "utf8"));
            fake.store[0] = {
              ...c.make({ marker: journal.pr.marker, url: seedUrl }),
              repository: fx.bare,
              headRepository: fx.bare,
              commitOid: journal.commit_oid,
              author: journal.pr.author,
            };
          },
        },
      });
      expect(out.status, c.what).toBe("published");
      expect(fake.created, c.what).toHaveLength(1);
      expect(out.pr_url, c.what).toBe(fake.store[fake.store.length - 1].url);
      expect(out.pr_url, c.what).not.toBe(seedUrl);
    }
  });

  it("an uncertain create is indeterminate and never reissued; a retry reconciles the PR", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx, { publication_id: "pub-pr-uncertain", pr: { base: "main" } });
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const fake = fakePullRequests(fx);
    fake.state.failCreateAfterRecord = true;
    const first = await publish({
      binding: b,
      params: prParams(built),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck, pr: fake.service },
    });
    expect(first.status).toBe("indeterminate");
    expect(first.reason).toBe("pr_uncertain");
    expect(first.commit_oid).toBe(remoteOid(fx));
    expect(fake.created).toHaveLength(1);
    expect(fake.store).toHaveLength(1);
    const journal = JSON.parse(
      readFileSync(publishJournalPath(fx.stateRoot, b.publication_id), "utf8"),
    ) as { pr?: { state?: string; url?: string } };
    expect(journal.pr?.state).toBe("creating");
    expect(journal.pr?.url).toBeUndefined();

    const retry = await publish({
      binding: b,
      params: prParams(built),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck, pr: fake.service },
    });
    expect(retry.status).toBe("published");
    expect(retry.pr_url).toBe(fake.store[0].url);
    expect(fake.created).toHaveLength(1);
  });

  it("an inconclusive reconciliation is indeterminate and issues no create", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx, { publication_id: "pub-pr-unreconciled", pr: { base: "main" } });
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const fake = fakePullRequests(fx);
    fake.state.failList = true;
    const out = await publish({
      binding: b,
      params: prParams(built),
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck, pr: fake.service },
    });
    expect(out.status).toBe("indeterminate");
    expect(out.reason).toBe("pr_unreconciled");
    expect(out.commit_oid).toBe(remoteOid(fx));
    expect(fake.created).toHaveLength(0);
  });

  it("never reissues a create once one has been sent, even when no PR can be found", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx, { publication_id: "pub-pr-no-second", pr: { base: "main" } });
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const fake = fakePullRequests(fx);
    fake.state.failCreateBeforeRecord = true;
    const deps = { git: realGit, runCheck: okCheck, pr: fake.service };
    const first = await publish({
      binding: b,
      params: prParams(built),
      stateRoot: fx.stateRoot,
      deps,
    });
    expect(first.status).toBe("indeterminate");
    expect(first.reason).toBe("pr_uncertain");
    expect(fake.created).toHaveLength(1);
    expect(fake.store).toHaveLength(0);

    const retry = await publish({
      binding: b,
      params: prParams(built),
      stateRoot: fx.stateRoot,
      deps,
    });
    expect(retry.status).toBe("indeterminate");
    expect(retry.reason).toBe("pr_uncertain");
    expect(fake.created).toHaveLength(1);
  });

  it("refuses a malformed pr request before any external effect", async () => {
    const fx = makeFixture();
    seedRemote(fx);
    const b = binding(fx, { pr: { base: "main" } });
    const built = buildCandidate(fx, b, (r) =>
      writeFileSync(join(r, "src", "widget.ts"), "export const widget = 2;\n"),
    );
    const before = remoteOid(fx);
    const out = await publish({
      binding: b,
      params: {
        candidate_id: built.candidate_id,
        commit_message: "x",
        pr: { title: "" },
      } as PublishParams,
      stateRoot: fx.stateRoot,
      deps: { git: realGit, runCheck: okCheck, pr: fakePullRequests(fx).service },
    });
    expect(out.status).toBe("refused");
    expect(out.reason).toBe("invalid_request");
    expect(remoteOid(fx)).toBe(before);
  });
});

describe("pull-request helpers", () => {
  it("parses GitHub HTTPS and SSH endpoints and rejects other endpoints", () => {
    expect(githubRepositorySlug("https://github.com/acme/widgets.git")).toEqual({
      owner: "acme",
      name: "widgets",
    });
    expect(githubRepositorySlug("https://github.com/acme/widgets")).toEqual({
      owner: "acme",
      name: "widgets",
    });
    expect(githubRepositorySlug("git@github.com:acme/widgets.git")).toEqual({
      owner: "acme",
      name: "widgets",
    });
    expect(githubRepositorySlug("ssh://git@github.com/acme/widgets.git")).toEqual({
      owner: "acme",
      name: "widgets",
    });
    expect(githubRepositorySlug("/tmp/remote.git")).toBeNull();
    expect(githubRepositorySlug("https://example.invalid/acme/widgets")).toBeNull();
  });

  it("appends the marker as its own paragraph", () => {
    const marker = publicationMarker("pub-1");
    expect(marker).toMatch(/^<!-- bob-publication:pub-1:[0-9a-f]{64} -->$/);
    expect(publicationMarker("pub-1")).not.toBe(marker);
    expect(bodyWithMarker("why", marker)).toBe(`why\n\n${marker}`);
    expect(bodyWithMarker("why\n", marker)).toBe(`why\n\n${marker}`);
    expect(bodyWithMarker("", marker)).toBe(marker);
  });
});
