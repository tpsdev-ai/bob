// One transcription of pi's reference grammar, from pi's private
// dist/core/resolve-config-value.js. bob's stored-credential code uses it twice:
// provider-custody.ts collects the environment names a pi config value
// references (for the session scrub), and login.ts resolves the value without
// running a command (for the doctor check).

/** One part of a pi config value template: literal text, or an environment reference. */
export type PiConfigValuePart = { type: "literal"; value: string } | { type: "env"; name: string };

/**
 * A pi config value split the way pi splits it: a shell command (`!…`), or a
 * template of literals and environment references. A value that is not a string
 * — pi's own functions take a string, so this is bob's defensive case — yields
 * `undefined`.
 */
export type PiConfigValueReference =
  | { type: "command"; config: string }
  | { type: "template"; parts: readonly PiConfigValuePart[] };

const ENV_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENV_VAR_NAME_PREFIX_RE = /^[A-Za-z_][A-Za-z0-9_]*/;

function appendLiteral(parts: PiConfigValuePart[], value: string): void {
  if (value === "") return;
  const previous = parts[parts.length - 1];
  if (previous?.type === "literal") {
    previous.value += value;
    return;
  }
  parts.push({ type: "literal", value });
}

/** Parse a pi config value, or return `undefined` when it is not a string. */
export function parsePiConfigValueReference(config: unknown): PiConfigValueReference | undefined {
  if (typeof config !== "string") return undefined;
  if (config.startsWith("!")) return { type: "command", config };
  const parts: PiConfigValuePart[] = [];
  let index = 0;
  while (index < config.length) {
    const dollar = config.indexOf("$", index);
    if (dollar < 0) {
      appendLiteral(parts, config.slice(index));
      break;
    }
    appendLiteral(parts, config.slice(index, dollar));
    const next = config[dollar + 1];
    if (next === "$" || next === "!") {
      appendLiteral(parts, next);
      index = dollar + 2;
      continue;
    }
    if (next === "{") {
      const end = config.indexOf("}", dollar + 2);
      if (end < 0) {
        appendLiteral(parts, "$");
        index = dollar + 1;
        continue;
      }
      const name = config.slice(dollar + 2, end);
      if (ENV_VAR_NAME_RE.test(name)) parts.push({ type: "env", name });
      else appendLiteral(parts, config.slice(dollar, end + 1));
      index = end + 1;
      continue;
    }
    const match = config.slice(dollar + 1).match(ENV_VAR_NAME_PREFIX_RE);
    if (match !== null) {
      parts.push({ type: "env", name: match[0] });
      index = dollar + 1 + match[0].length;
      continue;
    }
    appendLiteral(parts, "$");
    index = dollar + 1;
  }
  return { type: "template", parts };
}
