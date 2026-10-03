import { lstatSync, readFileSync, writeFileSync } from "node:fs";
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
  try {
    const file = lstatSync(path);
    if (!file.isFile() || file.nlink !== 1) {
      throw new Error(`bob models: refusing non-file, symlink, or hard-linked ${path}`);
    }
    document = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
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
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  return path;
}
