import type { AssistantMessage } from "@earendil-works/pi-ai";
import { classifyAssistantEnding } from "./compaction-contract.js";

export class UnrecoveredEmptyResponseError extends Error {
  readonly reason = "unrecovered_empty_response";

  constructor(
    readonly provider: string,
    readonly model: string,
  ) {
    super(`the provider ${provider} returned an unrecovered empty response for model ${model}`);
    this.name = "UnrecoveredEmptyResponseError";
  }
}

export function rejectUnrecoveredEmptyResponse(message: unknown): void {
  if (typeof message !== "object" || message === null) return;
  const terminal = message as Partial<AssistantMessage>;
  const ending = classifyAssistantEnding(Array.isArray(terminal.content) ? terminal.content : []);
  if (
    terminal.role === "assistant" &&
    terminal.stopReason !== "error" &&
    terminal.stopReason !== "aborted" &&
    ending.text.trim().length === 0 &&
    !ending.hasToolCall
  ) {
    throw new UnrecoveredEmptyResponseError(
      typeof terminal.provider === "string" ? terminal.provider : "unknown",
      typeof terminal.model === "string" ? terminal.model : "unknown",
    );
  }
}
