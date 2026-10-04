// task-binding (bob#275, S2a): the launcher-supplied binding is parsed and
// validated strictly, so a malformed one is refused by name and never read as a
// valid authority.

import { describe, expect, it } from "bun:test";
import {
  parseTaskBinding,
  TASK_BINDING_ENV,
  TaskBindingError,
} from "../../../src/capabilities/work/task-binding.js";

const BASE = "a".repeat(40);
const TREE = "b".repeat(40);
const DIGEST = "c".repeat(64);
const REPO = "github.com/tpsdev-ai/bob";

function good(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    task_id: "t1",
    publication_id: "p1",
    repository: "/repo",
    workspace: "/ws",
    base_oid: BASE,
    mode: "build",
    artifact_root: "/art",
    declared_paths: ["src/a.ts"],
    check_commands: ["bun test"],
    destination: { remote: "origin", ref: "refs/heads/main" },
    ...over,
  });
}

describe("parseTaskBinding", () => {
  it("returns undefined for absent or empty input (no task)", () => {
    expect(parseTaskBinding(undefined)).toBeUndefined();
    expect(parseTaskBinding(null)).toBeUndefined();
    expect(parseTaskBinding("")).toBeUndefined();
    expect(parseTaskBinding("   ")).toBeUndefined();
  });

  it("parses a build binding", () => {
    const b = parseTaskBinding(good());
    expect(b?.task_id).toBe("t1");
    expect(b?.mode).toBe("build");
    expect(b?.base_oid).toBe(BASE);
    expect(b?.destination).toEqual({ remote: "origin", ref: "refs/heads/main" });
    expect(b?.declared_paths).toEqual(["src/a.ts"]);
    expect(b?.patch_sha256).toBeUndefined();
  });

  it("requires the pinned digest and expected tree in apply mode", () => {
    expect(() => parseTaskBinding(good({ mode: "apply" }))).toThrow(TaskBindingError);
    const b = parseTaskBinding(
      good({ mode: "apply", patch_sha256: DIGEST, expected_tree_oid: TREE }),
    );
    expect(b?.patch_sha256).toBe(DIGEST);
    expect(b?.expected_tree_oid).toBe(TREE);
  });

  it("carries an optional PR destination", () => {
    const b = parseTaskBinding(good({ pr: { base: "main", head: "feat" } }));
    expect(b?.pr).toEqual({ base: "main", head: "feat" });
  });

  it("refuses a non-JSON body", () => {
    expect(() => parseTaskBinding("not json")).toThrow(/not valid JSON/);
  });

  it("refuses a missing or ill-typed required field, naming it", () => {
    for (const [over, what] of [
      [{ task_id: "" }, "task_id"],
      [{ base_oid: "short" }, "base_oid must be 40 lowercase hex"],
      [{ mode: "publish" }, 'mode must be "build" or "apply"'],
      [{ destination: "origin" }, "destination must be an object"],
      [{ destination: { remote: "origin" } }, "destination.ref"],
      [{ declared_paths: "src" }, "declared_paths must be an array"],
      [{ check_commands: [1] }, "check_commands must hold only non-empty strings"],
    ] as Array<[Record<string, unknown>, string]>) {
      expect(() => parseTaskBinding(good(over))).toThrow(new RegExp(what));
      expect(() => parseTaskBinding(good(over))).toThrow(TaskBindingError);
    }
  });

  it("names its environment variable", () => {
    expect(TASK_BINDING_ENV).toBe("BOB_TASK_BINDING");
  });

  it("carries an optional canonical pr_ref", () => {
    const b = parseTaskBinding(good({ pr_ref: { repository: REPO, number: 185 } }));
    expect(b?.pr_ref).toEqual({ repository: REPO, number: 185 });
    expect(parseTaskBinding(good())?.pr_ref).toBeUndefined();
  });

  it("refuses a non-canonical or ill-typed pr_ref, naming it", () => {
    for (const [ref, what] of [
      [{ repository: "https://github.com/tpsdev-ai/bob", number: 1 }, "canonical"],
      [{ repository: "github.com/tpsdev-ai/bob/", number: 1 }, "empty segment"],
      [{ repository: "github.com/../bob", number: 1 }, ".."],
      [{ repository: "GitHub.com/tpsdev-ai/bob", number: 1 }, "canonical"],
      [{ repository: REPO, number: 0 }, "positive safe integer"],
      [{ repository: REPO, number: -1 }, "positive safe integer"],
      [{ repository: REPO, number: 1.5 }, "positive safe integer"],
      [{ repository: REPO }, "pr_ref.number"],
      ["github.com/tpsdev-ai/bob", "pr_ref must be an object"],
    ] as Array<[unknown, string]>) {
      expect(() => parseTaskBinding(good({ pr_ref: ref }))).toThrow(new RegExp(what));
      expect(() => parseTaskBinding(good({ pr_ref: ref }))).toThrow(TaskBindingError);
    }
  });
});

it("refuses unbounded repositories and malformed host labels", () => {
  for (const repository of [
    `github.com/o/${"r".repeat(17000)}`,
    "github..com/o/r",
    "github.-com/o/r",
    "github.com-/o/r",
    `${"a".repeat(64)}.com/o/r`,
  ])
    expect(() => parseTaskBinding(good({ pr_ref: { repository, number: 1 } }))).toThrow(
      TaskBindingError,
    );
});
