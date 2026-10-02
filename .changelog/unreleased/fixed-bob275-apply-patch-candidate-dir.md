- **`apply_patch` refuses detected changes to the staging directory, source or
  destination.** A concurrent same-user writer can still race rename until
  builder confinement (bob#189); pathname checks cannot close that race.
  Storage failures after staging begins attempt cleanup.
