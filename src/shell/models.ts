import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readProviderLimits } from "./bob-yaml.js";
import { piOpenAiCompletionsModel } from "./init.js";
import {
  type ProviderRegistry,
  providerApiForRuntime,
  reservedProviderNames,
} from "./provider-registry.js";
import { resolveRunConfig } from "./run.js";
import { assertNoReservedProviderEntries } from "./session.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function applyModelScaffold(
  name: string,
  agentsRoot = join(homedir(), "agents"),
  registry?: ProviderRegistry,
): string {
  const { agentDir, provider, model, config } = resolveRunConfig({
    name,
    agentsRoot,
    ...(registry !== undefined ? { registry } : {}),
  });
  const { baseUrl } = readProviderLimits(
    readFileSync(join(agentDir, "bob.yaml"), "utf8"),
    registry,
  );
  if (baseUrl === undefined) throw new Error("bob models: provider.base_url is required");
  if (config.modelLimits === undefined) {
    throw new Error("bob models: provider.context_window is required");
  }
  const piDir = join(agentDir, ".pi-agent");
  const dir = lstatSync(piDir);
  if (!dir.isDirectory() || dir.isSymbolicLink()) {
    throw new Error(`bob models: refusing non-directory or symlink ${piDir}`);
  }
  const path = join(piDir, "models.json");
  let document: unknown = {};
  let hadComments = false;
  let mode = 0o600;
  let readFd: number | undefined;
  try {
    readFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(readFd);
    if (!file.isFile() || file.nlink !== 1) {
      throw new Error(`bob models: refusing non-file, symlink, or hard-linked ${path}`);
    }
    mode = file.mode & 0o777;
    const content = readFileSync(readFd, "utf8")
      .replace(/^\uFEFF/, "")
      .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => {
        if (match[0] === '"') return match;
        hadComments = true;
        return "";
      })
      .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? match);
    document = JSON.parse(content);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    if (readFd !== undefined) closeSync(readFd);
  }
  if (!object(document) || (document.providers !== undefined && !object(document.providers))) {
    throw new Error(`bob models: invalid providers in ${path}`);
  }
  const providers = (document.providers ?? {}) as Record<string, unknown>;
  // The reserved-name check runs BEFORE the first write, over the COMPLETE map
  // the lenient parser above produced (a BOM, a `//` comment and a trailing
  // comma are all repaired), and over auth.json. A reserved entry present — or a
  // document bob cannot prove free of one — refuses with nothing written.
  assertNoReservedProviderEntries(piDir, reservedProviderNames(registry), {
    modelsProviders: providers,
  });
  const entry = Object.hasOwn(providers, provider) ? providers[provider] : {};
  if (!object(entry) || (entry.models !== undefined && !Array.isArray(entry.models))) {
    throw new Error(`bob models: invalid provider ${provider} in ${path}`);
  }
  const models = (entry.models ?? []) as unknown[];
  if (models.some((item) => !object(item) || typeof item.id !== "string")) {
    throw new Error(`bob models: invalid model entry in ${path}`);
  }
  // The emitted adapter is CONSUMED from the row, never a literal: a new keyless
  // row reaches models.json with its own declared API, and a row that declares
  // none is refused rather than written as an OpenAI-compatible scaffold.
  const api = providerApiForRuntime(provider, registry);
  if (api === undefined) {
    throw new Error(
      `bob models: provider "${provider}" declares no supported API — refusing to write a model scaffold for it.`,
    );
  }
  const update = { baseUrl, api };
  const found = models.some((item) => (item as Record<string, unknown>).id === model);
  const updated = models.map((item) =>
    (item as Record<string, unknown>).id === model ? { ...(item as object), ...update } : item,
  );
  if (!found) {
    updated.push(
      piOpenAiCompletionsModel({ model, contextWindow: config.modelLimits.contextWindow }),
    );
    Object.assign(updated[updated.length - 1] as object, update);
  }
  providers[provider] = { ...entry, ...update, models: updated };
  document.providers = providers;
  const content = `${JSON.stringify(document, null, 2)}\n`;
  const temp = join(piDir, `.models.json-${randomUUID()}.tmp`);
  const writeFd = openSync(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(writeFd, content);
    fchmodSync(writeFd, mode);
    renameSync(temp, path);
  } finally {
    try {
      closeSync(writeFd);
    } finally {
      rmSync(temp, { force: true });
    }
  }
  if (hadComments) console.warn("bob models: comments in models.json were not preserved");
  return path;
}
