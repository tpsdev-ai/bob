import type { ProviderConfig } from "../../src/shell/index.js";

type Assert<T extends true> = T;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type MainProviderName =
  | "ollama-cloud"
  | "ollama-newton"
  | "exe-dev-gateway"
  | "anthropic"
  | "openai"
  | "openrouter"
  | "omlx";

export type ProviderConfigRegression = [
  Assert<Equal<ProviderConfig["name"], MainProviderName>>,
  Assert<Equal<Extract<ProviderConfig["name"], "ollama" | "acme">, never>>,
];
