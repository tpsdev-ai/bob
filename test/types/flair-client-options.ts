import type { FlairHttpClientOptions } from "../../src/capabilities/flair/client.js";
import type { PrMemorySeams } from "../../src/shell/pr-memory.js";

const options: FlairHttpClientOptions = {
  url: "http://flair.test",
  agentId: "agent",
  keyFile: "/unused",
  // @ts-expect-error signedAt belongs to prMemorySeams.
  signedAt: Date.now,
};
const seams: PrMemorySeams = { signedAt: Date.now };
void options;
void seams;
