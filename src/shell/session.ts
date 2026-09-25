// The ONE bob session factory, adapted to pi's runtime-factory contract.
//
// Round 3 of the role-tool-allowlist work deletes the last launch path that
// built a pi command line. `bob` no longer spawns the pi CLI and no longer
// assembles argv: every session — `bob run`, the persistent runtime, the
// launcher with a prompt, the mail consumer, `bob launch` (interactive), the
// hiring interview and `bob align` — comes from the factory below, through
// pi's own SDK entry points.
//
// The factory returns the session TOGETHER WITH its matching services (pi's
// runtime-factory shape), because the session can only be audited against the
// cwd-bound services it was created from. What it guarantees:
//
//   (a) the EFFECTIVE policy — the role ceiling intersected with bob.yaml,
//       minus `exclude` and the resident exclusions — is what the session is
//       created with (resolved by run.ts; it is REQUIRED, see RunSessionConfig);
//   (b) pi's settings and resource sources are built HERE, isolated: project
//       trust off, no configured packages, no discovery of user or project
//       extensions, skills, prompt templates, themes or context files, and no
//       global SYSTEM.md / APPEND_SYSTEM.md. The only extensions are the
//       declared capabilities' paths. A reload re-reads these same isolated
//       sources — it cannot reach anything else;
//   (c) the audit runs at creation, again after the mode binds extensions
//       (that is an extendResources + reload) and after EVERY reload. pi's TUI
//       shows a reload error and carries on, so throwing is not enough: a
//       failed audit disposes the session and ends the process with the named
//       error before another turn can run.

import { join } from "node:path";
import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type DefaultResourceLoader,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { RunSession, RunSessionConfig } from "./run.js";
import { PI_BUILTIN_TOOLS, type ToolPolicy } from "./tool-allowlist.js";

// pi does not export DefaultResourceLoaderOptions at the package root, so
// derive the loader-option shape from the class: cwd/agentDir/settingsManager
// are supplied by createAgentSessionServices, and this is the rest.
type LoaderOptions = Omit<
  ConstructorParameters<typeof DefaultResourceLoader>[0],
  "cwd" | "agentDir" | "settingsManager"
>;

// The FIXED policy onboarding and alignment run under. They are privileged
// local setup commands (see README "Stated exceptions"): the interview has to
// READ the seed persona and WRITE the refined one, so the setup policy is
// exactly read + write — the two tools that job needs, and nothing else.
//
// It may exceed the role's ceiling on purpose: a `reviewer` agent is hired by
// a human at the keyboard who is already allowed to edit that human's files,
// and the tool that would let the MODEL reach the interview is the shell tool,
// which no role has without write anyway. A model cannot open this path.
export const SETUP_TOOL_POLICY: ToolPolicy = {
  tools: ["read", "write"],
  excludeTools: [],
  resident: false,
  allowResidentShell: false,
};

// Diagnostics + the process-exit seam, injectable so a test can watch a failed
// audit end the session without killing the test runner.
export interface SessionDeps {
  log?: (msg: string) => void;
  exit?: (code: number) => void;
}

// What the audit needs from a created session (structural, so a test can hand
// in a fake without standing up pi). Exported under both names: run.ts's public
// surface calls this ActiveToolSource.
export interface AuditSession {
  getActiveToolNames(): string[];
}
export type ActiveToolSource = AuditSession;

// What the audit needs from the loaded extensions (structural).
export interface AuditExtensions {
  getExtensions(): {
    extensions: Array<{ path: string; tools: Map<string, unknown> }>;
  };
}

// Isolated settings: in-memory, so NO user or project settings.json is read —
// no configured package, extension, skill, prompt or theme path can reach the
// loader, which is also what makes "nothing is installed" true (there is no
// package to resolve). projectTrusted:false keeps project discovery off
// regardless of any trust.json on disk.
export function isolatedSettings(): SettingsManager {
  return SettingsManager.inMemory({}, { projectTrusted: false });
}

// The isolated resource-loader options: nothing ambient, only the agent's
// declared capabilities.
export function isolatedLoaderOptions(
  config: Pick<RunSessionConfig, "appendSystemPrompt" | "extensionSources" | "piAgentDir">,
): LoaderOptions {
  return {
    // The only extensions are the declared capabilities' paths. With
    // noExtensions the loader uses exactly these (temporary CLI scope) and
    // nothing else.
    additionalExtensionPaths: [...config.extensionSources],
    // No ambient discovery of anything.
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    // An explicit (empty) prompt source disables SYSTEM.md discovery — the
    // global APPEND_SYSTEM.md too. The append source is exactly soul.md.
    systemPrompt: "",
    appendSystemPrompt: config.appendSystemPrompt.length > 0 ? [config.appendSystemPrompt] : [],
  };
}

// The audit: every name in the effective policy is active, and no tool name is
// provided by more than one source (a pi built-in or a declared capability).
//
// pi ignores an unknown name in `tools` silently, so an allowlisted name that
// nothing registered would just be absent; a name TWO sources provide is
// ambiguous — which implementation wins is pi's load order, not a decision the
// role made.
//
// Duplicate registrations INSIDE one declared capability are not observable
// after load and are out of scope: declared capabilities are bob's own code, so
// that is a bob bug pinned by bob's own tests, not an agent configuration
// surface.
export function auditToolSources(
  config: Pick<RunSessionConfig, "tools" | "excludeTools" | "capabilityBySource">,
  extensions: Array<{ path: string; tools: Map<string, unknown> }>,
): void {
  const allowed = config.tools ?? [];
  const excluded = new Set(config.excludeTools ?? []);
  const builtins = new Set<string>(PI_BUILTIN_TOOLS);
  const sourcesByTool = new Map<string, string[]>();

  for (const name of allowed) {
    // A name the denylist removes is absent ON PURPOSE (pi applies excludeTools
    // after tools), so it is not a duplicate-source question.
    if (excluded.has(name)) continue;
    const sources: string[] = [];
    if (builtins.has(name)) sources.push("pi's built-in tools");
    for (const ext of extensions) {
      if (ext.tools.has(name)) sources.push(config.capabilityBySource?.[ext.path] ?? ext.path);
    }
    if (sources.length > 0) sourcesByTool.set(name, sources);
  }

  const duplicates = [...sourcesByTool].filter(([, sources]) => sources.length > 1);
  if (duplicates.length === 0) return;

  throw new Error(
    [
      `bob: ${duplicates.length} tool name${duplicates.length === 1 ? " is" : "s are"} provided by more than one source:`,
      ...duplicates.map(([name, sources]) => `  ${name} — ${sources.join(", ")}`),
      "",
      "Which implementation a tool call reaches would depend on pi's load order,",
      "not on the role's policy. Rename the capability's tool, or drop the name from",
      "tools.allow in bob.yaml.",
    ].join("\n"),
  );
}

// Run the whole audit for a freshly created session: the active-tool check
// (passed in so this module does not import run.ts at runtime) plus the
// source check.
export function auditCreatedSession(
  session: AuditSession,
  extensions: AuditExtensions,
  config: Pick<RunSessionConfig, "tools" | "excludeTools" | "capabilityBySource">,
  assertActive: (session: AuditSession) => void,
): void {
  assertActive(session);
  auditToolSources(config, extensions.getExtensions().extensions);
}

// On a failed audit: dispose the session, then end the process with the named
// error. pi's TUI shows a reload error and carries on, so a throw from a reload
// hook would leave a session running whose policy no longer holds. Never
// returns in production (process.exit); a test injects `exit` and sees the
// throw instead.
export function auditOrExit(
  audit: () => void,
  session: { dispose(): void },
  deps?: SessionDeps,
): void {
  try {
    audit();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    try {
      session.dispose();
    } catch {
      // The audit failure is the error that matters; a dispose failure here
      // must not replace it.
    }
    const log = deps?.log ?? ((m: string) => console.error(m));
    log(
      "bob: the session's tool policy no longer holds after binding extensions; " +
        `disposing it and ending the process before another turn can run.\n${msg}`,
    );
    (deps?.exit ?? ((code: number) => process.exit(code)))(1);
    throw err;
  }
}

// Make every reload re-run the audit. The interactive mode binds extensions by
// extending resources and reloading, so this is the seam that covers "after the
// mode binds extensions" and "after every reload" with one hook — and because
// the loader only ever re-reads the isolated sources above, a reload cannot
// pull in anything it did not have at creation.
export function installReloadAudit(
  loader: { reload(options?: unknown): Promise<void> },
  audit: () => void,
): void {
  const original = loader.reload.bind(loader);
  loader.reload = async (options?: unknown) => {
    await original(options);
    audit();
  };
}

export interface BobFactoryInput {
  // The agent's pinned identity + directories. Whatever a resumed, forked,
  // cloned or imported session names, the factory uses THESE.
  config: RunSessionConfig;
  // The effective tool policy (role ceiling ∩ bob.yaml, minus the exclusions).
  policy: ToolPolicy;
  deps?: SessionDeps;
}

// The runtime factory. pi calls it for the initial session and again for every
// /new, /resume, /fork, /clone and /import, so all of those go through the
// pinned identity, the isolated sources and the audit.
export function createBobRuntimeFactory(input: BobFactoryInput): CreateAgentSessionRuntimeFactory {
  const { config, policy, deps } = input;
  // The active-tool check mirrors run.ts's assertAllowedToolsActive; kept as a
  // parameter so this module does not depend on run.ts at runtime.
  return async ({ sessionManager }) => {
    // PIN the agent's own identity + directory. A resumed or imported session
    // records its own cwd and agent dir; bob's agent is bob's agent.
    const cwd = config.cwd;
    const agentDir = config.piAgentDir;

    // Capability config env, then the runtime-mode signal — read by the
    // extensions at load time below. Config only; never a secret.
    for (const [key, value] of Object.entries(config.capabilityEnv)) {
      process.env[key] = value;
    }
    process.env.BOB_PERSISTENT = config.persistent ? "1" : "";

    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: isolatedSettings(),
      modelRuntime,
      resourceLoaderOptions: isolatedLoaderOptions(config),
    });
    // bob asked for these extensions explicitly: a declared capability whose
    // extension did not load is not an optional nicety.
    assertCapabilitiesLoaded(services.resourceLoader, config);

    const model = services.modelRuntime.getModel(config.provider, config.model);
    if (!model) {
      throw new Error(
        `model not found: ${config.provider}/${config.model} (check bob.yaml provider/model and ${join(agentDir, "models.json")})`,
      );
    }

    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      model,
      tools: policy.tools,
      ...(policy.excludeTools.length > 0 ? { excludeTools: policy.excludeTools } : {}),
    });

    const assertActive = (session: AuditSession) => {
      assertAllowedToolsActive(session, policy);
    };
    const runAudit = () =>
      auditCreatedSession(
        result.session as unknown as AuditSession,
        services.resourceLoader,
        { ...config, tools: policy.tools, excludeTools: policy.excludeTools },
        assertActive,
      );

    // Creation: a throw is enough. The caller (run.ts/persistent.ts/the
    // launcher) is about to use the session, so failing loudly here means no
    // turn can run on a policy that does not hold — and dispose the session the
    // factory just built, so no connection or timer outlives the refusal.
    try {
      runAudit();
    } catch (err) {
      try {
        (result.session as unknown as { dispose(): void }).dispose();
      } catch {
        // the audit failure is the error that matters
      }
      throw err;
    }

    // After the mode binds extensions (an extendResources + reload) and after
    // EVERY reload: pi's TUI shows a reload error and carries on, so a throw
    // here would leave a running session whose policy no longer holds. Dispose
    // it and end the process with the named error instead.
    installReloadAudit(services.resourceLoader, () =>
      auditOrExit(runAudit, result.session as unknown as { dispose(): void }, deps),
    );

    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    };
  };
}

// The active-tool check: every name in the effective policy must be ACTIVE in
// the session. pi ignores an unknown name silently (`setActiveToolsByName`),
// so an allowlisted name nothing registered would just be absent — an
// allowlist that looks enforced and is not.
export function assertAllowedToolsActive(
  session: AuditSession,
  policy: Pick<ToolPolicy, "tools" | "excludeTools">,
): void {
  const allowed = policy.tools;
  if (allowed.length === 0) return;
  const active = new Set(session.getActiveToolNames());
  const excluded = new Set(policy.excludeTools);
  const missing = allowed.filter((name) => !active.has(name) && !excluded.has(name));
  if (missing.length === 0) return;
  throw new Error(
    [
      `bob: ${missing.length} allowlisted tool${missing.length === 1 ? "" : "s"} not active in the session: ${missing.join(", ")}`,
      "",
      "pi enables only the tools the loaded capabilities register, and ignores an",
      "unknown name silently — so a role allowlist naming a tool whose capability",
      "the agent never declared leaves the session quietly missing it.",
      "",
      "Fix: declare the capability in bob.yaml (capabilities:) and configure it, or",
      "drop the name from tools.allow.",
    ].join("\n"),
  );
}

// The minimum of pi's resource loader the capability check needs. Structural so
// tests can hand in a stub without constructing a real loader.
export interface ExtensionErrorSource {
  getExtensions(): { errors: Array<{ path: string; error: string }> };
}

// Fail the session if any capability's extension did not load.
//
// pi records extension load failures on the loader and CONTINUES — the agent
// comes up, just without those tools. bob asked for these extensions
// explicitly, so for bob they are not optional. Errors from extensions bob
// didn't ask for are pi's business and are left alone (and with round 3's
// isolation there should be none: nothing ambient is loaded at all).
export function assertCapabilitiesLoaded(
  loader: ExtensionErrorSource,
  config: Pick<RunSessionConfig, "extensionSources" | "capabilityBySource">,
): void {
  if (config.extensionSources.length === 0) return;
  const ours = new Set(config.extensionSources);
  const failures = (loader.getExtensions().errors ?? []).filter((e) => ours.has(e.path));
  if (failures.length === 0) return;

  const lines = failures.map((f) => {
    const name = config.capabilityBySource?.[f.path];
    const who = name ? `capability "${name}"` : "capability";
    return `  ${who} (${f.path}): ${f.error}`;
  });
  throw new Error(
    [
      `bob: ${failures.length} declared capabilit${failures.length === 1 ? "y" : "ies"} failed to load:`,
      ...lines,
      "",
      "The agent would have started without those tools. Fix the capability or remove",
      "it from capabilities: in bob.yaml rather than running under-equipped.",
    ].join("\n"),
  );
}

// Send a prompt as THE text: no command, prompt-template or skill expansion, so
// nothing bob did not declare can interpret it. This is the single prompt
// entry point for every non-interactive path (`bob run`, the persistent
// runtime, the launcher with a prompt, the mail consumer).
export async function promptSession(session: RunSession, text: string): Promise<void> {
  await session.prompt(text, { expandPromptTemplates: false });
}

export interface InteractiveRunInput {
  config: RunSessionConfig;
  policy: ToolPolicy;
  // Sent as the first message once the TUI is up (onboarding / alignment).
  initialMessage?: string;
  deps?: SessionDeps;
  // Test seam: build the mode around the runtime. Defaults to pi's
  // InteractiveMode.
  modeFactory?: (runtime: AgentSessionRuntime) => { run(): Promise<void> };
}

// The interactive path: an AgentSessionRuntime built from the ONE factory,
// handed to pi's InteractiveMode. New, resume, fork, clone and import all go
// through the factory, which pins the agent's identity and directory.
export async function runInteractiveSession(input: InteractiveRunInput): Promise<number> {
  const { config, policy, deps } = input;
  const runtime = await createAgentSessionRuntime(
    createBobRuntimeFactory({ config, policy, deps }),
    {
      cwd: config.cwd,
      agentDir: config.piAgentDir,
      sessionManager: SessionManager.create(config.cwd),
    },
  );
  const mode = input.modeFactory
    ? input.modeFactory(runtime)
    : new InteractiveMode(runtime, {
        startupDiagnostics: [...runtime.diagnostics],
        ...(runtime.modelFallbackMessage
          ? { modelFallbackMessage: runtime.modelFallbackMessage }
          : {}),
        ...(input.initialMessage ? { initialMessage: input.initialMessage } : {}),
      });
  await mode.run();
  return 0;
}
