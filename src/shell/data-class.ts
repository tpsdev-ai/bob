// Data classes, and the interim rule that keeps private data out of a web
// session (bob#244; web spec v3, slice R1a).
//
// WHY. `web` carries model-influenced data to hosts outside the office: a
// fetched URL's host, path and query, and later a search query the model
// writes. A navigation rule can constrain WHICH URLs are fetched; it cannot
// constrain what rides in them. Until bob can attribute every input of a
// session to its source and gate each call on it (the participation ledger,
// spec R3), the only sound bound is that a session holding web holds NOTHING
// private. This module is that bound. It has no operator escape.
//
// THE CLASSES.
//   public   a reviewed claim that everything the input brings is public.
//   private  everything else — including everything UNCLASSIFIED: a capability
//            whose manifest states no `provides.dataClass`, a name the catalog
//            does not know, an extension bob cannot attribute, a tool with no
//            known source, startup context or history bob has no row for.
//            Missing classification means private, never public.
//
// THE RULE. A session is a WEB session when it composes the `web` capability,
// or when an egress tool (TOOL_EFFECTS) is allowed or active in it. A web
// session is refused unless ALL of these hold:
//   * every capability extension it loads is public-class (fixture, presence,
//     web today), and every bob-owned extension has a public row below;
//   * every tool it allows or holds comes from a public-class source: no pi
//     built-in (each reads or writes local data — the private-data built-ins),
//     no tool whose source bob cannot name;
//   * its startup context is classified and not private: no soul, no standing
//     contract, no context file, skill, prompt template or custom system prompt
//     (see STARTUP_CONTEXT_CLASS);
//   * it restores no history: a session that ever held a private capability,
//     or any history bob cannot attribute, never becomes a web session;
//   * bob injects no private note into it (BOB_INJECTION_DATA_CLASS).
//
// WHERE IT RUNS. At YAML load (capability-loader.ts: the declared capability
// set), and in the one session factory (session.ts): before anything is built
// (the config view), then on what pi actually composed at creation, after the
// mode binds extensions and after every reload (the session view). An
// extension's own injections (a `before_agent_start` message, a system prompt
// override) take its extension's class, and only public-class extensions load
// into a web session.

import type { CatalogEntry, DataClass } from "./capability.js";
import { BLESSED_CATALOG, lookupCapability } from "./capability-catalog.js";
import { capabilityForTool, PI_BUILTIN_TOOLS, TOOL_EFFECTS } from "./tool-allowlist.js";

export type { DataClass } from "./capability.js";

export const WEB_CAPABILITY = "web";

type Lookup = (name: string) => CatalogEntry | undefined;

// A capability's class: its manifest's `provides.dataClass`, and PRIVATE for
// anything else — a missing class, an unknown name, no name at all.
export function capabilityDataClass(
  name: string | undefined,
  lookup: Lookup = lookupCapability,
): DataClass {
  if (name === undefined) return "private";
  return lookup(name)?.manifest.provides?.dataClass === "public" ? "public" : "private";
}

// The public-class capabilities of the blessed catalog (for messages and docs).
export function publicCapabilities(): string[] {
  return Object.keys(BLESSED_CATALOG).filter((name) => capabilityDataClass(name) === "public");
}

// pi's built-in tools, one reviewed row each (the private-data built-ins). Every
// one of them reaches the local filesystem or runs a local command, so none can
// sit in a session that also sends data out.
export const BUILTIN_TOOL_DATA_CLASS = Object.freeze({
  read: "private", // returns the bytes of a local file
  bash: "private", // runs a command whose output can carry any local data
  edit: "private", // edits a local file; its result quotes the file
  write: "private", // writes a local file; its result reports on local paths
  grep: "private", // returns matching lines of local files
  find: "private", // lists local paths
  ls: "private", // lists a local directory
  powershell: "private", // runs a command (Windows)
} as const satisfies Record<(typeof PI_BUILTIN_TOOLS)[number], DataClass>);

function builtinDataClass(name: string): DataClass {
  return (BUILTIN_TOOL_DATA_CLASS as Readonly<Record<string, DataClass>>)[name] === "public"
    ? "public"
    : "private";
}

// bob's own inline extensions (pi names them `<inline:NAME>`), one row each. A
// name without a row is private.
export const BOB_EXTENSION_DATA_CLASS: Readonly<Record<string, DataClass>> = Object.freeze({
  // #145's contract guard reads each outgoing request to check the contract is
  // in it. It registers no tool and adds nothing to the context.
  "bob-contract-guard": "public",
  // bob#204's setup-only `write_soul`: it holds and rewrites the agent's soul.
  "bob-write-soul": "private",
});

// The startup context bob's factory composes into a session, one reviewed row
// per source. `admitted-prompt` is the one-shot task: it IS the admitted
// prompt, carried in the system prompt as well as in the first message (#145),
// so it adds nothing beyond the prompt the session is admitted with. Which
// prompts may reach web is the admission's rule (spec R1c, R3), not this one.
export type StartupContextSource = "soul" | "standing-contract" | "task-contract";
export type StartupContextClass = DataClass | "admitted-prompt";

export const STARTUP_CONTEXT_CLASS: Readonly<Record<StartupContextSource, StartupContextClass>> =
  Object.freeze({
    // soul.md, appended to the system prompt: an operator-written persona the
    // hiring interview refines. Nothing attributes what it holds.
    soul: "private",
    // The persistent runtime's standing contract: bob.yaml's agent name and
    // role, and every cron duty's prompt.
    "standing-contract": "private",
    "task-contract": "admitted-prompt",
  });

// The notes bob itself injects into a running session, one reviewed row each.
export type BobInjection = "compaction-note";

export const BOB_INJECTION_DATA_CLASS: Readonly<Record<BobInjection, DataClass>> = Object.freeze({
  // #145's "what remains" note after a compaction: the last assistant text,
  // the workspace's `git status --short` and the recent tool names.
  "compaction-note": "private",
});

// ── the composition view ───────────────────────────────────────────────────

// One source of extensions/tools in a session.
export type SourceRef =
  // A declared capability's extension. `name` is undefined when bob cannot
  // attribute the extension to a capability (then it is private).
  | { kind: "capability"; name?: string; source: string }
  // One of bob's own inline extensions.
  | { kind: "bob"; name: string };

export interface ToolRef {
  name: string;
  // Every source that provides the name; "builtin" is pi's own tool.
  sources: Array<"builtin" | SourceRef>;
}

export type StartupRef =
  | { kind: "classified"; source: StartupContextSource }
  | { kind: "unclassified"; what: string };

// Everything the rule reads, in one shape. Two adapters build it: from the
// config the factory is about to compose, and from the session pi composed.
export interface CompositionView {
  extensions: SourceRef[];
  tools: ToolRef[];
  startup: StartupRef[];
  // History this session did not produce itself: restored, resumed, forked or
  // imported entries, counted before the session is built.
  restoredHistory: number;
  // True when the session's history source is no longer the one counted at
  // creation: whatever it holds, bob cannot attribute it.
  historySourceChanged?: boolean;
}

// Whether the session holds web: the capability, or any egress tool.
export function holdsWeb(view: Pick<CompositionView, "extensions" | "tools">): boolean {
  return (
    view.extensions.some((e) => e.kind === "capability" && e.name === WEB_CAPABILITY) ||
    view.tools.some((t) => TOOL_EFFECTS[t.name] === "egress")
  );
}

function sourceDataClass(ref: SourceRef, lookup: Lookup): DataClass {
  if (ref.kind === "bob")
    return BOB_EXTENSION_DATA_CLASS[ref.name] === "public" ? "public" : "private";
  return capabilityDataClass(ref.name, lookup);
}

function describeSource(ref: SourceRef): string {
  if (ref.kind === "bob") return `bob's own extension "${ref.name}"`;
  return ref.name === undefined
    ? `an extension bob cannot attribute to a capability (${ref.source})`
    : `capability "${ref.name}"`;
}

// Every way the view breaks the rule, one line each. Empty when the session
// holds no web, or holds web and nothing private.
export function webCompositionProblems(
  view: CompositionView,
  lookup: Lookup = lookupCapability,
): string[] {
  if (!holdsWeb(view)) return [];
  const problems: string[] = [];
  for (const ext of view.extensions) {
    if (sourceDataClass(ext, lookup) !== "public") {
      problems.push(`${describeSource(ext)} is private-class`);
    }
  }
  for (const tool of view.tools) {
    if (tool.sources.length === 0) {
      problems.push(`tool "${tool.name}" has no source bob can classify`);
      continue;
    }
    for (const source of tool.sources) {
      if (source === "builtin") {
        if (builtinDataClass(tool.name) !== "public") {
          problems.push(`pi's built-in tool "${tool.name}" reads or writes local data`);
        }
      } else if (sourceDataClass(source, lookup) !== "public") {
        problems.push(
          `tool "${tool.name}" comes from ${describeSource(source)}, which is private-class`,
        );
      }
    }
  }
  for (const item of view.startup) {
    if (item.kind === "unclassified") {
      problems.push(`unclassified startup context: ${item.what}`);
      continue;
    }
    const cls = (STARTUP_CONTEXT_CLASS as Readonly<Record<string, StartupContextClass>>)[
      item.source
    ];
    if (cls === undefined) problems.push(`unclassified startup context: ${item.source}`);
    else if (cls === "private") problems.push(`startup context "${item.source}" is private`);
  }
  if (view.restoredHistory > 0) {
    problems.push(
      `the session restores ${view.restoredHistory} history entr${view.restoredHistory === 1 ? "y" : "ies"} bob cannot attribute (history that once held a private capability, or any history, stays out of a web session)`,
    );
  }
  if (view.historySourceChanged === true) {
    problems.push(
      "the session's history source changed after it was created, so its history is not the one bob checked",
    );
  }
  return problems;
}

export class WebCompositionError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(
      [
        `bob: refusing a web session that would hold private data (${problems.length} problem${problems.length === 1 ? "" : "s"}):`,
        ...problems.map((p) => `  - ${p}`),
        "",
        `Until bob can attribute every input of a session (web spec R3), a session that holds the web capability may hold only public-class capabilities (${publicCapabilities().join(", ")}), no pi built-in tool, no soul.md content or standing contract, and no restored history. Remove web from capabilities:, or remove the rest; there is no override.`,
      ].join("\n"),
    );
    this.name = "WebCompositionError";
    this.problems = problems;
  }
}

export function assertWebComposition(
  view: CompositionView,
  lookup: Lookup = lookupCapability,
): void {
  const problems = webCompositionProblems(view, lookup);
  if (problems.length > 0) throw new WebCompositionError(problems);
}

// ── adapters ───────────────────────────────────────────────────────────────

// The view of a bare capability list (YAML load, before anything else exists).
export function capabilityListView(names: readonly string[]): CompositionView {
  return {
    extensions: names.map((name) => ({ kind: "capability" as const, name, source: name })),
    tools: [],
    startup: [],
    restoredHistory: 0,
  };
}

export interface ConfigViewInput {
  extensionSources: readonly string[];
  capabilityBySource?: Readonly<Record<string, string>>;
  // The effective policy: allowed minus excluded is what the session holds.
  tools: readonly string[];
  excludeTools?: readonly string[];
  appendSystemPrompt?: string;
  taskContract?: string;
  standingContract?: string;
  restoredHistory?: number;
}

// The view of what the factory is ABOUT to compose.
export function configCompositionView(input: ConfigViewInput): CompositionView {
  const excluded = new Set(input.excludeTools ?? []);
  const builtins = new Set<string>(PI_BUILTIN_TOOLS);
  const startup: StartupRef[] = [];
  // The factory appends soul.md exactly when it is non-empty (session.ts
  // isolatedLoaderOptions), so the same test decides whether it is present.
  if ((input.appendSystemPrompt ?? "").length > 0)
    startup.push({ kind: "classified", source: "soul" });
  if (input.standingContract !== undefined) {
    startup.push({ kind: "classified", source: "standing-contract" });
  }
  if (input.taskContract !== undefined)
    startup.push({ kind: "classified", source: "task-contract" });
  return {
    extensions: input.extensionSources.map((source) => ({
      kind: "capability" as const,
      name: input.capabilityBySource?.[source],
      source,
    })),
    tools: input.tools
      .filter((name) => !excluded.has(name))
      .map((name) => {
        const sources: ToolRef["sources"] = [];
        if (builtins.has(name)) sources.push("builtin");
        const capability = capabilityForTool(name);
        if (capability !== undefined)
          sources.push({ kind: "capability", name: capability, source: capability });
        return { name, sources };
      }),
    startup,
    restoredHistory: input.restoredHistory ?? 0,
  };
}

// Whether a session config holds web (the capability, or an allowed egress
// tool) — for the paths that only have the config, such as bob's note injection.
export function configHoldsWeb(
  input: Pick<
    ConfigViewInput,
    "extensionSources" | "capabilityBySource" | "tools" | "excludeTools"
  >,
): boolean {
  return holdsWeb(configCompositionView(input));
}

// How many history entries a session manager already holds. A web session may
// restore none, so a manager whose entries cannot be read is refused rather
// than read as empty.
export function restoredHistoryEntries(sessionManager: unknown): number {
  const sm = sessionManager as { getEntries?: () => unknown[] } | undefined;
  if (typeof sm?.getEntries !== "function") {
    throw new WebCompositionError([
      "the session's history cannot be read, so bob cannot show it holds none",
    ]);
  }
  return sm.getEntries().length;
}

// What the session view needs from pi's resource loader. Every getter is
// optional so a missing one is REPORTED (as unclassified startup context bob
// could not read), never skipped.
export interface StartupSource {
  getAgentsFiles?(): { agentsFiles: Array<{ path: string }> };
  getSkills?(): { skills: Array<{ name: string; filePath?: string }> };
  getPrompts?(): { prompts: Array<{ name: string; filePath?: string }> };
  getSystemPrompt?(): string | undefined;
  getAppendSystemPrompt?(): string[];
}

export interface SessionViewInput {
  // The extensions pi loaded (resource loader getExtensions().extensions).
  extensions: ReadonlyArray<{ path: string; tools: ReadonlyMap<string, unknown> }>;
  // The tools active in the session.
  activeTools: readonly string[];
  capabilityBySource?: Readonly<Record<string, string>>;
  loader: StartupSource;
  // What bob appended, so each appended entry can be matched to its row.
  soul: string;
  contractBlock?: string;
  contractSource?: "task-contract" | "standing-contract";
  restoredHistory: number;
  historySourceChanged?: boolean;
}

function refOfExtension(
  path: string,
  capabilityBySource: Readonly<Record<string, string>> | undefined,
): SourceRef {
  const inline = /^<inline:(.*)>$/.exec(path);
  if (inline) return { kind: "bob", name: inline[1] };
  return { kind: "capability", name: capabilityBySource?.[path], source: path };
}

// The part of the session view that decides whether it holds web at all:
// cheap, and all a non-web session is ever asked for.
export function sessionWebSurface(
  input: Pick<SessionViewInput, "extensions" | "activeTools" | "capabilityBySource">,
): Pick<CompositionView, "extensions" | "tools"> {
  const builtins = new Set<string>(PI_BUILTIN_TOOLS);
  return {
    extensions: input.extensions.map((e) => refOfExtension(e.path, input.capabilityBySource)),
    tools: input.activeTools.map((name) => {
      const sources: ToolRef["sources"] = [];
      if (builtins.has(name)) sources.push("builtin");
      for (const ext of input.extensions) {
        if (ext.tools.has(name)) sources.push(refOfExtension(ext.path, input.capabilityBySource));
      }
      return { name, sources };
    }),
  };
}

// The view of what pi actually composed. Built only for a session that holds
// web (sessionWebSurface decides), so a non-web session's loader is never read.
export function sessionCompositionView(input: SessionViewInput): CompositionView {
  const surface = sessionWebSurface(input);
  const startup: StartupRef[] = [];
  const { loader } = input;

  if (typeof loader.getAgentsFiles !== "function") {
    startup.push({ kind: "unclassified", what: "the context files could not be read" });
  } else {
    for (const f of loader.getAgentsFiles().agentsFiles) {
      startup.push({ kind: "unclassified", what: `context file ${f.path}` });
    }
  }
  if (typeof loader.getSkills !== "function") {
    startup.push({ kind: "unclassified", what: "the skills could not be read" });
  } else {
    for (const s of loader.getSkills().skills) {
      startup.push({
        kind: "unclassified",
        what: `skill "${s.name}"${s.filePath ? ` (${s.filePath})` : ""}`,
      });
    }
  }
  if (typeof loader.getPrompts !== "function") {
    startup.push({ kind: "unclassified", what: "the prompt templates could not be read" });
  } else {
    for (const p of loader.getPrompts().prompts) {
      startup.push({
        kind: "unclassified",
        what: `prompt template "${p.name}"${p.filePath ? ` (${p.filePath})` : ""}`,
      });
    }
  }
  if (typeof loader.getSystemPrompt !== "function") {
    startup.push({ kind: "unclassified", what: "the system prompt could not be read" });
  } else {
    // bob passes an empty system prompt source, so pi builds its own base
    // prompt; any custom system prompt is not bob's.
    const custom = loader.getSystemPrompt();
    if (custom !== undefined && custom !== "") {
      startup.push({ kind: "unclassified", what: "a custom system prompt" });
    }
  }
  if (typeof loader.getAppendSystemPrompt !== "function") {
    startup.push({ kind: "unclassified", what: "the appended system prompt could not be read" });
  } else {
    for (const entry of loader.getAppendSystemPrompt()) {
      if (input.soul.length > 0 && entry === input.soul) {
        startup.push({ kind: "classified", source: "soul" });
      } else if (
        input.contractBlock !== undefined &&
        input.contractSource !== undefined &&
        entry === input.contractBlock
      ) {
        startup.push({ kind: "classified", source: input.contractSource });
      } else {
        startup.push({
          kind: "unclassified",
          what: "an appended system prompt entry bob did not compose",
        });
      }
    }
  }
  return {
    ...surface,
    startup,
    restoredHistory: input.restoredHistory,
    ...(input.historySourceChanged === true ? { historySourceChanged: true } : {}),
  };
}

// bob#244: the injector for one of bob's own notes. In a web session a note
// whose row is not public is refused — the caller's best-effort path logs the
// refusal and carries on — and in any other session it is sent unchanged.
export function gatedNoteInjection<T>(
  config: Pick<
    ConfigViewInput,
    "extensionSources" | "capabilityBySource" | "tools" | "excludeTools"
  >,
  note: BobInjection,
  send: (text: string) => T,
): (text: string) => T {
  if (BOB_INJECTION_DATA_CLASS[note] === "public" || !configHoldsWeb(config)) return send;
  return () => {
    throw new Error(
      `bob: not sending the ${note} into a web session — it carries private data (${note}: ${BOB_INJECTION_DATA_CLASS[note]}), and a web session holds nothing private`,
    );
  };
}
