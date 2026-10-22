- **Piper installs from a hash-pinned wheel set and a Python entry script.** RUNBOOK
  step 3 now installs `piper-tts==1.8.0` and its dependencies from
  `sidecar/reachy-voice/piper-requirements.txt` into `$PIPER_DIR/lib` with
  `--no-deps --only-binary=:all: --require-hashes`, and installs
  `sidecar/reachy-voice/piper-entry.py` as `$PIPER_DIR/piper`, root-owned 0644.
  The sidecar runs that entry under its own interpreter
  (`sys.executable -I <entry> --model M --output_file W`) from the speech
  file's directory, so no shebang names a host interpreter and the entry needs
  no executable bit. The release-host check compares the installed entry with
  the reviewed file, requires it root-owned, and requires the installed
  `piper-tts` version to be the pinned `1.8.0`. An existing host re-runs step 3.
