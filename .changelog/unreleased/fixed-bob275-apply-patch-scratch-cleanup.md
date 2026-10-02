- **`apply_patch` leaves no scratch behind, on success or refusal (bob#221 leak
  check).** Each call gets a fresh index directory under the tool-owned state
  root, removed before the call returns, so no scratch entry outlives it; the
  candidate record is the only entry it leaves there. The production-path test
  points `TMPDIR` at its own scratch directory, as the `run` production test
  does, so the capability's default state root is not left in the shared temp
  directory.
