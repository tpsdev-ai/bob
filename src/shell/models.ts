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
import { resolveRunConfig } from "./run.js";

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function applyModelScaffold(name: string, agentsRoot = join(homedir(), "agents")): string {
  const { agentDir, provider, model, config } = resolveRunConfig({ name, agentsRoot });
  const { baseUrl } = readProviderLimits(readFileSync(join(agentDir, "bob.yaml"), "utf8"));
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
  let mode = 0o600;
  let readFd: number | undefined;
  try {
    readFd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const file = fstatSync(readFd);
    if (!file.isFile() || file.nlink !== 1) {
      throw new Error(`bob models: refusing non-file, symlink, or hard-linked ${path}`);
    }
    mode = file.mode & 0o777;
    document = JSON.parse(readFileSync(readFd, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  } finally {
    if (readFd !== undefined) closeSync(readFd);
  }
  if (!object(document) || (document.providers !== undefined && !object(document.providers))) {
    throw new Error(`bob models: invalid providers in ${path}`);
  }
  const providers = (document.providers ?? {}) as Record<string, unknown>;
  const entry = Object.hasOwn(providers, provider) ? providers[provider] : {};
  if (!object(entry) || (entry.models !== undefined && !Array.isArray(entry.models))) {
    throw new Error(`bob models: invalid provider ${provider} in ${path}`);
  }
  const models = (entry.models ?? []) as unknown[];
  if (models.some((item) => !object(item) || typeof item.id !== "string")) {
    throw new Error(`bob models: invalid model entry in ${path}`);
  }
  const update = { baseUrl, api: "openai-completions" };
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
  return path;
}
