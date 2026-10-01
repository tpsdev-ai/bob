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
// The consumers used to read `flags.x === true`, which was FALSE for the string
// "true" the `--key=value` form used to yield — so `--dry-run=true` silently
// skipped the dry-run branch and scaffolded + provisioned the Flair identity for
// real (`--no-flair=true` likewise registered). A declared boolean now reaches
// the consumers as a boolean, validated here. No looser coercion anywhere: the
// whitelist keeps every boolean consumer's "on" identical.
import { MAX_TIMER_MS } from "./run-bounds.js";

export class UsageError extends Error {}

export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "dry-run",
  "force",
  "no-interactive",
  "no-flair",
  "flair",
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

// A positive whole number of SECONDS, in milliseconds — within the runtime
// timer range (a larger delay is clamped to 1 ms by setTimeout). An ABSENT flag
// means "not given"; a bare (`--timeout`) or empty (`--timeout=`) flag, and any
// value that is not a positive whole number of seconds in range, is a
// UsageError naming the flag rather than a timer armed with a nonsense deadline.
// `parseArgs` runs the same check on EVERY occurrence of this flag, so a repeat
// cannot hide a bad earlier value (`--timeout= --timeout=10`).
export function secondsFlagToMs(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): number | undefined {
  const raw = valueFlag(flags, name);
  if (raw === undefined) return undefined;
  return secondsToMs(name, raw);
}

function secondsToMs(name: string, raw: string): number {
  if (!/^\d+$/.test(raw) || Number(raw) < 1) {
    throw new UsageError(`--${name} must be a positive whole number of seconds (got '${raw}')`);
  }
  const ms = Number(raw) * 1000;
  if (!Number.isSafeInteger(ms) || ms > MAX_TIMER_MS) {
    throw new UsageError(
      `--${name} must be at most ${Math.floor(MAX_TIMER_MS / 1000)} seconds (got '${raw}')`,
    );
  }
  return ms;
}

// The run-bound value flags whose value `parseArgs` validates on EVERY
// occurrence, before any command runs — the numeric siblings of BOOLEAN_FLAGS.
// A repeat must not hide an invalid earlier occurrence: `--timeout= --timeout=10`
// parsed as the valid 10s and armed a 10s timer. The readers validate the
// effective (last) value again.
const SECONDS_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "timeout",
  "no-progress-timeout",
  "turn-timeout",
]);

/** Validate ONE occurrence of a value flag, at parse time. Only the declared
 *  bound flags are checked here; every other value flag keeps its own reader's
 *  rule (a bare `--model` is "not given"). */
function validateValueOccurrence(name: string, value: string | true): void {
  if (!SECONDS_VALUE_FLAGS.has(name)) return;
  if (value === true || value === "") {
    throw new UsageError(
      `--${name} needs a value; ${value === true ? "it was given with none" : "it was given empty"}`,
    );
  }
  secondsToMs(name, value);
}

// The raw string of a value flag, or undefined when the flag is ABSENT. A bare
// flag (`true`) or the empty `--key=` form is a supplied-but-valueless flag: a
// UsageError, never silently "not given".
function valueFlag(
  flags: Readonly<Record<string, string | boolean>>,
  name: string,
): string | undefined {
  if (!(name in flags) || flags[name] === undefined) return undefined;
  const value = flags[name];
  if (typeof value !== "string" || value === "") {
    throw new UsageError(
      `--${name} needs a value; ${value === true ? "it was given with none" : "it was given empty"}`,
    );
  }
  return value;
}

// `parseArgs` produces the shape `cli.ts` consumes: the subcommand, the
// positional arguments, and the flag map. A value flag with a value (`--model x`,
// or the `--model=x` form) is the string value; a valueless one (`--model`
// alone, `--model` followed by another flag) is the boolean `true`, and the
// empty `--model=` form is the empty string — `stringFlag` reads both as "not
// given". A DECLARED boolean flag (BOOLEAN_FLAGS) is validated here, on every
// occurrence, and never consumes the next token; the declared bound flags
// (SECONDS_VALUE_FLAGS) are validated here on every occurrence too. `--` ends
// flag parsing and makes everything after it positional.
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
        if (BOOLEAN_FLAGS.has(key)) {
          flags[key] = boolValue(key, value);
        } else {
          validateValueOccurrence(key, value);
          flags[key] = value;
        }
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
          validateValueOccurrence(key, true);
          flags[key] = true;
        } else {
          validateValueOccurrence(key, next);
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
