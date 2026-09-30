// bob#244 (web spec v3, slice R1a): data classes and the web composition rule,
// as pure units. The real-session proofs (creation, bind, reload) are in
// web-composition-session.test.ts; the policy rows are in web-policy.test.ts.
import { describe, expect, it } from "bun:test";
import { Type } from "typebox";
import type { CatalogEntry } from "../../src/shell/capability.js";
import { BLESSED_CATALOG, lookupCapability } from "../../src/shell/capability-catalog.js";
import { resolveCapabilities } from "../../src/shell/capability-loader.js";
import {
  BOB_EXTENSION_DATA_CLASS,
  BOB_INJECTION_DATA_CLASS,
  BUILTIN_TOOL_DATA_CLASS,
  type CompositionView,
  capabilityDataClass,
  configCompositionView,
  gatedNoteInjection,
  holdsWeb,
  restoredHistoryEntries,
  STARTUP_CONTEXT_CLASS,
  sessionCompositionView,
  WEB_SESSION_CWD,
  WEB_SESSION_SYSTEM_PROMPT,
  WebCompositionError,
  webCompositionProblems,
  webSessionSystemPrompt,
} from "../../src/shell/data-class.js";
import { PI_BUILTIN_TOOLS } from "../../src/shell/tool-allowlist.js";

// The reviewed classification (spec v3 R1): public = fixture, presence (imports
// no context), web; everything else private, the planned `mail` included.
const EXPECTED_CLASSES: Record<string, "public" | "private"> = {
  fixture: "public",
  presence: "public",
  web: "public",
  flair: "private",
  discord: "private",
  "anchored-edit": "private",
  work: "private",
  reachy: "private",
  observatory: "private",
  "tps-mail": "private",
  mail: "private",
};

const PRIVATE_CAPABILITIES = Object.keys(EXPECTED_CLASSES).filter(
  (name) => EXPECTED_CLASSES[name] === "private",
);

function view(partial: Partial<CompositionView>): CompositionView {
  return { extensions: [], tools: [], startup: [], restoredHistory: 0, ...partial };
}

const WEB = { kind: "capability" as const, name: "web", source: "/cap/web" };
const FIXTURE = { kind: "capability" as const, name: "fixture", source: "/cap/fixture" };

describe("classification completeness", () => {
  it("every shipped capability's manifest states its dataClass, built and planned alike", () => {
    const missing = Object.entries(BLESSED_CATALOG)
      .filter(([, entry]) => {
        const cls = entry.manifest.provides?.dataClass;
        return cls !== "public" && cls !== "private";
      })
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it("pins the reviewed class of every capability, and every capability is in the table", () => {
    const actual = Object.fromEntries(
      Object.entries(BLESSED_CATALOG).map(([name, entry]) => [
        name,
        entry.manifest.provides?.dataClass,
      ]),
    );
    expect(actual).toEqual(EXPECTED_CLASSES);
  });

  it("a missing classification means PRIVATE, never public", () => {
    const unclassified: CatalogEntry = {
      manifest: {
        name: "unclassified",
        piPackage: "@tpsdev-ai/bob/capabilities/unclassified",
        configSchema: Type.Object({}),
        provides: { tools: [], serves: false },
      },
    };
    const lookup = (name: string) => (name === "unclassified" ? unclassified : undefined);
    expect(capabilityDataClass("unclassified", lookup)).toBe("private");
    // A name the catalog does not know, and no name at all, are private too.
    expect(capabilityDataClass("nonesuch")).toBe("private");
    expect(capabilityDataClass(undefined)).toBe("private");
    // And the explicit classes read back as declared.
    expect(capabilityDataClass("web")).toBe("public");
    expect(capabilityDataClass("flair")).toBe("private");
  });

  it("every pi built-in has a row, and every row is private (the private-data built-ins)", () => {
    expect(Object.keys(BUILTIN_TOOL_DATA_CLASS).sort()).toEqual([...PI_BUILTIN_TOOLS].sort());
    for (const name of PI_BUILTIN_TOOLS) {
      expect({ name, cls: BUILTIN_TOOL_DATA_CLASS[name] }).toEqual({ name, cls: "private" });
    }
  });

  it("pins bob's own extension, startup-context and injection rows", () => {
    expect({ ...BOB_EXTENSION_DATA_CLASS }).toEqual({
      "bob-contract-guard": "public",
      "bob-write-soul": "private",
    });
    expect({ ...STARTUP_CONTEXT_CLASS }).toEqual({
      soul: "private",
      "standing-contract": "private",
      "task-contract": "admitted-prompt",
      "web-system-prompt": "public",
    });
    expect({ ...BOB_INJECTION_DATA_CLASS }).toEqual({ "compaction-note": "private" });
  });
});

describe("the web composition rule", () => {
  it("does not apply to a session that holds no web, however private it is", () => {
    const v = view({
      extensions: [{ kind: "capability", name: "flair", source: "/cap/flair" }],
      tools: [{ name: "read", sources: ["builtin"] }],
      startup: [{ kind: "classified", source: "soul" }],
      restoredHistory: 7,
    });
    expect(holdsWeb(v)).toBe(false);
    expect(webCompositionProblems(v)).toEqual([]);
  });

  it("accepts a web session that holds only public-class capabilities and the admitted task", () => {
    const v = view({
      extensions: [WEB, FIXTURE, { kind: "bob", name: "bob-contract-guard" }],
      tools: [{ name: "bob_fixture_noop", sources: [FIXTURE] }],
      startup: [{ kind: "classified", source: "task-contract" }],
    });
    expect(holdsWeb(v)).toBe(true);
    expect(webCompositionProblems(v)).toEqual([]);
  });

  it.each(PRIVATE_CAPABILITIES)("refuses web composed with the private capability %s", (name) => {
    const problems = webCompositionProblems(
      view({ extensions: [WEB, { kind: "capability", name, source: `/cap/${name}` }] }),
    );
    expect(problems).toEqual([`capability "${name}" is private-class`]);
  });

  it("refuses an extension bob cannot attribute to a capability (unclassified = private)", () => {
    expect(
      webCompositionProblems(
        view({ extensions: [WEB, { kind: "capability", source: "/x/ext.js" }] }),
      ),
    ).toEqual(["an extension bob cannot attribute to a capability (/x/ext.js) is private-class"]);
  });

  it("classifies bob's own extensions by row: the guard is public, write_soul and unknown ones are not", () => {
    expect(
      webCompositionProblems(
        view({ extensions: [WEB, { kind: "bob", name: "bob-contract-guard" }] }),
      ),
    ).toEqual([]);
    expect(
      webCompositionProblems(view({ extensions: [WEB, { kind: "bob", name: "bob-write-soul" }] })),
    ).toEqual([`bob's own extension "bob-write-soul" is private-class`]);
    expect(
      webCompositionProblems(view({ extensions: [WEB, { kind: "bob", name: "something-new" }] })),
    ).toEqual([`bob's own extension "something-new" is private-class`]);
  });

  it.each([...PI_BUILTIN_TOOLS])("refuses web with pi's built-in tool %s", (name) => {
    expect(
      webCompositionProblems(view({ extensions: [WEB], tools: [{ name, sources: ["builtin"] }] })),
    ).toEqual([`pi's built-in tool "${name}" reads or writes local data`]);
  });

  it("refuses a tool with no classifiable source, and a tool from a private capability", () => {
    expect(
      webCompositionProblems(
        view({ extensions: [WEB], tools: [{ name: "mystery", sources: [] }] }),
      ),
    ).toEqual([`tool "mystery" has no source bob can classify`]);
    expect(
      webCompositionProblems(
        view({
          extensions: [WEB],
          tools: [
            {
              name: "flair_search",
              sources: [{ kind: "capability", name: "flair", source: "/cap/flair" }],
            },
          ],
        }),
      ),
    ).toEqual([`tool "flair_search" comes from capability "flair", which is private-class`]);
  });

  it("an egress tool alone makes the session a web session", () => {
    const v = view({
      extensions: [{ kind: "capability", name: "flair", source: "/cap/flair" }],
      tools: [{ name: "web_fetch", sources: [WEB] }],
    });
    expect(holdsWeb(v)).toBe(true);
    expect(webCompositionProblems(v)).toEqual([`capability "flair" is private-class`]);
  });

  it("refuses private and unclassified startup context, and accepts the admitted task", () => {
    expect(
      webCompositionProblems(
        view({ extensions: [WEB], startup: [{ kind: "classified", source: "soul" }] }),
      ),
    ).toEqual([`startup context "soul" is private`]);
    expect(
      webCompositionProblems(
        view({ extensions: [WEB], startup: [{ kind: "classified", source: "standing-contract" }] }),
      ),
    ).toEqual([`startup context "standing-contract" is private`]);
    expect(
      webCompositionProblems(
        view({ extensions: [WEB], startup: [{ kind: "unclassified", what: 'skill "x"' }] }),
      ),
    ).toEqual([`unclassified startup context: skill "x"`]);
    expect(
      webCompositionProblems(
        view({ extensions: [WEB], startup: [{ kind: "classified", source: "task-contract" }] }),
      ),
    ).toEqual([]);
  });

  it("refuses restored history, and a history source that changed after creation", () => {
    expect(webCompositionProblems(view({ extensions: [WEB], restoredHistory: 1 }))).toHaveLength(1);
    expect(webCompositionProblems(view({ extensions: [WEB], restoredHistory: 1 }))[0]).toContain(
      "restores 1 history entry",
    );
    expect(webCompositionProblems(view({ extensions: [WEB], historySourceChanged: true }))).toEqual(
      [
        "the session's history source changed after it was created, so its history is not the one bob checked",
      ],
    );
  });

  it("a composition refusal names every composition problem, the public set and that there is no override", () => {
    const err = (() => {
      try {
        throw new WebCompositionError(["one", "two"]);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(err.message).toContain("2 problems");
    expect(err.message).toContain("  - one");
    expect(err.message).toContain("fixture, presence, web");
    expect(err.message).toContain("there is no override");
  });
});

describe("the rule at YAML load (resolveCapabilities)", () => {
  // The REAL catalog's manifests (so the real dataClass rows), with a
  // permissive config schema and a stub source, so every capability can be
  // composed with web without its own config block or build output.
  const permissive = (name: string): CatalogEntry | undefined => {
    const entry = lookupCapability(name);
    if (!entry) return undefined;
    return {
      manifest: {
        ...entry.manifest,
        configSchema: Type.Object({}, { additionalProperties: true }),
      },
    };
  };
  const resolve = (names: string[], only?: string[]) =>
    resolveCapabilities({
      yamlText: `capabilities:\n${names.map((n) => `  - ${n}`).join("\n")}\n`,
      lookup: permissive,
      resolveSource: (capability) => `/stub/${capability}/index.js`,
      ...(only !== undefined ? { only } : {}),
    });

  it.each(PRIVATE_CAPABILITIES)("refuses web + %s, naming it", (name) => {
    expect(() => resolve(["web", name])).toThrow(`capability "${name}" is private-class`);
  });

  it("accepts web with the public capabilities, and any set without web", () => {
    expect(resolve(["web", "fixture", "presence"]).capabilities.map((c) => c.name)).toEqual([
      "web",
      "fixture",
      "presence",
    ]);
    expect(resolve(["flair", "discord"]).capabilities).toHaveLength(2);
  });

  it("judges the set that LOADS: a private capability the `only` filter drops composes nothing", () => {
    expect(resolve(["web", "flair"], ["web"]).capabilities.map((c) => c.name)).toEqual(["web"]);
  });

  it("refuses web + flair through the real catalog and schemas too", () => {
    const yaml = [
      "capabilities:",
      "  - web",
      "  - flair",
      "",
      "flair:",
      "  url: http://127.0.0.1:9",
      "  agentId: testbot",
      "  keyFile: /dev/null",
      "",
    ].join("\n");
    expect(() => resolveCapabilities({ yamlText: yaml })).toThrow(WebCompositionError);
  });
});

describe("the config view (what the factory is about to compose)", () => {
  it("attributes each allowed tool to pi or to its catalog capability, skipping excluded names", () => {
    const v = configCompositionView({
      extensionSources: ["/cap/web"],
      capabilityBySource: { "/cap/web": "web" },
      tools: ["read", "flair_search", "web_fetch", "write_soul", "bash"],
      excludeTools: ["bash"],
    });
    expect(v.extensions).toEqual([{ kind: "capability", name: "web", source: "/cap/web" }]);
    expect(v.tools).toEqual([
      { name: "read", sources: ["builtin"] },
      { name: "flair_search", sources: [{ kind: "capability", name: "flair", source: "flair" }] },
      { name: "web_fetch", sources: [{ kind: "capability", name: "web", source: "web" }] },
      // bob's setup-only tool has no catalog source: unclassified.
      { name: "write_soul", sources: [] },
    ]);
  });

  it("reads the soul, the standing contract and the task contract as startup context", () => {
    const base = { extensionSources: [], tools: [] };
    expect(configCompositionView({ ...base, appendSystemPrompt: "" }).startup).toEqual([]);
    expect(configCompositionView({ ...base, appendSystemPrompt: " " }).startup).toEqual([
      { kind: "classified", source: "soul" },
    ]);
    expect(
      configCompositionView({ ...base, standingContract: "duty", taskContract: "task" }).startup,
    ).toEqual([
      { kind: "classified", source: "standing-contract" },
      { kind: "classified", source: "task-contract" },
    ]);
  });

  it("an unmapped source is unattributed, so it cannot make or break web by name", () => {
    const v = configCompositionView({ extensionSources: ["/x/web/index.js"], tools: [] });
    expect(v.extensions).toEqual([
      { kind: "capability", name: undefined, source: "/x/web/index.js" },
    ]);
    expect(holdsWeb(v)).toBe(false);
  });
});

describe("the session view (what pi composed)", () => {
  const loader = (over: Record<string, unknown> = {}) => ({
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSkills: () => ({ skills: [] }),
    getPrompts: () => ({ prompts: [] }),
    getSystemPrompt: () => undefined,
    getAppendSystemPrompt: () => [] as string[],
    ...over,
  });
  const base = {
    extensions: [
      { path: "/cap/web/index.js", tools: new Map() },
      { path: "<inline:bob-contract-guard>", tools: new Map() },
    ],
    activeTools: [] as string[],
    capabilityBySource: { "/cap/web/index.js": "web" },
    soul: "",
    // What pi assembles when every input is the reviewed one.
    assembledSystemPrompt: webSessionSystemPrompt(),
    restoredHistory: 0,
  };

  it("attributes inline extensions to bob, and matches the appended entries to their rows", () => {
    const v = sessionCompositionView({
      ...base,
      soul: "I am a soul",
      contractBlock: "TASK: fetch",
      contractSource: "task-contract",
      assembledSystemPrompt: webSessionSystemPrompt(["TASK: fetch"]),
      loader: loader({ getAppendSystemPrompt: () => ["I am a soul", "TASK: fetch", "stranger"] }),
    });
    expect(v.extensions).toEqual([
      { kind: "capability", name: "web", source: "/cap/web/index.js" },
      { kind: "bob", name: "bob-contract-guard" },
    ]);
    expect(v.startup).toEqual([
      { kind: "classified", source: "soul" },
      { kind: "classified", source: "task-contract" },
      { kind: "unclassified", what: "an appended system prompt entry bob did not compose" },
    ]);
  });

  it("reports context files, skills, prompt templates and a custom system prompt as unclassified", () => {
    const v = sessionCompositionView({
      ...base,
      loader: loader({
        getAgentsFiles: () => ({ agentsFiles: [{ path: "/w/AGENTS.md" }] }),
        getSkills: () => ({ skills: [{ name: "s", filePath: "/k/SKILL.md" }] }),
        getPrompts: () => ({ prompts: [{ name: "p", filePath: "/p.md" }] }),
        getSystemPrompt: () => "custom",
      }),
    });
    expect(v.startup.map((s) => (s.kind === "unclassified" ? s.what : s.source))).toEqual([
      "context file /w/AGENTS.md",
      'skill "s" (/k/SKILL.md)',
      'prompt template "p" (/p.md)',
      "a custom system prompt",
    ]);
    expect(webCompositionProblems(v)).toHaveLength(4);
  });

  it("a loader getter it cannot call is reported, never skipped", () => {
    const v = sessionCompositionView({ ...base, loader: {} });
    expect(v.startup).toHaveLength(5);
    expect(v.startup.every((s) => s.kind === "unclassified")).toBe(true);
  });

  it("attributes an active tool to pi and to every extension that registers it", () => {
    const v = sessionCompositionView({
      ...base,
      extensions: [
        ...base.extensions,
        { path: "/cap/fixture/index.js", tools: new Map([["bob_fixture_noop", {}]]) },
      ],
      capabilityBySource: { ...base.capabilityBySource, "/cap/fixture/index.js": "fixture" },
      activeTools: ["bob_fixture_noop", "read"],
      loader: loader(),
    });
    expect(v.tools).toEqual([
      {
        name: "bob_fixture_noop",
        sources: [{ kind: "capability", name: "fixture", source: "/cap/fixture/index.js" }],
      },
      { name: "read", sources: ["builtin"] },
    ]);
    expect(webCompositionProblems(v)).toEqual([
      `pi's built-in tool "read" reads or writes local data`,
    ]);
  });
});

describe("the system prompt a web session sends", () => {
  const loader = (systemPrompt: string | undefined, append: string[] = []) => ({
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSkills: () => ({ skills: [] }),
    getPrompts: () => ({ prompts: [] }),
    getSystemPrompt: () => systemPrompt,
    getAppendSystemPrompt: () => append,
  });
  const web = {
    extensions: [{ path: "/cap/web/index.js", tools: new Map() }],
    activeTools: [] as string[],
    capabilityBySource: { "/cap/web/index.js": "web" },
    soul: "",
    restoredHistory: 0,
  };

  it("is bob's reviewed prompt, the appended entries and pi's working-directory line naming /", () => {
    expect(WEB_SESSION_CWD).toBe("/");
    expect(webSessionSystemPrompt()).toBe(
      `${WEB_SESSION_SYSTEM_PROMPT}\nCurrent working directory: /\n`,
    );
    expect(webSessionSystemPrompt(["TASK: a", "B"])).toBe(
      `${WEB_SESSION_SYSTEM_PROMPT}\n\nTASK: a\n\nB\nCurrent working directory: /\n`,
    );
  });

  it("classifies the loader's reviewed prompt, and accepts the assembled prompt that matches", () => {
    const v = sessionCompositionView({
      ...web,
      contractBlock: "TASK: fetch",
      contractSource: "task-contract",
      assembledSystemPrompt: webSessionSystemPrompt(["TASK: fetch"]),
      loader: loader(WEB_SESSION_SYSTEM_PROMPT, ["TASK: fetch"]),
    });
    expect(v.startup).toEqual([
      { kind: "classified", source: "web-system-prompt" },
      { kind: "classified", source: "task-contract" },
    ]);
    expect(webCompositionProblems(v)).toEqual([]);
  });

  it("refuses an assembled prompt that is not the reviewed one, naming where, without quoting it", () => {
    const leaked = `${WEB_SESSION_SYSTEM_PROMPT}\nCurrent working directory: /home/someone/agents/x/work\n`;
    const v = sessionCompositionView({
      ...web,
      assembledSystemPrompt: leaked,
      loader: loader(WEB_SESSION_SYSTEM_PROMPT),
    });
    const problems = webCompositionProblems(v);
    expect(problems).toEqual([
      "unclassified startup context: the system prompt pi assembled is not the reviewed web prompt (it differs at line 4 of 5)",
    ]);
    expect(problems.join("\n")).not.toContain("/home/someone");
  });

  it("refuses when the assembled prompt cannot be read", () => {
    const v = sessionCompositionView({ ...web, loader: loader(WEB_SESSION_SYSTEM_PROMPT) });
    expect(webCompositionProblems(v)).toEqual([
      "unclassified startup context: the system prompt pi assembled could not be read",
    ]);
  });
});

describe("history and bob's own note", () => {
  it("counts a session manager's entries, and refuses one it cannot read", () => {
    expect(restoredHistoryEntries({ getEntries: () => [1, 2, 3] })).toBe(3);
    expect(restoredHistoryEntries({ getEntries: () => [] })).toBe(0);
    expect(() => restoredHistoryEntries({})).toThrow(WebCompositionError);
    expect(() => restoredHistoryEntries(undefined)).toThrow(/history cannot be read/);
  });

  it("refuses the compaction note in a web session and sends it anywhere else", () => {
    const sent: string[] = [];
    const send = (text: string) => {
      sent.push(text);
    };
    const web = {
      extensionSources: ["/cap/web"],
      capabilityBySource: { "/cap/web": "web" },
      tools: [],
    };
    expect(() => gatedNoteInjection(web, "compaction-note", send)("WHAT REMAINS")).toThrow(
      /not sending the compaction-note into a web session/,
    );
    expect(sent).toEqual([]);
    // An allowed egress tool makes it a web session too.
    const egress = { extensionSources: [], tools: ["web_fetch"] };
    expect(() => gatedNoteInjection(egress, "compaction-note", send)("x")).toThrow();
    // Not a web session: the note goes out unchanged.
    gatedNoteInjection(
      { extensionSources: [], tools: [] },
      "compaction-note",
      send,
    )("WHAT REMAINS");
    expect(sent).toEqual(["WHAT REMAINS"]);
  });
});
