- **Without `--force`, `bob onboard` refuses instead of writing over an agent directory or scaffold file that appears before bob creates it (#322).**
  The agent directory is created with a non-recursive `mkdir`, and `soul.md`, `bob.yaml`, the pi files
  and the launcher are each written to a temp file and published with `link(2)`, which fails on an
  existing entry; bob refuses with the path and does not replace the entry. A check of the agent
  directory that fails with anything but ENOENT stops the command. With `--force`, `soul.md`,
  `bob.yaml`, the launcher and a non-keyed row's pi files are written over as before.
