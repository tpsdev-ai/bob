- **The keyed transport's composed request and its services-refresh baseline are now checked.** A
  guard on the runtime's request verbs refuses a request pi composed for a keyed row under a
  different API flavour (pi picks the stream handler by the effective model's `api` before the
  registered transport runs, so a re-routed request never entered the transport's own check). And
  a runtime refresh during session creation updates the checked provider only while the
  re-composition still matches the row's registration (id, name, endpoint and composed models); a
  refresh that yields anything else is refused by the post-services check. Refs #307.
