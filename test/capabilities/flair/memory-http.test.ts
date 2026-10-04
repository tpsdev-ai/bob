import { expect, it } from "bun:test";
import { createServer } from "node:http";
import { FlairHttpClient } from "../../../src/capabilities/flair/client.js";

for (const method of ["GET", "PUT"] as const) {
  for (const failure of ["deadline", "bytes", "oversized 404"] as const) {
    if (method === "PUT" && failure === "oversized 404") continue;
    it(`${method} refuses the HTTP server's ${failure} response`, async () => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const server = createServer((_req, res) => {
        if (failure === "deadline") {
          timers.push(setTimeout(() => res.end('{"id":"row"}'), 200));
        } else {
          res.writeHead(failure === "oversized 404" ? 404 : 200);
          res.write('{"id":"row","content":"');
          res.end(`${"€".repeat(64)}"}`);
        }
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("missing server port");
        const client = new FlairHttpClient({
          url: `http://127.0.0.1:${address.port}`,
          agentId: "anvil",
          keyFile: "/unused",
          readFile: () => Buffer.alloc(32, 7),
        });
        const bounds = { timeoutMs: failure === "deadline" ? 30 : 1_000, maxResponseBytes: 64 };
        const pending =
          method === "GET"
            ? client.get("row", bounds)
            : client.write("round", { id: "row", ...bounds });
        await expect(pending).rejects.toThrow(
          failure === "deadline"
            ? "flair request timed out"
            : "flair response exceeded the size bound",
        );
      } finally {
        for (const timer of timers) clearTimeout(timer);
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
}
