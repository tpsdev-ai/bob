import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessageEventStream,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionRuntime,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { type RunSession, runAgent } from "../../src/shell/run.js";
import { createBobRuntimeFactory } from "../../src/shell/session.js";

let root: string;
let cwd: string;
let savedTmpdir: string | undefined;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bob-budget-session-"));
  savedTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = join(root, "tmp");
  mkdirSync(process.env.TMPDIR);
  cwd = join(root, "builder", "work");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, "builder", ".pi-agent"));
  writeFileSync(
    join(root, "builder", "bob.yaml"),
    "agent:\n  id: builder\n  name: builder\n  role: builder-local\nprovider:\n  name: anthropic\n  model: claude-sonnet-4-6\n  context_window: 200000\ncapabilities:\n  - work\ntools:\n  allow:\n    - run\n",
  );
  writeFileSync(join(root, "builder", "soul.md"), "Build the task.");
  writeFileSync(join(cwd, "tracked"), "original\n");
  git("init", "--quiet");
  git("add", "tracked");
  git(
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "fixture",
  );
});
afterEach(() => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  rmSync(root, { recursive: true, force: true });
});

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
    encoding: "utf8",
    stdio: "pipe",
    timeout: 5_000,
  }).trim();
}

function commandsThenDone(commands: string[]) {
  let calls = 0;
  return (
    model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();
    const index = calls++;
    const command = commands[index];
    queueMicrotask(async () => {
      const message = {
        role: "assistant" as const,
        content:
          command === undefined
            ? [{ type: "text" as const, text: "DONE: changed tracked." }]
            : [
                {
                  type: "toolCall" as const,
                  id: `call-${index}`,
                  name: "run",
                  arguments: { command, timeout_s: 2 },
                },
              ],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: (command === undefined ? "stop" : "toolUse") as "stop" | "toolUse",
        timestamp: Date.now(),
      };
      try {
        await options?.onPayload?.(
          {
            model: model.id,
            system: [{ type: "text", text: context.systemPrompt ?? "" }],
            messages: context.messages,
          },
          model,
        );
        stream.push({ type: "start", partial: { ...message, content: [] } as never });
        stream.push({ type: "done", reason: message.stopReason, message: message as never });
        stream.end(message as never);
      } catch (error) {
        const failed = {
          ...message,
          content: [],
          stopReason: "error" as const,
          errorMessage: String(error),
        };
        stream.push({ type: "error", reason: "error", error: failed as never });
        stream.end(failed as never);
      }
    });
    return stream;
  };
}

describe("exploration budget through the session factory and command tool", () => {
  it.each(["edit", "pending"])(
    "handles a limiting %s command",
    async (kind) => {
      const launchHead = git("rev-parse", "HEAD");
      const edit =
        "printf 'during-call edit\\n' > tracked && git add tracked && git -c user.name=Test -c user.email=test@example.invalid commit --quiet -m edit";
      const modelRuntime = await ModelRuntime.create({
        authPath: join(root, "builder", ".pi-agent", "auth.json"),
        modelsPath: null,
      });
      modelRuntime.registerProvider("bob-budget-stub", {
        name: "Stub",
        apiKey: "stub-key",
        api: "bob-budget-stub-api",
        baseUrl: "http://localhost:0",
        streamSimple: commandsThenDone([
          "printf 'read-only\\n'",
          kind === "edit" ? edit : "sleep 5",
        ]),
        models: [
          {
            id: "claude-sonnet-4-6",
            name: "Stub",
            api: "bob-budget-stub-api",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 200_000,
            maxTokens: 4096,
          },
        ],
      });
      let runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>> | undefined;
      const starts: string[] = [];
      const ends: Array<{ id: string; isError: boolean; details: Record<string, unknown> }> = [];
      let pendingAtAbort = false;
      try {
        const result = await runAgent({
          name: "builder",
          agentsRoot: root,
          prompt: "Edit tracked.",
          explorationBudget: 1,
          wallClockMs: 8_000,
          noProgressMs: 8_000,
          turnTimeoutMs: kind === "pending" ? 750 : 6_000,
          sessionFactory: async (config) => {
            const factory = createBobRuntimeFactory({
              config: {
                ...config,
                provider: "bob-budget-stub",
                providerRecord: undefined,
                modelLimits: {
                  provider: "bob-budget-stub",
                  model: config.model,
                  contextWindow: 200_000,
                },
              },
              policy: {
                tools: config.tools,
                excludeTools: config.excludeTools,
                resident: false,
                allowResidentShell: false,
              },
              deps: {
                log: (message) => {
                  throw new Error(message);
                },
                exit: (code) => {
                  throw new Error(`Unexpected exit ${code}`);
                },
              },
              modelRuntime,
            });
            runtime = await createAgentSessionRuntime(factory, {
              cwd,
              agentDir: config.piAgentDir,
              sessionManager: SessionManager.inMemory(cwd),
            });
            expect(runtime.session.getActiveToolNames()).toEqual(["run"]);
            runtime.session.subscribe((event) => {
              if (event.type === "tool_execution_start") starts.push(event.toolCallId);
              if (event.type === "tool_execution_end")
                ends.push({
                  id: event.toolCallId,
                  isError: event.isError,
                  details: (event.result.details ?? {}) as Record<string, unknown>,
                });
            });
            const session = runtime.session;
            const abort = session.abort.bind(session);
            session.abort = async () => {
              pendingAtAbort =
                starts.includes("call-1") && !ends.some((end) => end.id === "call-1");
              await abort();
            };
            return session as unknown as RunSession;
          },
        });
        expect(starts).toEqual(["call-0", "call-1"]);
        expect(ends[0]).toMatchObject({
          id: "call-0",
          isError: false,
          details: { outcome: "exited", exit_code: 0 },
        });
        if (kind === "edit") {
          expect(result.explorationBudgetExhausted).toBeUndefined();
          expect(result.exitCode).toBe(0);
          expect(result.aborted).toBeUndefined();
          expect(result.noEditNoBlocked).toBeUndefined();
          expect(ends[1]).toMatchObject({
            id: "call-1",
            isError: false,
            details: { outcome: "exited", exit_code: 0 },
          });
          expect(git("rev-parse", "HEAD")).not.toBe(launchHead);
          expect(readFileSync(join(cwd, "tracked"), "utf8")).toBe("during-call edit\n");
        } else {
          expect(pendingAtAbort).toBe(true);
          expect(result.exitCode).toBe(1);
          expect(result.aborted).toBe("turn_timeout");
          expect(git("rev-parse", "HEAD")).toBe(launchHead);
        }
      } finally {
        await runtime?.dispose();
      }
    },
    15_000,
  );
});
