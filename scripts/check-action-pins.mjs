#!/usr/bin/env bun
// Admit the subset defined at refuseDuplicateKeys before parsing with Bun.YAML.
// Inventory jobs.<id>.steps[*].uses, jobs.<id>.uses and action metadata
// runs.steps[*].uses; refuse parse errors and unwalkable shapes.
// Locate each reference at its step/job key on a canonical `- uses: <value>` or
// `uses: <value>` source line (unquoted or simply quoted value); otherwise refuse
// it with a remedy for its reference kind.
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

// Subset: block mappings/sequences (including indentless mapping-value sequences),
// unquoted string keys, one-line plain/quoted scalars, block scalars and flat
// one-line scalar flow sequences. Bun.YAML validates syntax after this gate.
export function refuseDuplicateKeys(text) {
  const fail = (line, construct, remedy) => {
    throw new Error(`line ${line}: ${construct} is outside the YAML subset; ${remedy}`);
  };
  const scalarRemedy = "write a one-line scalar or use a | or > block scalar";
  const keyRemedy = "write an unquoted key using letters, digits, _, -, . or /";
  const rows = [];
  let scalarIndent = null;
  let started = false;
  let ended = false;
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = index + 1;
    // Pinned Bun line-break coverage: "scanner break refusal matches Bun.YAML" test.
    if (/\r(?!\n)/.test(raw)) fail(line, "bare CR", "convert to LF");
    const indent = raw.match(/^ */)[0].length;
    const content = raw.slice(indent);
    if (scalarIndent !== null) {
      if (!content || indent > scalarIndent) continue;
      scalarIndent = null;
    }
    if (/^[ \t]*\t/.test(raw)) fail(line, "tab indentation", "indent with spaces");
    if (!content || content.startsWith("#")) continue;
    if (/^(?:---|\.\.\.)(?:\s|$)/.test(content)) {
      if (indent === 0 && /^---(?:\s+#.*)?\s*$/.test(content) && !started && !ended) {
        started = true;
        continue;
      }
      if (indent === 0 && /^\.\.\.(?:\s+#.*)?\s*$/.test(content) && started && !ended) {
        ended = true;
        continue;
      }
      fail(line, "document marker", "write a single YAML document");
    }
    if (ended) fail(line, "content after document end", "write a single YAML document");
    started = true;
    let column = indent;
    let rest = content;
    while (/^-(?: +|$)/.test(rest)) {
      const width = rest.match(/^-(?: +|$)/)[0].length;
      rows.push({ indent: column, content: "-", line });
      column += width;
      rest = rest.slice(width);
    }
    if (!rest || rest.startsWith("#")) continue;
    rows.push({ indent: column, content: rest, line });
    const value = rest.replace(/^[A-Za-z0-9_./-]+:[ \t]*/, "");
    if (/^[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#.*)?$/.test(value)) {
      scalarIndent = value === rest && column > indent ? rows.at(-2).indent : column;
    }
  }

  const quotedEnd = (value, line) => {
    const quote = value[0];
    for (let i = 1; i < value.length; i++) {
      if (quote === '"' && value[i] === "\\") {
        i++;
      } else if (value[i] === quote) {
        if (quote === "'" && value[i + 1] === "'") i++;
        else return i + 1;
      }
    }
    fail(line, "multiline quoted scalar", scalarRemedy);
  };
  const plain = (value, line, flow = false) => {
    if (/^[&*]/.test(value))
      fail(line, "anchor or alias", "write the step out in full without anchors or aliases");
    if (value.startsWith("!")) fail(line, "tag", "remove the tag and write a scalar");
    if (value.startsWith("{")) fail(line, "flow mapping", "write a block mapping");
    if (/^\?(?:\s|$)/.test(value)) fail(line, "explicit ? key", keyRemedy);
    if (/^[[\]}>|%@`]/.test(value) || /^-(?:\s|$)/.test(value))
      fail(line, "scalar indicator", scalarRemedy);
    if (/:(?:\s|$)/.test(value) || (flow && /[[\]{},]|:$/.test(value)))
      fail(
        line,
        "mapping or nested collection in scalar",
        "quote the scalar or write a block mapping",
      );
  };
  const scanFlow = (value, line) => {
    let index = 1;
    while (index < value.length) {
      while (/[ \t]/.test(value[index] ?? "")) index++;
      if (value[index] === "]") return index + 1;
      if (value[index] === "[")
        fail(line, "nested flow collection", "write nested collections in block style");
      if (value[index] === '"' || value[index] === "'") {
        index += quotedEnd(value.slice(index), line);
      } else {
        const start = index;
        while (index < value.length && !/[,\]]/.test(value[index])) index++;
        const item = value.slice(start, index).trim();
        if (!item || /(?:^|\s)#/.test(item))
          fail(line, "flow sequence item", "write plain or quoted scalars on one line");
        plain(item, line, true);
      }
      while (/[ \t]/.test(value[index] ?? "")) index++;
      if (value[index] === "]") return index + 1;
      if (value[index] !== ",")
        fail(line, "flow sequence syntax", "write a flat flow sequence on one line");
      index++;
    }
    fail(line, "multiline flow sequence", "write the sequence on one line or in block style");
  };
  const scalar = (value, line) => {
    if (/^[|>](?:[1-9][+-]?|[+-][1-9]?)?[ \t]*(?:#.*)?$/.test(value)) return;
    let end;
    if (value.startsWith("[")) end = scanFlow(value, line);
    else if (/^["']/.test(value)) end = quotedEnd(value, line);
    else {
      plain(value.replace(/[ \t]+#.*$/, ""), line);
      return;
    }
    if (!/^(?:[ \t]+#.*)?[ \t]*$/.test(value.slice(end)))
      fail(line, "content after scalar", scalarRemedy);
  };
  const member = (row) => {
    if (/^["']/.test(row.content)) {
      const end = quotedEnd(row.content, row.line);
      if (/^[ \t]*:/.test(row.content.slice(end))) fail(row.line, "quoted key", keyRemedy);
    }
    if (/^\?(?:\s|$)/.test(row.content)) fail(row.line, "explicit ? key", keyRemedy);
    if (/^<<\s*:/.test(row.content)) fail(row.line, "merge key", "write the mapping out in full");
    const match = row.content.match(/^([A-Za-z0-9_./-]+):(?:[ \t]+|$)(.*)$/);
    if (!match) return null;
    const key = match[1];
    if (Object.keys(Bun.YAML.parse(`${key}: null`))[0] !== key)
      fail(
        row.line,
        "key whose spelling Bun.YAML changes",
        "rename the key to a plain string identifier",
      );
    return { key, value: match[2] };
  };
  let cursor = 0;
  const block = (indentless = false) => {
    const first = rows[cursor];
    const indent = first.indent;
    const kind = first.content === "-" ? "sequence" : member(first) ? "mapping" : "scalar";
    const keys = new Map();
    do {
      const row = rows[cursor++];
      let value;
      if (kind === "sequence") {
        if (row.content !== "-")
          fail(row.line, "mixed block mapping and sequence", "use separate indented blocks");
        value = "";
      } else if (kind === "mapping") {
        const entry = member(row);
        if (!entry) fail(row.line, "unsupported mapping key", keyRemedy);
        if (keys.has(entry.key)) {
          const lines = `${keys.get(entry.key)} and ${row.line}`;
          throw new Error(
            entry.key === "uses"
              ? `duplicate uses keys are refused at lines ${lines}; write one \`uses\` per step (or job)`
              : `duplicate mapping key ${JSON.stringify(entry.key)} is refused at lines ${lines}; write one ${JSON.stringify(entry.key)} per mapping`,
          );
        }
        keys.set(entry.key, row.line);
        value = entry.value;
      } else value = row.content;
      const empty = !value || value.startsWith("#");
      if (!empty) scalar(value, row.line);
      if (rows[cursor]?.indent > indent) {
        if (!empty)
          fail(rows[cursor].line, "multiline scalar or unexpected indentation", scalarRemedy);
        block();
      } else if (
        kind === "mapping" &&
        empty &&
        rows[cursor]?.indent === indent &&
        rows[cursor].content === "-"
      ) {
        block(true);
      }
      if (kind === "scalar") break;
    } while (rows[cursor]?.indent === indent && (!indentless || rows[cursor].content === "-"));
  };
  if (rows.length) block();
  if (cursor < rows.length)
    fail(
      rows[cursor].line,
      "block indentation",
      "indent child collections beneath their parent key",
    );
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
        refuseDuplicateKeys(text);
        const doc = Bun.YAML.parse(text);
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
