# A stand-in for Piper (bob#356 tests): reads the text on stdin, writes a short
# silent WAV to --output_file, prints nothing. The test installs it with a
# shebang naming the resolved interpreter, so the sandbox's exec rules apply to
# it exactly as to a real Piper binary under TTS_DIR.
import sys
import wave

args = sys.argv[1:]
out = args[args.index("--output_file") + 1]
text = sys.stdin.buffer.read().decode("utf-8")
with open(out, "r+b") as fh:  # the sidecar pre-created it 0600: never re-create
    fh.truncate(0)
    with wave.open(fh, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b"\x00\x00" * (160 * max(1, len(text))))
