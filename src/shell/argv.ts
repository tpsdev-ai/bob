// Reading a CLI flag's VALUE, in one place.
//
// `parseArgs` (cli.ts) hands a flag that carries no value — `--model` alone, or
// `--model` followed by another flag — as the boolean `true`, never as a string.
// Every path that reads such a flag has to decide what "no value" means, and the
// paths must agree on the answer:
//
//   * `bob run` (cli.ts run) and `bob install-service` already read `--model`
//     this way: a bare flag means "not given", so bob.yaml / the service unit's
//     own default applies;
//   * `bob align` reads `--provider` and `--model` the same way (#155).
//
// The alternative — `String(flags.model ?? default)` — turns a bare `--model`
// into the literal model id "true" (and a bare `--provider` into the provider
// "true"), a value nobody asked for that fails only once a session tries to use
// it. Hence one shared helper rather than three copies that can drift.
export function stringFlag(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): string | undefined {
  const value = flags[name];
  // A boolean is never a value, and the empty `--model=` form means "not given".
  return typeof value === "string" && value !== "" ? value : undefined;
}

// A boolean flag takes NO value, or only `=true` / `=false`.
//
// The boolean flags are DECLARED here, and `parseArgs` validates every
// occurrence of one as it is parsed — before any command runs — so a bad
// spelling can never reach a command, a repeat cannot hide an invalid earlier
// value, and a boolean flag never takes the token after it as its value
// (`bob onboard --dry-run testbot` keeps `testbot` as the name). The accepted
// spellings are a whitelist:
//   * absent                                   -> false
//   * bare (`--dry-run`)                       -> true
//   * `--dry-run=true` / `--dry-run=false`     -> true / false
//   * anything else — `--dry-run=yes`, `--dry-run=1`, an empty `--dry-run=`,
//     or the space form `--force false`        -> UsageError, naming the flag
// The consumers used to read `flags.x === true`, which is FALSE for the string
// "true" the `--key=value` form yields — so `--dry-run=true` silently skipped the
// dry-run branch and scaffolded + provisioned the Flair identity for real
// (`--no-flair=true` likewise registered). No looser coercion anywhere: the
// whitelist keeps every boolean consumer's "on" identical.
export class UsageError extends Error {}

export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "dry-run",
  "force",
  "no-interactive",
  "no-flair",
  "interactive",
]);

function boolValue(name: string, value: string): boolean {
  if (value === "true") return true;
  if (value === "false") return false;
  throw new UsageError(`--${name} takes no value, or =true / =false (got '${value}')`);
}

// Read a boolean flag. `parseArgs` has already validated every declared boolean,
// so this sees `true` / `false`; the string branches keep the same whitelist for
// a flag map built by hand (tests) and for a boolean not declared above.
export function boolFlag(flags: Readonly<Record<string, string | boolean>>, name: string): boolean {
  const value = flags[name];
  if (value === undefined) return false;
  if (typeof value === "boolean") return value;
  return boolValue(name, value);
}

// `parseArgs` produces the shape `cli.ts` consumes: the subcommand, the
// positional arguments, and the flag map. A value flag with a value (`--model x`,
// or the `--model=x` form) is the string value; a valueless one (`--model`
// alone, `--model` followed by another flag) is the boolean `true`, and the
// empty `--model=` form is the empty string — `stringFlag` reads both as "not
// given". A DECLARED boolean flag (BOOLEAN_FLAGS) is validated here, on every
// occurrence, and never consumes the next token. `--` ends flag parsing and
// makes everything after it positional.
//
// The `--key=value` form is consumed in ONE token and NEVER takes the next
// token as its value: `bob run --model=foo ember "task"` keeps `ember` as the
// agent name and `task` as the prompt, instead of swallowing the name.
export interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok === "--") {
      // Everything after `--` is positional. The generated launcher forwards
      // its own args this way (`bob launch <name> -- "$@"`), so a pi flag
      // cannot be swallowed as a bob flag.
      positional.push(...rest.slice(i + 1));
      break;
    }
    if (tok.startsWith("--")) {
      const eq = tok.indexOf("=");
      if (eq > 2) {
        // `--key=value`: the flag is `key` with `value`; it does NOT consume
        // the next token. A declared boolean accepts only `=true` / `=false`
        // (an empty `--dry-run=` is refused); a value flag keeps the string,
        // and the empty `--model=` form is "not given" for stringFlag.
        const key = tok.slice(2, eq);
        const value = tok.slice(eq + 1);
        flags[key] = BOOLEAN_FLAGS.has(key) ? boolValue(key, value) : value;
      } else {
        const key = tok.slice(2);
        const next = rest[i + 1];
        if (BOOLEAN_FLAGS.has(key)) {
          // A boolean flag never takes the next token as its value: the bare
          // form is `true`, and `bob onboard --dry-run testbot` keeps `testbot`.
          // A space-form `true`/`false` after it is refused rather than left as a
          // stray positional that would silently mean "on".
          if (next === "true" || next === "false") {
            throw new UsageError(`--${key} takes its value only as --${key}=${next}`);
          }
          flags[key] = true;
        } else if (!next || next.startsWith("--")) {
          // `--key` (no `=`): a trailing non-flag token is its value, else it is
          // the bare form.
          flags[key] = true;
        } else {
          flags[key] = next;
          i++;
        }
      }
    } else {
      positional.push(tok);
    }
  }
  return { command, positional, flags };
}
