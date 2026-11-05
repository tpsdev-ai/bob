import type { AssistantMessage } from "@earendil-works/pi-ai";
import { hasNoContentBlocks } from "./empty-response.js";

export class UnrecoveredEmptyResponseError extends Error {
  readonly reason = "unrecovered_empty_response";

  constructor(
    readonly provider: string,
    readonly model: string,
  ) {
    super(
      `the provider ${provider} returned an unrecovered empty length response for model ${model}`,
    );
    this.name = "UnrecoveredEmptyResponseError";
  }
}

export function rejectUnrecoveredEmptyResponse(message: unknown): void {
  if (typeof message !== "object" || message === null) return;
  const terminal = message as Partial<AssistantMessage>;
  if (
    terminal.role === "assistant" &&
    terminal.stopReason === "length" &&
    hasNoContentBlocks(terminal) &&
    typeof terminal.provider === "string" &&
    typeof terminal.model === "string"
  ) {
    throw new UnrecoveredEmptyResponseError(terminal.provider, terminal.model);
  }
}
