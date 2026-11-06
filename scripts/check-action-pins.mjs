#!/usr/bin/env bun
// Parse YAML with Bun.YAML: inventory jobs.<id>.steps[*].uses, jobs.<id>.uses,
// and action metadata runs.steps[*].uses; refuse parse errors and unwalkable shapes.
// Locate each reference at its step/job key on a canonical `- uses: <value>` or
// `uses: <value>` source line (unquoted or simply quoted value); otherwise refuse
// it with a remedy for its reference kind. Refuse YAML aliases; request the step
// written out in full. Refuse any duplicate mapping key in the source, naming the
// file, key and line numbers. Ignore keys in run blocks.
// Remote refs require a full 40-hex SHA and a full release-tag comment resolving
// to that SHA. Follow ./ local actions through action.yml/action.yaml, cycle-safe
// and bounded; missing metadata is an error. Check job-level local reusable
// workflows as workflow files. Docker refs require @sha256:<64-hex>.
// The CLI requires GITHUB_TOKEN for tag lookups and refuses without it before scanning.
// Read a stable checkout that no other process is rewriting; check path containment
// before opening files.

import {
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
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

function skipQuoted(text, start) {
  const quote = text[start];
  let index = start + 1;
  while (index < text.length) {
    if (quote === '"' && text[index] === "\\") {
      index += 2;
      continue;
    }
    if (text[index] === quote) {
      if (quote === "'" && text[index + 1] === "'") {
        index += 2;
        continue;
      }
      return index + 1;
    }
    index++;
  }
  return index;
}

function decodeKey(raw) {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

function isBlockScalar(value) {
  return /^[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#.*)?$/.test(value);
}

// Collect every mapping key in the source with its span, decoded text and line.
// Block mappings are entered at the line's indentation (after any `- ` indicators);
// flow mappings are walked inside `{...}` at any depth. Quoted text is skipped,
// `#` comments and block-scalar bodies are not scanned, and a plain key's colon
// must be followed by whitespace or end of line.
function mappingKeys(text) {
  const keys = [];
  const newlines = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] === "\n") newlines.push(index);
  }
  const lineOf = (position) => {
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (newlines[middle] < position) low = middle + 1;
      else high = middle;
    }
    return low + 1;
  };

  const scanFlow = (start) => {
    const stack = [];
    let index = start;
    let expectingKey = false;
    while (index < text.length) {
      const char = text[index];
      if (char === '"' || char === "'") {
        index = skipQuoted(text, index);
        continue;
      }
      if (char === "#" && (index === start || /[ \t\r\n]/.test(text[index - 1]))) {
        const newline = text.indexOf("\n", index);
        index = newline === -1 ? text.length : newline;
        continue;
      }
      if (char === "{") {
        stack.push("mapping");
        expectingKey = true;
        index++;
        continue;
      }
      if (char === "[") {
        stack.push("sequence");
        expectingKey = false;
        index++;
        continue;
      }
      if (char === "}" || char === "]") {
        if (stack.length === 0) return index + 1;
        stack.pop();
        expectingKey = false;
        index++;
        continue;
      }
      if (char === "," && stack.at(-1) === "mapping") {
        expectingKey = true;
        index++;
        continue;
      }
      if (expectingKey) {
        const keyStart = index;
        let keyEnd = -1;
        let colon = -1;
        if (char === '"' || char === "'") {
          keyEnd = skipQuoted(text, index);
          let next = keyEnd;
          while (next < text.length && /[ \t\r\n]/.test(text[next])) next++;
          if (text[next] === ":") colon = next;
        } else {
          for (let next = index; next < text.length; next++) {
            const inner = text[next];
            if (
              inner === ":" &&
              (next + 1 >= text.length || /[ \t\r\n,}\]]/.test(text[next + 1]))
            ) {
              colon = next;
              break;
            }
            if (inner === "," || inner === "}" || inner === "]" || inner === "{") break;
          }
          if (colon !== -1) {
            keyEnd = colon;
            while (keyEnd > keyStart && /[ \t]/.test(text[keyEnd - 1])) keyEnd--;
          }
        }
        if (colon !== -1 && keyEnd > keyStart) {
          keys.push({
            start: keyStart,
            end: keyEnd,
            key: decodeKey(text.slice(keyStart, keyEnd)),
            line: lineOf(keyStart),
          });
          expectingKey = false;
          index = colon + 1;
          continue;
        }
        expectingKey = false;
      }
      index++;
    }
    return index;
  };

  let index = 0;
  let blockScalarIndent = null;
  while (index < text.length) {
    const newline = text.indexOf("\n", index);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(index, lineEnd);
    const indent = line.length - line.trimStart().length;
    const content = line.slice(indent);
    if (blockScalarIndent !== null) {
      if (content === "" || indent > blockScalarIndent) {
        index = lineEnd + 1;
        continue;
      }
      blockScalarIndent = null;
    }
    if (content === "" || content.startsWith("#")) {
      index = lineEnd + 1;
      continue;
    }
    let column = index + indent;
    while (text[column] === "-") {
      const next = text[column + 1];
      if (next !== undefined && !/[ \t\r\n]/.test(next)) break;
      column++;
      while (text[column] === " " || text[column] === "\t") column++;
    }
    if (column >= lineEnd) {
      index = lineEnd + 1;
      continue;
    }
    const first = text[column];
    if (first === "{" || first === "[") {
      const flowEnd = scanFlow(column);
      const rest = text.indexOf("\n", flowEnd);
      index = rest === -1 ? text.length : rest + 1;
      continue;
    }
    if ((first === "|" || first === ">") && isBlockScalar(text.slice(column, lineEnd))) {
      blockScalarIndent = indent;
      index = lineEnd + 1;
      continue;
    }
    let keyStart = -1;
    let keyEnd = -1;
    let colon = -1;
    if (first === '"' || first === "'") {
      const quoteEnd = skipQuoted(text, column);
      if (quoteEnd <= lineEnd) {
        let next = quoteEnd;
        while (next < lineEnd && /[ \t]/.test(text[next])) next++;
        if (text[next] === ":") {
          keyStart = column;
          keyEnd = quoteEnd;
          colon = next;
        }
      }
    } else {
      for (let next = column; next < lineEnd; next++) {
        const char = text[next];
        if (char === ":" && (next + 1 >= text.length || /[ \t\r\n]/.test(text[next + 1]))) {
          colon = next;
          break;
        }
        if (char === "#" && /[ \t]/.test(text[next - 1])) break;
      }
      if (colon !== -1) {
        keyStart = column;
        keyEnd = colon;
        while (keyEnd > keyStart && /[ \t]/.test(text[keyEnd - 1])) keyEnd--;
      }
    }
    if (colon !== -1 && keyEnd > keyStart) {
      keys.push({
        start: keyStart,
        end: keyEnd,
        key: decodeKey(text.slice(keyStart, keyEnd)),
        line: lineOf(keyStart),
      });
      let valueStart = colon + 1;
      while (valueStart < lineEnd && /[ \t]/.test(text[valueStart])) valueStart++;
      const value = text.slice(valueStart, lineEnd).trim();
      if (isBlockScalar(value)) {
        blockScalarIndent = indent;
      } else if (value.startsWith("{") || value.startsWith("[")) {
        const flowEnd = scanFlow(valueStart);
        const rest = text.indexOf("\n", flowEnd);
        index = rest === -1 ? text.length : rest + 1;
        continue;
      }
    }
    index = lineEnd + 1;
  }
  return keys;
}

function refuseDuplicateKeys(text) {
  const keys = mappingKeys(text);
  if (keys.length === 0) return null;
  let marker = "__action_pin_mapping_key__";
  while (text.includes(marker)) marker += "_";
  const marked = [];
  let cursor = 0;
  for (const [position, key] of keys.entries()) {
    const name = `${marker}${position}`;
    key.marker = name;
    marked.push(text.slice(cursor, key.start), name);
    cursor = key.end;
  }
  marked.push(text.slice(cursor));
  const doc = Bun.YAML.parse(marked.join(""));
  const paths = new Map();
  const walk = (value, path) => {
    if (Array.isArray(value)) {
      value.forEach((item, itemIndex) => {
        walk(item, [...path, itemIndex]);
      });
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [name, child] of Object.entries(value)) {
      paths.set(name, [...path, name]);
      walk(child, [...path, name]);
    }
  };
  walk(doc, []);
  const groups = new Map();
  for (const key of keys) {
    const path = paths.get(key.marker);
    if (!path)
      throw new Error(
        `mapping key ${JSON.stringify(key.key)} at line ${key.line} cannot be located after parsing`,
      );
    const identity = `${JSON.stringify(path.slice(0, -1))}\u0000${key.key}`;
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(key);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const lines = group
      .map((key) => key.line)
      .join(", ")
      .replace(/, ([^,]*)$/, " and $1");
    const { key } = group[0];
    if (key === "uses")
      throw new Error(
        `duplicate uses keys are refused at lines ${lines}; write one \`uses\` per step (or job)`,
      );
    throw new Error(
      `duplicate mapping key ${JSON.stringify(key)} is refused at lines ${lines}; write one ${JSON.stringify(key)} per mapping`,
    );
  }
}

function referenceRemedy({ value, kind }) {
  if (kind === "job" && value.startsWith("./"))
    return "`uses: ./.github/workflows/<file>.yml` at the job key";
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

function localWorkflow(root, value) {
  const invalid = () =>
    new Error("local reusable workflow must be a regular .yml/.yaml file under .github/workflows/");
  if (!/^\.\/\.github\/workflows\/[^/]+\.ya?ml$/.test(value)) throw invalid();
  try {
    const file = realpathSync(resolve(root, value));
    const rel = relative(root, file);
    if (
      !/^\.github\/workflows\/[^/]+\.ya?ml$/.test(rel) ||
      !lstatSync(resolve(root, value)).isFile()
    )
      throw invalid();
  } catch (error) {
    if (error.code) throw new Error(`cannot read local reusable workflow (${error.code})`);
    throw error;
  }
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
        if (Array.isArray(doc)) throw new Error("multiple YAML documents are not supported");
        refuseDuplicateKeys(text);
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
          if (reference.kind === "job") {
            localWorkflow(root, value);
            continue;
          }
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
