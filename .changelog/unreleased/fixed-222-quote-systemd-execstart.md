- **systemd unit files now quote and escape every `ExecStart` argument (bob#222).**
  The renderer refuses an argument containing CR, LF or NUL, double-quotes every argument (escaping `\` and `"`), and doubles `%` and `$` so systemd passes them literally.
