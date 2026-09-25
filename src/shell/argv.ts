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
  return value !== undefined && value !== true ? String(value) : undefined;
}

// A `--key=value` flag that takes NO value, or only `=true` / `=false`.
//
// `parseArgs` yields the boolean `true` for the bare form (`--dry-run` alone,
// or `--dry-run` followed by another flag, or the `--dry-run=` empty-value
// form) and the STRING value for the `--key=value` form. The boolean
// consumers used to read that as `flags.x === true`, which is FALSE for the
// string "true" — so `--dry-run=true` silently skipped the dry-run branch
// and scaffolded + provisioned the Flair identity for real, the exact
// opposite of what the user asked (`--no-flair=true` likewise registered
// with Flair). `boolFlag` whitelists the accepted spellings instead:
//   * absent, or the bare form `parseArgs` yields as `true`  -> false / true
//   * `--flag=true` / `--flag=false`                         -> true / false
//   * any other string (`--flag=yes`, `--flag=1`, …)         -> UsageError
// No looser coercion (`String(v) === "true"`, truthiness of a non-empty
// string) — a whitelist keeps every boolean consumer's "on" identical.
export class UsageError extends Error {}

export function boolFlag(flags: Readonly<Record<string, string | boolean>>, name: string): boolean {
  const value = flags[name];
  if (value === undefined) return false;
  if (value === true) return true;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new UsageError(`--${name} takes no value, or =true / =false (got '${value}')`);
}

// `parseArgs` produces the shape `cli.ts` consumes: the subcommand, the
// positional arguments, and the flag map. A flag with a value (`--model x`,
// or the `--model=x` form) is the string value; a valueless flag
// (`--model` alone, `--model` followed by another flag, or the `--model=`
// empty-value form) is the boolean `true`, which `stringFlag` reads as
// "not given". `--` ends flag parsing and makes everything after it positional.
//
// The `--key=value` form is consumed in ONE token and NEVER takes the next
// token as its value: `bob run --model=foo ember "task"` keeps `ember` as the
// agent name and `task` as the prompt, instead of swallowing the name. An empty
// value (`--key=`) is a bare flag, exactly like `--key` alone.
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
        // the next token. `--key=` (empty value) is a bare flag.
        const value = tok.slice(eq + 1);
        flags[tok.slice(2, eq)] = value.length === 0 ? true : value;
      } else {
        // `--key` (no `=`): a trailing non-flag token is its value, else it is
        // the bare boolean form.
        const key = tok.slice(2);
        const next = rest[i + 1];
        if (!next || next.startsWith("--")) {
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
