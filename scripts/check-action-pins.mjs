#!/usr/bin/env node
// Check that each pinned action SHA is the commit behind its full release tag.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "../..");
const FULL_TAG = /^v\d+\.\d+\.\d+$/;
const USES =
  /^\s*(?:-\s*)?uses:\s*(["']?)([\w.-]+)\/([\w.-]+)((?:\/[^\s@#"'/]+)*)@([a-f\d]{40})\1(?=\s|#|$)(.*)$/i;
const MAX_ENTRIES = 10_000;
const MAX_FILE_BYTES = 1_048_576;
const MAX_TAG_PAGES = 100;

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
  for (const file of actionFiles(root)) {
    const source = readFileSync(file);
    if (source.length > MAX_FILE_BYTES) throw new Error(`${file}: action file exceeds scan limit`);
    const lines = source.toString("utf8").split("\n");
    for (const [index, line] of lines.entries()) {
      const match = line.match(USES);
      if (!match) continue;
      checked++;
      const [, , owner, repo, subpath, sha, suffix] = match;
      const action = `${owner}/${repo}${subpath}`;
      const location = `${relative(root, file)}:${index + 1}: ${action}@${sha}`;
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
  if (checked === 0) errors.push("No SHA-pinned actions found in workflows or composite actions");
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
    console.error("Usage: node scripts/check-action-pins.mjs");
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
