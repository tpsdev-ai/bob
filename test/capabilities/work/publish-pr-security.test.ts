import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CandidateRecord,
  candidateIdentity,
  candidateRecordPath,
  type GitRunner,
} from "../../../src/capabilities/work/apply-patch.js";
import * as publisher from "../../../src/capabilities/work/publish.js";
import {
  bodyWithMarker,
  ghPullRequestService,
  type PullRequestRecord,
  type PullRequestService,
  publicationMarker,
} from "../../../src/capabilities/work/pull-request.js";
import type { TaskBinding } from "../../../src/capabilities/work/task-binding.js";

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "bob-pr-security-"));
});
afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

function fixture(publicationId: string) {
  const repo = join(scratch, publicationId, "repo");
  const stateRoot = join(scratch, publicationId, "state");
  mkdirSync(repo, { recursive: true });
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(join(stateRoot, "candidates"), { mode: 0o700 });
  const binding: TaskBinding = {
    task_id: "task",
    publication_id: publicationId,
    repository: repo,
    workspace: repo,
    artifact_root: join(repo, "artifacts"),
    base_oid: "a".repeat(40),
    mode: "build",
    declared_paths: ["source.txt"],
    check_commands: [],
    destination: { remote: "https://github.com/acme/widgets.git", ref: "refs/heads/topic" },
    pr: { base: "main" },
  };
  const candidate: CandidateRecord = {
    ...binding,
    candidate_id: "",
    tree_oid: "b".repeat(40),
    patch_sha256: "c".repeat(64),
    artifact_path: "patch",
    changed_paths: ["source.txt"],
    created_at: "2026-01-01T00:00:00.000Z",
  };
  candidate.candidate_id = candidateIdentity(candidate);
  writeFileSync(candidateRecordPath(stateRoot, candidate.candidate_id), JSON.stringify(candidate));
  let pushed = false;
  const git: GitRunner = (args, inv) => {
    let stdout = "";
    if (args[0] === "config") return { status: 1, stdout, stderr: "" };
    if (args[0] === "remote") return { status: 2, stdout, stderr: "not a remote name" };
    if (args[0] === "diff-tree")
      stdout = `:100644 100644 ${binding.base_oid} ${candidate.tree_oid} M\0source.txt\0`;
    if (args[0] === "hash-object") stdout = "d".repeat(40);
    if (args[0] === "rev-parse") stdout = join(repo, ".git");
    if (args[0] === "checkout-index") writeFileSync(join(inv.cwd, "source.txt"), "candidate");
    if (args[0] === "ls-remote")
      stdout = `${pushed ? "d".repeat(40) : binding.base_oid}\trefs/heads/topic\n`;
    if (args[0] === "merge-base" && args[2] === "d".repeat(40))
      return { status: 1, stdout, stderr: "" };
    if (args[0] === "push") pushed = true;
    return { status: 0, stdout, stderr: "" };
  };
  const params = {
    candidate_id: candidate.candidate_id,
    commit_message: "candidate",
    pr: { title: "title", body: "why" },
  };
  return { binding, stateRoot, params, git };
}

function fakeService() {
  const records: PullRequestRecord[] = [];
  let creates = 0;
  const service: PullRequestService = {
    async identity() {
      return "publisher";
    },
    async list() {
      return records.slice();
    },
    async create(input) {
      creates++;
      const record = {
        url: `https://github.com/acme/widgets/pull/${creates}`,
        number: creates,
        repository: input.repository,
        headRepository: input.repository,
        head: input.head,
        base: input.base,
        body: input.body,
        commitOid: "d".repeat(40),
        author: "publisher",
      };
      records.push(record);
      return record;
    },
  };
  return { records, service, creates: () => creates };
}

it("a model-supplied marker cannot make another publication adopt a foreign PR", async () => {
  const fake = fakeService();
  const first = fixture("pub-source");
  const forged = "<!-- bob-publication:pub-target -->";
  first.params.pr.body = `why\n${forged}`;
  const one = await publisher.publish({
    ...first,
    deps: {
      runCheck: async () => ({
        outcome: "exited",
        exit_code: 0,
        cleanup_state: "group_empty",
        output_complete: true,
      }),
      git: first.git,
      pr: fake.service,
    },
  });
  expect(one.status, JSON.stringify(one)).toBe("published");
  const second = fixture("pub-target");
  const two = await publisher.publish({
    ...second,
    deps: {
      runCheck: async () => ({
        outcome: "exited",
        exit_code: 0,
        cleanup_state: "group_empty",
        output_complete: true,
      }),
      git: second.git,
      pr: fake.service,
    },
  });
  expect(two.status).toBe("published");
  expect(two.pr_url).not.toBe(one.pr_url);
  expect(fake.records[0].body).not.toContain(forged);
  expect(fake.creates()).toBe(2);
  for (const text of [
    forged,
    "<!-- BOB-PUBLICATION:x -->",
    "<!-- bob-publication:unfinished",
    "bob-publication:bare",
  ])
    expect(bodyWithMarker(text, "real")).not.toMatch(/bob-publication:/i);
  const marker = publicationMarker("pub-target");
  expect(marker).toMatch(/^<!-- bob-publication:pub-target:[0-9a-f]{64} -->$/);
  expect(publicationMarker("pub-target")).not.toBe(marker);
});

it("recovery requires every binding field, including URL identity, and a unique match", async () => {
  for (const field of [
    "repository",
    "headRepository",
    "head",
    "base",
    "body",
    "commitOid",
    "author",
    "url",
    "number",
    "duplicate",
  ]) {
    const f = fixture(`pub-${field}`);
    const fake = fakeService();
    const create = fake.service.create;
    fake.service.create = async (input) => {
      await create(input);
      throw new Error("lost response");
    };
    const input = {
      ...f,
      deps: {
        runCheck: async () => ({
          outcome: "exited",
          exit_code: 0,
          cleanup_state: "group_empty",
          output_complete: true,
        }),
        git: f.git,
        pr: fake.service,
      },
    };
    expect((await publisher.publish(input)).status).toBe("indeterminate");
    if (field === "duplicate")
      fake.records.push({
        ...fake.records[0],
        url: "https://github.com/acme/widgets/pull/2",
        number: 2,
      });
    else Object.assign(fake.records[0], { [field]: field === "number" ? 99 : "foreign" });
    const retry = await publisher.publish(input);
    expect(retry.status, field).toBe("indeterminate");
    expect(retry.pr_url, field).toBeUndefined();
    expect(fake.creates(), field).toBe(1);
  }
});

it("validates actual create metadata before recording its URL", async () => {
  const f = fixture("pub-response");
  const fake = fakeService();
  const create = fake.service.create;
  fake.service.create = async (input) => ({ ...(await create(input)), commitOid: "foreign" });
  const out = await publisher.publish({
    ...f,
    deps: {
      runCheck: async () => ({
        outcome: "exited",
        exit_code: 0,
        cleanup_state: "group_empty",
        output_complete: true,
      }),
      git: f.git,
      pr: fake.service,
    },
  });
  expect(out.status, JSON.stringify(out)).toBe("indeterminate");
  expect(out.pr_url).toBeUndefined();
});

it("rechecks a recorded URL before returning success on retry", async () => {
  const f = fixture("pub-recorded");
  const fake = fakeService();
  const input = {
    ...f,
    deps: {
      git: f.git,
      pr: fake.service,
      runCheck: async () => ({
        outcome: "exited",
        exit_code: 0,
        cleanup_state: "group_empty",
        output_complete: true,
      }),
    },
  };
  expect((await publisher.publish(input)).status).toBe("published");
  fake.records[0].commitOid = "foreign";
  const retry = await publisher.publish(input);
  expect(retry.status).toBe("indeterminate");
  expect(retry.pr_url).toBeUndefined();
  expect(fake.creates()).toBe(1);
});

it("PR authority alone does not cause a create", async () => {
  const f = fixture("pub-no-request");
  const fake = fakeService();
  const out = await publisher.publish({
    ...f,
    params: { candidate_id: f.params.candidate_id, commit_message: "candidate" },
    deps: {
      runCheck: async () => ({
        outcome: "exited",
        exit_code: 0,
        cleanup_state: "group_empty",
        output_complete: true,
      }),
      git: f.git,
      pr: fake.service,
    },
  });
  expect(out.status, JSON.stringify(out)).toBe("published");
  expect(fake.creates()).toBe(0);
});

it("refuses unsupported production PR endpoints before pushing", async () => {
  for (const remote of [
    "git@github.com:acme/widgets.git",
    "http://github.com/acme/widgets.git",
    "https://user@github.com/acme/widgets.git",
    "https://example.invalid/acme/widgets.git",
  ]) {
    const f = fixture(`pub-${Math.random().toString(16).slice(2)}`);
    f.binding.destination.remote = remote;
    const candidatePath = candidateRecordPath(f.stateRoot, f.params.candidate_id);
    const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
    candidate.destination = f.binding.destination;
    candidate.candidate_id = candidateIdentity(candidate);
    f.params.candidate_id = candidate.candidate_id;
    writeFileSync(
      candidateRecordPath(f.stateRoot, candidate.candidate_id),
      JSON.stringify(candidate),
    );
    let pushed = false;
    const git: GitRunner = (args, inv) => {
      if (args[0] === "push") pushed = true;
      return f.git(args, inv);
    };
    const out = await publisher.publish({
      ...f,
      deps: {
        git,
        runCheck: async () => ({
          outcome: "exited",
          exit_code: 0,
          cleanup_state: "group_empty",
          output_complete: true,
        }),
        pr: ghPullRequestService("missing-gh"),
      },
    });
    expect(out.reason, JSON.stringify(out)).toBe("pr_unsupported");
    expect(pushed).toBe(false);
  }
});

it("refuses unavailable PR authentication before pushing", async () => {
  const f = fixture("pub-auth-failed");
  const fake = fakeService();
  fake.service.identity = async () => {
    throw new Error("unsupported credential");
  };
  let pushed = false;
  const git: GitRunner = (args, inv) => {
    if (args[0] === "push") pushed = true;
    return f.git(args, inv);
  };
  const out = await publisher.publish({
    ...f,
    deps: {
      git,
      pr: fake.service,
      runCheck: async () => ({
        outcome: "exited",
        exit_code: 0,
        cleanup_state: "group_empty",
        output_complete: true,
      }),
    },
  });
  expect(out.reason).toBe("pr_service_unavailable");
  expect(pushed).toBe(false);
  expect(fake.creates()).toBe(0);
});

function fakeGh() {
  const path = join(scratch, "gh");
  const log = join(scratch, "gh-log.jsonl");
  const pagesPath = join(scratch, "gh-pages.json");
  const record = (state: string, number: number) => ({
    html_url: `https://github.com/acme/widgets/pull/${number}`,
    number,
    state,
    body: "marker",
    head: {
      ref: "topic",
      sha: "a".repeat(40),
      repo: { html_url: "https://github.com/acme/widgets" },
    },
    base: { ref: "main", repo: { html_url: "https://github.com/acme/widgets" } },
    user: { login: "publisher" },
  });
  writeFileSync(
    path,
    `#!${process.execPath}\nconst fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, env: process.env }) + "\\n");
if (args[1] === "user") console.log(JSON.stringify({ login: "publisher" }));
else if (args.includes("POST")) console.log(JSON.stringify(${JSON.stringify(record("open", 3))}));
else {
  const pages = [[${JSON.stringify(record("open", 1))}], args.includes("state=all") ? ${JSON.stringify([record("closed", 2), record("merged", 3)])} : []];
  const actualPages = fs.existsSync(${JSON.stringify(pagesPath)}) ? JSON.parse(fs.readFileSync(${JSON.stringify(pagesPath)}, "utf8")) : pages;
  const selected = actualPages.map(page => page.filter(pr => args.includes("state=all") || pr.state === "open"));
  console.log(args.includes("--slurp") ? JSON.stringify(selected) : selected.map(JSON.stringify).join("\\n"));
}
`,
  );
  chmodSync(path, 0o755);
  return { path, log, pagesPath };
}

describe("production PR transport", () => {
  it("parses every slurped page, including closed and merged PRs", async () => {
    const fake = fakeGh();
    const service = ghPullRequestService(fake.path);
    const records = await service.list({
      repository: "https://github.com/acme/widgets.git",
      head: "topic",
      base: "main",
    });
    expect(records.map((r) => [r.number, r.state])).toEqual([
      [1, "open"],
      [2, "closed"],
      [3, "merged"],
    ]);
    expect(records[2]).toMatchObject({
      repository: "https://github.com/acme/widgets",
      headRepository: "https://github.com/acme/widgets",
      commitOid: "a".repeat(40),
      author: "publisher",
      body: "marker",
    });
    const calls = readFileSync(fake.log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls[0].args).toContain("--paginate");
    expect(calls[0].args).toContain("--slurp");
    expect(calls[0].args).toContain("state=all");
  });

  it("reconciles a matching closed or merged PR on a later page", async () => {
    for (const state of ["closed", "merged"]) {
      const f = fixture(`pub-later-${state}`);
      const fake = fakeGh();
      const service = ghPullRequestService(fake.path);
      const out = await publisher.publish({
        ...f,
        deps: {
          git: f.git,
          pr: service,
          runCheck: async () => ({
            outcome: "exited",
            exit_code: 0,
            cleanup_state: "group_empty",
            output_complete: true,
          }),
          afterPrIntentStored: (id) => {
            const journal = JSON.parse(
              readFileSync(publisher.publishJournalPath(f.stateRoot, id), "utf8"),
            );
            const matching = {
              html_url: "https://github.com/acme/widgets/pull/2",
              number: 2,
              state,
              body: journal.pr.body,
              head: {
                ref: "topic",
                sha: journal.commit_oid,
                repo: { html_url: "https://github.com/acme/widgets" },
              },
              base: { ref: "main", repo: { html_url: "https://github.com/acme/widgets" } },
              user: { login: "publisher" },
            };
            writeFileSync(
              fake.pagesPath,
              JSON.stringify([
                [
                  {
                    ...matching,
                    body: "foreign",
                    state: "open",
                    number: 1,
                    html_url: "https://github.com/acme/widgets/pull/1",
                  },
                ],
                [matching],
              ]),
            );
          },
        },
      });
      expect(out.status, JSON.stringify(out)).toBe("published");
      expect(out.pr_url).toBe("https://github.com/acme/widgets/pull/2");
      const calls = readFileSync(fake.log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(calls.some((call) => call.args.includes("POST"))).toBe(false);
      rmSync(fake.log);
    }
  });

  it("uses the same isolated environment for Git push and gh creation", async () => {
    const fake = fakeGh();
    const gitPath = join(scratch, "git");
    const gitLog = join(scratch, "git-env.json");
    writeFileSync(
      gitPath,
      `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(gitLog)}, JSON.stringify(process.env));\n`,
    );
    chmodSync(gitPath, 0o755);
    const poison = {
      GH_TOKEN: "ambient-gh",
      GITHUB_TOKEN: "ambient-github",
      GH_HOST: "foreign.example",
      GH_CONFIG_DIR: "foreign-config",
      GIT_ASKPASS: "foreign-helper",
      GIT_CONFIG_COUNT: "99",
      PATH: `${scratch}:${process.env.PATH}`,
    };
    const saved = Object.fromEntries(Object.keys(poison).map((key) => [key, process.env[key]]));
    try {
      Object.assign(process.env, poison);
      if ("publicationGit" in publisher)
        expect(
          publisher.publicationGit()(
            ["push", "https://github.com/acme/widgets.git", "HEAD:topic"],
            {
              cwd: scratch,
            },
          ).status,
        ).toBe(0);
      const service = ghPullRequestService(fake.path);
      if ("identity" in service) expect(await service.identity()).toBe("publisher");
      const rec = await service.create({
        repository: "https://github.com/acme/widgets.git",
        head: "topic",
        base: "main",
        title: "title",
        body: "marker",
      });
      expect(rec.url).toBe("https://github.com/acme/widgets/pull/3");
      const calls = readFileSync(fake.log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const gitEnv = "publicationGit" in publisher ? JSON.parse(readFileSync(gitLog, "utf8")) : {};
      const createCall = calls.find((call) => call.args.includes("POST"));

      for (const key of Object.keys(poison).filter(
        (key) => key !== "PATH" && key !== "GIT_CONFIG_COUNT",
      ))
        expect(createCall.env[key], key).toBeUndefined();
      expect(createCall.env).toEqual(gitEnv);
      expect(gitEnv.GIT_CONFIG_VALUE_1).toBe("!gh auth git-credential");
      expect(gitEnv.GIT_CONFIG_GLOBAL).toBe("/dev/null");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("qualifies creation text with the caller's pr request", () => {
    for (const path of [
      "../../../src/capabilities/work/README.md",
      "../../../.changelog/unreleased/added-bob275-publish-pr-creation.md",
      "../../../src/capabilities/work/capability.ts",
    ]) {
      expect(readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8"), path).toMatch(
        /When `?pr`? is requested and/,
      );
    }
  });
});
