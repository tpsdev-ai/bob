// The ONE bob session factory, adapted to pi's runtime-factory contract.
//
// `bob` never spawns the pi CLI and never assembles argv: every session —
// `bob run`, the persistent runtime, the launcher with a prompt, the mail
// consumer, `bob launch` (interactive), the hiring interview and `bob align` —
// comes from the factory below, through pi's own SDK entry points.
//
// The factory returns the session TOGETHER WITH its matching services (pi's
// runtime-factory shape), because the session can only be audited against the
// cwd-bound services it was created from. What it guarantees:
//
//   (a) the EFFECTIVE policy — the role ceiling intersected with bob.yaml,
//       minus `exclude` and the resident exclusions — is what the session is
//       created with (resolved by run.ts; it is REQUIRED, see RunSessionConfig);
//   (b) pi's settings and resource sources are built HERE, isolated: project
//       trust off, no configured package installed, and the ambient user and
//       project extension, skill, prompt-template and theme paths are never
//       LOADED (package resolution still enumerates the user-level ones before the
//       flags that drop them apply; with project trust off, project resource
//       directories are not scanned). Context files are not enumerated at all: pi skips
//       context-file discovery outright under `noContextFiles`, so no ambient
//       context file is read either — and no global SYSTEM.md / APPEND_SYSTEM.md
//       either. The only extensions that load are the declared capabilities'
//       paths. A reload re-reads exactly these isolated sources — it cannot reach
//       anything else;
//   (c) the audit runs at creation, again after the mode binds extensions (that
//       is a bindExtensions, which emits session_start and extends resources
//       from the extensions) and after EVERY session.reload() — NOT from inside
//       the reload, where pi has not rebuilt the tool list yet. pi's TUI shows
//       a reload error and carries on, so throwing is not enough: a failed
//       audit disposes the session and ends the process with the named error
//       before another turn can run. A reload or a bind that THROWS is a failed
//       audit too — the session may be half-rebuilt, and the mode would
//       otherwise stay open on a tool state nobody audited.

import { join } from "node:path";
import {
  type AgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  type DefaultResourceLoader,
  type InlineExtension,
  InteractiveMode,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { RunSession, RunSessionConfig } from "./run.js";
import {
  appendContractOverride,
  buildContractBlock,
  type ContractGuardDeps,
  createContractGuardExtension,
} from "./system-prompt-contract.js";
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
// which can already write files (the reviewer role has bash and no write tool),
// so read + write grants a model that reaches it nothing new.
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
// declared capabilities — plus, when the agent has a contract (#145), the
// contract block appended as LITERAL TEXT and bob's guard loaded as an INLINE
// extension.
//
// The contract is appended through `appendSystemPromptOverride`, never as an
// `appendSystemPrompt` source: pi resolves a source string that happens to name
// an existing file as that FILE's contents (core/resource-loader.js
// `resolvePromptInput`), which would silently turn a task into whatever is on
// disk at that path. `appendContractOverride` is called after pi has
// turned its sources into text, so what it returns is used as text, full stop.
//
// `extensionFactories` is where the guard goes: pi appends inline extensions
// AFTER every path-loaded one (core/resource-loader.js `loadExtensionFactories`
// / `loadFinalExtensionSet`), and runs `before_provider_request` handlers in
// list order, so the guard sees the payload last — after every declared
// capability has had its turn.
export function isolatedLoaderOptions(
  config: Pick<RunSessionConfig, "appendSystemPrompt" | "extensionSources" | "piAgentDir"> & {
    contractBlock?: string;
  },
  extra?: { guard?: InlineExtension },
): LoaderOptions {
  const contractBlock = config.contractBlock;
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
    ...(contractBlock !== undefined
      ? { appendSystemPromptOverride: appendContractOverride(contractBlock) }
      : {}),
    ...(extra?.guard !== undefined ? { extensionFactories: [extra.guard] } : {}),
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
//
// `what` names the situation for the log line, because a reload or a bind that
// THROWS takes this same path (round 5) and is not literally a policy that
// stopped holding.
//
// The thrown value IS the message when it is not an Error: `undefined` and
// `null` are legal rejection values, and the bare strings "undefined"/"null"
// would name nothing, so those are described instead of stringified (round 6 — a
// promise can reject with `undefined`, and this path must still say what
// arrived).
export function auditOrExit(
  audit: () => void,
  session: { dispose(): void },
  deps?: SessionDeps,
  what = "the session's tool policy no longer holds after binding extensions",
): void {
  try {
    audit();
  } catch (err) {
    // Dispose FIRST, before anything that can itself throw: describing the
    // failure can (a rejection value whose String() throws, or an Error whose
    // message getter does), and nothing may stand between a failed audit and
    // the dispose and exit below.
    try {
      session.dispose();
    } catch {
      // The audit failure is the error that matters; a dispose failure here
      // must not replace it.
    }
    let msg: string;
    try {
      msg =
        err instanceof Error
          ? err.message
          : err === undefined
            ? "the failure arrived with no error value (rejected with undefined)"
            : err === null
              ? "the failure arrived with no error value (rejected with null)"
              : String(err);
    } catch {
      msg = "the failure arrived with a value that cannot be described";
    }
    try {
      const log = deps?.log ?? ((m: string) => console.error(m));
      log(`bob: ${what}; disposing it and ending the process before another turn can run.\n${msg}`);
    } finally {
      (deps?.exit ?? ((code: number) => process.exit(code)))(1);
    }
    throw err;
  }
}

// Run the audit AFTER pi has finished the work that can change the active tool
// set — not in the middle of it, and not against the loader alone. Two pi
// session methods rebuild that set:
//
//   * `session.reload()` awaits the resource loader's reload and THEN rebuilds
//     the session's tool registry from the extensions that came back
//     (agent-session.js: `await this._resourceLoader.reload()` followed by
//     `this._buildRuntime(...)`). An audit hooked into the LOADER therefore runs
//     before that rebuild and reads the OLD active list — a capability that
//     stopped registering a tool is not visible yet;
//   * `session.bindExtensions()` is how the interactive mode hands the session
//     its bindings. pi emits `session_start` (where a capability may switch
//     tools) and then extends its resources from the extensions' discover
//     handlers. pi does NOT reload here, so a loader hook never fires at all for
//     the mode's bind.
//
// So both are wrapped on the SESSION INSTANCE, and both audit after the original
// returns. Because the loader only ever re-reads the isolated sources above, a
// reload cannot pull in anything it did not have at creation.
//
// Round 5: a reload or a bind that THROWS is a FAILED AUDIT. pi's interactive
// mode catches the throw and stays open, so auditing only after success left the
// session serving on a tool state nobody audited — exactly what an audit that
// fails exists to stop. The callback is given the original error in that case,
// and the caller puts it on the same path as a failed audit (dispose + end the
// process with the ORIGINAL error named). Nothing is audited after a throw: the
// state is unknown, so no reading of it can be trusted.
// Round 6: the outcome is a TAG, not an error-or-undefined sentinel. JavaScript
// can reject with `undefined` (`Promise.reject(undefined)`), so "called with no
// argument" and "rejected with undefined" are indistinguishable — the old shape
// took the SUCCESS branch on a failed reload or bind, disposing nothing and
// ending nothing. The wrapper now always states which it is.
export type AuditOutcome = { ok: true } | { ok: false; error: unknown };

export function installSessionAudits(
  session: {
    reload(options?: unknown): Promise<void>;
    bindExtensions(bindings: unknown): Promise<void>;
  },
  audit: (outcome: AuditOutcome) => void,
): void {
  // pi 0.84.3's contract: both are instance methods every mode calls through
  // the instance (agent-session.js :2142, :1831). If a pi upgrade renames
  // either, refuse loudly here rather than wrap nothing.
  if (typeof session.reload !== "function" || typeof session.bindExtensions !== "function") {
    throw new Error(
      "bob: this pi session has no reload()/bindExtensions() to audit after (the pi 0.84.3 contract bob wraps); refusing to start a session whose reloads and binds would go unaudited",
    );
  }
  const runThenAudit = async (work: () => Promise<void>): Promise<void> => {
    try {
      await work();
    } catch (err) {
      audit({ ok: false, error: err });
      return;
    }
    audit({ ok: true });
  };

  const originalReload = session.reload.bind(session);
  session.reload = (options?: unknown) => runThenAudit(() => originalReload(options));

  const originalBind = session.bindExtensions.bind(session);
  session.bindExtensions = (bindings: unknown) => runThenAudit(() => originalBind(bindings));
}

export interface BobFactoryInput {
  // The agent's pinned identity + directories. Whatever a resumed, forked,
  // cloned or imported session names, the factory uses THESE.
  config: RunSessionConfig;
  // The effective tool policy (role ceiling ∩ bob.yaml, minus the exclusions).
  policy: ToolPolicy;
  deps?: SessionDeps;
  // Test seam: a pre-built model runtime, so a test can drive a REAL pi session
  // with a scripted provider (a stub model) instead of a network one. Omitted
  // in production, where the runtime is built from the agent's own
  // auth.json/models.json.
  modelRuntime?: unknown;
}

// Fail the session if bob's OWN guard extension did not load (#145). pi records
// an extension load failure on the loader and CONTINUES, so a guard that failed
// to load would leave every outgoing request unchecked while the session looked
// healthy — the exact silent-loss shape the guard exists to end. Inline
// extensions are the ones pi names `<inline:...>`; every other extension here is
// a declared capability, which assertCapabilitiesLoaded already covers.
export function assertContractGuardLoaded(
  loader: ExtensionErrorSource,
  guard: InlineExtension | undefined,
): void {
  if (guard === undefined) return;
  const failures = (loader.getExtensions().errors ?? []).filter((e) =>
    e.path.startsWith("<inline:"),
  );
  if (failures.length === 0) return;
  throw new Error(
    [
      `bob: ${failures.length} of bob's own inline extension${failures.length === 1 ? " did" : "s did"} not load:`,
      ...failures.map((f) => `  ${f.path}: ${f.error}`),
      "",
      "The #145 contract guard is registered as an inline extension; without it no request",
      "is checked for the contract, so the session is refused rather than run unguarded.",
    ].join("\n"),
  );
}

/**
 * The literal contract block a session carries in its system prompt, or
 * undefined when it carries none. The one-shot task and the persistent standing
 * contract are mutually exclusive: a session that was started for one task and
 * also claims a standing contract would be carrying two answers to "what am I
 * doing", so that config is refused rather than resolved.
 */
export function contractBlockFor(
  config: Pick<RunSessionConfig, "taskContract" | "standingContract" | "contractCapChars">,
): string | undefined {
  const hasTask = config.taskContract !== undefined;
  const hasStanding = config.standingContract !== undefined;
  if (hasTask && hasStanding) {
    throw new Error(
      "bob: refusing a session config with BOTH a task contract and a standing contract — pass taskContract (a one-shot run) OR standingContract (the persistent runtime), never both",
    );
  }
  if (!hasTask && !hasStanding) return undefined;
  return buildContractBlock({
    label: hasTask ? "TASK" : "STANDING CONTRACT",
    text: (hasTask ? config.taskContract : config.standingContract) as string,
    capChars: config.contractCapChars,
  });
}

// The runtime factory. pi calls it for the initial session and again for every
// /new, /resume, /fork, /clone and /import, so all of those go through the
// pinned identity, the isolated sources and the audit.
export function createBobRuntimeFactory(input: BobFactoryInput): CreateAgentSessionRuntimeFactory {
  const { config, policy } = input;
  const deps = input.deps;
  // The #145 contract, built ONCE: the same literal block is appended to the
  // system prompt (through the loader's override) and handed to the guard, so
  // "the request carries the contract" is one string compared with itself.
  const contractBlock = contractBlockFor(config);
  // The guard's deps. The session exists only after the factory has built it,
  // so the holder is filled in below; a guard that fires before then (it cannot
  // — no request is made before the session exists) still ends the process,
  // just without a session to dispose.
  //
  // The holder also carries pi's "a compaction or branch summary is running"
  // flag (`AgentSession.isCompacting`, pi 0.84.3 agent-session.d.ts): the guard
  // exempts pi's own summarization calls on THAT, not on any text in the
  // payload (#145 round 2 — a marker in the prompt could be borrowed). It is
  // read through the holder so it is the flag of the session the request
  // belongs to, and `=== true` so a session without the getter exempts nothing.
  const guardTarget: { session?: { dispose(): void; isCompacting?: boolean } } = {};
  const guardDeps: ContractGuardDeps = {
    dispose: () => {
      try {
        guardTarget.session?.dispose();
      } catch {
        // the failed contract check is the error that matters
      }
    },
    exit: deps?.exit ?? ((code: number) => process.exit(code)),
    log: deps?.log ?? ((m: string) => console.error(m)),
  };
  const guard =
    contractBlock === undefined
      ? undefined
      : createContractGuardExtension({
          contract: contractBlock,
          deps: () => guardDeps,
          compacting: () => guardTarget.session?.isCompacting === true,
        });
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

    const modelRuntime =
      (input.modelRuntime as ModelRuntime | undefined) ??
      (await ModelRuntime.create({
        authPath: join(agentDir, "auth.json"),
        modelsPath: join(agentDir, "models.json"),
      }));
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager: isolatedSettings(),
      modelRuntime,
      resourceLoaderOptions: isolatedLoaderOptions(
        { ...config, ...(contractBlock !== undefined ? { contractBlock } : {}) },
        { ...(guard !== undefined ? { guard } : {}) },
      ),
    });
    // bob asked for these extensions explicitly: a declared capability whose
    // extension did not load is not an optional nicety.
    assertCapabilitiesLoaded(services.resourceLoader, config);
    // And so is the guard: an inline extension that pi failed to load would
    // leave every request unchecked while the session looked healthy.
    assertContractGuardLoaded(services.resourceLoader, guard);

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

    // The guard's dispose target AND its compaction flag source: the session is
    // now the thing a failed contract check must take down, and the thing whose
    // `isCompacting` says whether a request is pi's own summarization call.
    guardTarget.session = result.session as unknown as {
      dispose(): void;
      isCompacting?: boolean;
    };

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

    // After the mode binds extensions (a bindExtensions) and after EVERY
    // session.reload(): pi's TUI shows a reload error and carries on, so a
    // throw here would leave a running session whose policy no longer holds.
    // Dispose it and end the process with the named error instead. Wrapped on
    // the SESSION, not the loader: pi rebuilds the tool list after the loader's
    // reload returns, so a loader hook audits the state pi is about to replace.
    //
    // Round 5: a reload or a bind that THROWS is a failed audit too. The session
    // may be half-rebuilt and the mode stays open on it, so the original error
    // takes the same path (dispose + end the process, naming THAT error).
    // Round 6: a rejection value of `undefined` takes that same path too — the
    // wrapper tags the outcome, so no rejection value can read as success.
    const disposeSession = () => (result.session as unknown as { dispose(): void }).dispose();
    // Installing the audits can itself refuse (a pi without the entry points it
    // wraps); dispose the session the factory built before propagating, as the
    // creation audit above does.
    try {
      installSessionAudits(
        result.session as unknown as {
          reload(options?: unknown): Promise<void>;
          bindExtensions(bindings: unknown): Promise<void>;
        },
        (outcome) =>
          outcome.ok
            ? auditOrExit(runAudit, { dispose: disposeSession }, deps)
            : auditOrExit(
                () => {
                  throw outcome.error;
                },
                { dispose: disposeSession },
                deps,
                "the session could not be reloaded or bound",
              ),
      );
    } catch (err) {
      try {
        disposeSession();
      } catch {
        // the refusal is the error that matters
      }
      throw err;
    }

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
  const active = new Set(session.getActiveToolNames());
  const excluded = new Set(policy.excludeTools);
  // The other direction too: an ACTIVE tool outside the effective policy fails
  // the audit. pi's registry filter is what keeps the ceiling today; this makes
  // bob's audit a second line rather than a check that trusts it.
  const effective = new Set(allowed.filter((name) => !excluded.has(name)));
  const extra = [...active].filter((name) => !effective.has(name));
  if (extra.length > 0) {
    throw new Error(
      `bob: ${extra.length} active tool${extra.length === 1 ? "" : "s"} outside the effective policy: ${extra.join(", ")} (policy: ${[...effective].join(", ") || "no tools"}). The session is refused rather than run with more than its role allows.`,
    );
  }
  if (allowed.length === 0) return;
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
