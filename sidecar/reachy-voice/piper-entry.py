# SPDX-FileCopyrightText: tpsdev-ai
# SPDX-License-Identifier: GPL-3.0-or-later
"""The Piper entry script installed as $PIPER_DIR/piper (reachy-voice, V1).

It stands in for the Piper binary: the sidecar runs it under its own pinned
interpreter, with the text to speak on stdin, as

    python3 -I <this file> --model MODEL --output_file OUTPUT

It accepts exactly that argv shape, with absolute paths in both values. It puts
the piper-tts install in <this file's real directory>/lib first on sys.path,
changes to the output file's directory (piper's CLI reads Path.cwd() at startup,
and the seatbelt profile lets it read the work directory), and calls piper-tts's
CLI with -m MODEL -f OUTPUT. Its exit status is Piper's, or 2 when it refuses
the arguments.

This file is GPL-3.0-or-later because it imports piper-tts. bob's npm package
does not include sidecar/, so it does not ship in the package.
"""

import os
import sys


def main(argv):
    if len(argv) != 4 or argv[0] != "--model" or argv[2] != "--output_file":
        sys.stderr.write("usage: piper --model MODEL --output_file OUTPUT\n")
        return 2
    model, output = argv[1], argv[3]
    if not os.path.isabs(model) or not os.path.isabs(output):
        sys.stderr.write("piper: --model and --output_file must be absolute paths\n")
        return 2
    directory = os.path.dirname(os.path.realpath(__file__))
    sys.path.insert(0, os.path.join(directory, "lib"))
    os.chdir(os.path.dirname(os.path.abspath(output)))
    from piper.__main__ import main as piper_main

    sys.argv = ["piper", "-m", model, "-f", output]
    piper_main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
