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
