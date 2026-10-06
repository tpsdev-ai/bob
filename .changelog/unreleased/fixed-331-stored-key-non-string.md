- **A stored credential whose `key` is not a string references no environment
  names (bob#331).** `piConfigValueEnvVarNames` returns no names for a
  non-string `key` — a number, `null`, an object or an array — instead of
  calling a string method on it, so the session scrub treats a malformed entry
  as referencing nothing rather than failing before pi reads the store.
