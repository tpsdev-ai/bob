import { expect, it } from "bun:test";
import { fileURLToPath } from "node:url";

it.skipIf(!process.env.FLAIR_AUTH_SOURCE_DIR)(
  "checks stub refusals against Flair agent-auth, auth-middleware and replay-store",
  async () => {
    const child = Bun.spawn(
      [
        process.execPath,
        fileURLToPath(new URL("../fixtures/flair/auth-contract.ts", import.meta.url)),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    const [status, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect({ status, stdout, stderr }).toEqual({ status: 0, stdout: "", stderr: "" });
  },
);
