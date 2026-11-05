#!/usr/bin/env bun
// Parse YAML with Bun.YAML: inventory jobs.<id>.steps[*].uses, jobs.<id>.uses,
// and action metadata runs.steps[*].uses; refuse parse errors and unwalkable shapes.
// Locate each reference at its step/job key on a canonical `- uses: <value>` or
// `uses: <value>` source line (unquoted or simply quoted value); otherwise refuse
// it with a remedy for its reference kind. Refuse YAML aliases; request the step
// written out in full. Ignore uses text in run blocks.
// Remote refs require a full 40-hex SHA and a full release-tag comment resolving
// to that SHA. Follow ./ local actions through action.yml/action.yaml, cycle-safe
// and bounded; missing metadata is an error. Docker refs require @sha256:<64-hex>.
// The CLI requires GITHUB_TOKEN for tag lookups and refuses without it before scanning.
// Read a stable checkout that no other process is rewriting; check path containment
// before opening files.

import { closeSync, fstatSync, openSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const FULL_TAG = /^v\d+\.\d+\.\d+$/;
const USES_LINE = /^(\s*(?:-\s+)?uses:\s*)(.*)$/;
const REMOTE_ACTION = /^([\w.-]+)\/([\w.-]+)((?:\/[^\s@#"'/]+)*)@(.*)$/;
const FULL_SHA = /^[a-f\d]{40}$/i;
const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 1_048_576;
const MAX_TAG_PAGES = 100;
const DOCKER_DIGEST = /^docker:\/\/[^\s@]+@sha256:[a-f\d]{64}$/i;

function isMapping(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function inventory(doc, metadata) {
  const refs = [];
  const mapping = (value, path) => {
    if (!isMapping(value)) throw new Error(`${path} must be a mapping`);
  };
  const reference = (value, path, kind) => {
    if (typeof value !== "string" || !value.trim())
      throw new Error(`${path.join(".")} must be a non-empty string`);
    refs.push({ value, path: JSON.stringify(path), kind });
  };
  const steps = (value, path) => {
    if (!Array.isArray(value)) throw new Error(`${path.join(".")} must be an array`);
    for (const [index, step] of value.entries()) {
      mapping(step, `${path.join(".")}.${index}`);
      if (Object.hasOwn(step, "uses")) reference(step.uses, [...path, index, "uses"], "step");
    }
  };
  mapping(doc, "document");
  if (metadata) {
    mapping(doc.runs, "runs");
    if (Object.hasOwn(doc.runs, "steps")) steps(doc.runs.steps, ["runs", "steps"]);
    else if (doc.runs.using === "composite") throw new Error("runs.steps must be an array");
  } else {
    mapping(doc.jobs, "jobs");
    for (const [id, job] of Object.entries(doc.jobs)) {
      mapping(job, `jobs.${id}`);
      if (Object.hasOwn(job, "uses")) reference(job.uses, ["jobs", id, "uses"], "job");
      if (Object.hasOwn(job, "steps")) steps(job.steps, ["jobs", id, "steps"]);
      else if (!Object.hasOwn(job, "uses")) throw new Error(`jobs.${id} must have steps or uses`);
    }
  }
  return refs;
}

function refuseAliases(text) {
  if (!text.includes("*")) return;
  let marker = "__action_pin_unbound_alias__";
  while (text.includes(marker)) marker += "_";
  try {
    Bun.YAML.parse(text.replaceAll("*", `*${marker}`));
  } catch {
    const tokens = [...new Set(text.match(/\*[^\s[\]{},]*/g))].join(", ");
    throw new Error(
      `YAML aliases are refused (source tokens: ${tokens}); write the step out in full`,
    );
  }
}

function referenceRemedy({ value, kind }) {
  if (value.startsWith("./")) return "`- uses: ./path` (local actions are followed, not pinned)";
  if (value.startsWith("docker://")) return "`- uses: docker://image@sha256:<64-hex>`";
  if (kind === "job")
    return "`uses: owner/repo/.github/workflows/<file>.yml@<40-hex> # vX.Y.Z` at the job key";
  return "`- uses: owner/repo[/path]@<40-hex> # vX.Y.Z`";
}

function locateReferences(text, metadata) {
  const candidates = new Map();
  const marked = text.split("\n").map((line, index) => {
    const match = line.match(USES_LINE);
    if (!match) return line;
    const parsed = parseUses(match[2]);
    if (!parsed || !/^\s*(?:#.*)?$/.test(parsed.suffix)) return line;
    const marker = `__action_pin_line_${index}__`;
    candidates.set(marker, { ...parsed, line: index + 1 });
    return `${match[1]}"${marker}"${parsed.suffix}`;
  });
  try {
    return new Map(
      inventory(Bun.YAML.parse(marked.join("\n")), metadata)
        .filter((ref) => candidates.has(ref.value))
        .map((ref) => [ref.path, candidates.get(ref.value)]),
    );
  } catch {
    return new Map();
  }
}

function localMetadata(root, value) {
  const directory = resolve(root, value);
  const rel = relative(root, realpathSync(directory));
  if (rel === ".." || rel.startsWith("../"))
    throw new Error("local action is outside the repository");
  for (const name of ["action.yml", "action.yaml"]) {
    const file = join(directory, name);
    try {
      realpathSync(file);
      return file;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("missing local action.yml/action.yaml");
}

function parseUses(raw) {
  const trimmed = raw.trim();
  let value;
  let suffix;
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0];
    const end = trimmed.indexOf(quote, 1);
    if (end === -1) return null;
    value = trimmed.slice(1, end);
    suffix = trimmed.slice(end + 1);
  } else {
    const commentAt = trimmed.search(/\s#/);
    value = commentAt === -1 ? trimmed : trimmed.slice(0, commentAt);
    suffix = commentAt === -1 ? "" : trimmed.slice(commentAt);
  }
  return { value: value.trim(), suffix };
}

function actionFiles(root) {
  const files = [];
  let entriesSeen = 0;
  for (const dir of [join(root, ".github/workflows"), join(root, ".github/actions")]) {
    const stack = [dir];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT" && current.endsWith("/actions")) continue;
        throw error;
      }
      entriesSeen += entries.length;
      if (entriesSeen > MAX_ENTRIES) throw new Error("Too many workflow/action entries to check");
      for (const entry of entries) {
        const path = join(current, entry.name);
        if (entry.isDirectory() && current !== join(root, ".github/workflows")) {
          stack.push(path);
        } else if (
          entry.isFile() &&
          ((current === join(root, ".github/workflows") && /\.ya?ml$/.test(entry.name)) ||
            (current !== join(root, ".github/workflows") && /^action\.ya?ml$/.test(entry.name)))
        ) {
          files.push(path);
        }
      }
    }
  }
  return files.sort();
}

export async function checkActionPins({ root = ROOT, resolver }) {
  const errors = [];
  let checked = 0;
  let references = 0;
  if (typeof globalThis.Bun?.YAML?.parse !== "function") {
    return { checked, errors: ["Bun.YAML is required; run bun scripts/check-action-pins.mjs"] };
  }
  root = realpathSync(root);
  const queue = actionFiles(root);
  const visited = new Set();
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const file = queue[cursor];
    const rel = relative(root, file);
    let refs;
    let locations;
    try {
      const canonical = realpathSync(file);
      const canonicalRel = relative(root, canonical);
      if (canonicalRel === ".." || canonicalRel.startsWith("../"))
        throw new Error("action metadata is outside the repository");
      if (visited.has(canonical)) continue;
      visited.add(canonical);
      if (visited.size > MAX_ENTRIES) throw new Error("Too many action files to check");
      const fd = openSync(canonical, "r");
      try {
        const stats = fstatSync(fd);
        if (!stats.isFile()) throw new Error("action file is not a regular file");
        if (stats.size > MAX_FILE_BYTES) throw new Error("action file exceeds scan limit");
        const text = readFileSync(fd, "utf8");
        const metadata = dirname(file) !== join(root, ".github/workflows");
        const doc = Bun.YAML.parse(text);
        refuseAliases(text);
        refs = inventory(doc, metadata);
        locations = locateReferences(text, metadata);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      errors.push(`${rel}: ${error.message}`);
      continue;
    }
    references += refs.length;
    for (const reference of refs) {
      const { value } = reference;
      const located = locations.get(reference.path);
      if (!located || located.value !== value) {
        errors.push(
          `${rel}: ${value} is written in a form the pin check cannot locate; write it as ` +
            referenceRemedy(reference),
        );
        continue;
      }
      const { line, suffix } = located;
      if (value.startsWith("./")) {
        try {
          const metadata = localMetadata(root, value);
          if (queue.length >= MAX_ENTRIES)
            throw new Error("Too many local action references to check");
          queue.push(metadata);
        } catch (error) {
          errors.push(`${rel}:${line}: ${value}: ${error.message}`);
        }
        continue;
      }
      if (value.startsWith("docker://")) {
        if (!DOCKER_DIGEST.test(value))
          errors.push(`${rel}:${line}: ${value}: Docker reference requires @sha256:<64-hex>`);
        continue;
      }
      const match = value.match(REMOTE_ACTION);
      if (!match) {
        errors.push(
          `${rel}:${line}: ${value}: not a remote action reference (owner/repo[/path]@ref)`,
        );
        continue;
      }
      const [, owner, repo, subpath, ref] = match;
      const action = `${owner}/${repo}${subpath}`;
      checked++;
      if (!FULL_SHA.test(ref)) {
        const target = ref === "" ? `${action} (empty ref)` : `${action}@${ref}`;
        errors.push(`${rel}:${line}: ${target}: not pinned to a full 40-character commit SHA`);
        continue;
      }
      const sha = ref;
      const location = `${rel}:${line}: ${action}@${sha}`;
      const comment = suffix.match(/^\s+#\s*(\S+)\s*$/)?.[1];
      try {
        if (!comment || !FULL_TAG.test(comment)) {
          const tag = await resolver.findTagForSha(owner, repo, sha);
          errors.push(
            `${location}: ${comment ? `# ${comment} is not a full release tag` : "missing or malformed version comment"}; ` +
              (tag ? `write # ${tag}` : "no full release tag found for this SHA"),
          );
          continue;
        }
        const actual = await resolver.resolveTag(owner, repo, comment);
        if (actual.toLowerCase() !== sha.toLowerCase()) {
          errors.push(`${location}: # ${comment} resolves to ${actual}, not the pinned SHA`);
        }
      } catch (error) {
        errors.push(`${location}: ${error.message}`);
      }
    }
  }
  if (references === 0 && errors.length === 0)
    errors.push("No action references found in workflows or action metadata");
  return { checked, errors };
}

export function createGithubResolver(token, fetchImpl = fetch) {
  async function get(path) {
    const response = await fetchImpl(`https://api.github.com${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`GitHub API HTTP ${response.status} for ${path}`);
    return response.json();
  }

  const tagCache = new Map();
  const discoveryCache = new Map();
  async function resolveTag(owner, repo, tag) {
    const key = `${owner}/${repo}/${tag}`;
    if (!tagCache.has(key)) {
      tagCache.set(
        key,
        (async () => {
          const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
          let object = (await get(`${base}/git/ref/tags/${encodeURIComponent(tag)}`)).object;
          const seen = new Set();
          for (let depth = 0; depth < 5; depth++) {
            if (!object?.sha || seen.has(object.sha))
              throw new Error(`Invalid tag object for ${key}`);
            if (object.type === "commit") return object.sha;
            if (object.type !== "tag") throw new Error(`Unexpected tag object type for ${key}`);
            seen.add(object.sha);
            object = (await get(`${base}/git/tags/${object.sha}`)).object;
          }
          throw new Error(`Tag chain is too deep for ${key}`);
        })(),
      );
    }
    return tagCache.get(key);
  }

  async function discoverTag(owner, repo, sha) {
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    for (let page = 1; page <= MAX_TAG_PAGES; page++) {
      const tags = await get(`${base}/tags?per_page=100&page=${page}`);
      if (!Array.isArray(tags)) throw new Error(`Invalid tag list for ${owner}/${repo}`);
      for (const tag of tags) {
        if (FULL_TAG.test(tag.name) && tag.commit?.sha?.toLowerCase() === sha.toLowerCase()) {
          if ((await resolveTag(owner, repo, tag.name)).toLowerCase() === sha.toLowerCase()) {
            return tag.name;
          }
        }
      }
      if (tags.length < 100) return null;
    }
    throw new Error(`Tag search exceeded ${MAX_TAG_PAGES} pages for ${owner}/${repo}`);
  }

  function findTagForSha(owner, repo, sha) {
    const key = `${owner}/${repo}/${sha.toLowerCase()}`;
    if (!discoveryCache.has(key)) discoveryCache.set(key, discoverTag(owner, repo, sha));
    return discoveryCache.get(key);
  }
  return { resolveTag, findTagForSha };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 2) {
    console.error("Usage: bun scripts/check-action-pins.mjs");
    process.exitCode = 2;
  } else if (!process.env.GITHUB_TOKEN) {
    console.error("GITHUB_TOKEN is required for the action pin check");
    process.exitCode = 1;
  } else {
    try {
      const result = await checkActionPins({
        resolver: createGithubResolver(process.env.GITHUB_TOKEN),
      });
      for (const error of result.errors) console.error(error);
      if (result.errors.length > 0) process.exitCode = 1;
      else console.log(`Checked ${result.checked} SHA-pinned actions`);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
