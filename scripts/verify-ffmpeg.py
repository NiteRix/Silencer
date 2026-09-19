#!/usr/bin/env python3
"""
Checks that the stripped-down ffmpeg Silencer ships decodes the same audio as a
full build.

The bundled binary is configured with --disable-everything and a source change
that removes two of libavutil's three transform implementations. If that went
wrong, the failure mode is not a crash - it is a silence detector quietly
reading the wrong loudness, which is the worst kind of bug this project can
have. So: encode one fixture into every format an edit bay produces, decode it
both ways with the exact command line Silencer issues, and compare envelopes.

    python3 scripts/make-fixture-wav.py /tmp/fixture.wav
    python3 scripts/verify-ffmpeg.py ffmpeg-out/ffmpeg /tmp/fixture.wav

Needs a full ffmpeg on PATH to produce the fixtures and act as reference.
"""
import math
import os
import struct
import subprocess
import sys
import tempfile

REFERENCE = os.environ.get("REFERENCE_FFMPEG", "ffmpeg")

ENCODINGS = [
    ("aac.m4a",            ["-c:a", "aac", "-b:a", "192k"]),
    ("alac.m4a",           ["-c:a", "alac"]),
    ("audio.ac3",          ["-c:a", "ac3", "-b:a", "192k"]),
    ("audio.asf",          ["-c:a", "wmav2", "-b:a", "192k"]),
    ("audio.flac",         ["-c:a", "flac"]),
    ("audio.mp3",          ["-c:a", "libmp3lame", "-b:a", "192k"]),
    ("audio.ogg",          ["-c:a", "libvorbis", "-q:a", "5"]),
    ("audio.opus",         ["-c:a", "libopus", "-b:a", "128k"]),
    ("pcm16.mkv",          ["-c:a", "pcm_s16le"]),
    ("pcm24.mov",          ["-c:a", "pcm_s24le"]),
]

# Real video containers, which is what actually lands on a timeline.
VIDEO = [
    ("video_h264_aac.mp4", ["-c:v", "libx264", "-preset", "ultrafast",
                            "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "160k"]),
    ("video_prores.mov",   ["-c:v", "prores_ks", "-profile:v", "0", "-c:a", "pcm_s16le"]),
]


def decode(binary, path, out):
    """Exactly what extension/js/env.js runs."""
    cmd = [binary, "-hide_banner", "-nostdin", "-v", "error", "-i", path,
           "-vn", "-sn", "-dn", "-map", "0:a:0", "-ac", "1", "-ar", "8000",
           "-f", "f32le", "-nostats", "-y", out]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        return None, r.stderr.strip()[:200]
    with open(out, "rb") as fh:
        data = fh.read()
    n = len(data) // 4
    return struct.unpack("<%df" % n, data[:n * 4]), None


def envelope(samples, hop=80):
    out = []
    for i in range(0, len(samples) - hop, hop):
        window = samples[i:i + hop]
        rms = math.sqrt(sum(v * v for v in window) / len(window))
        out.append(20 * math.log10(rms) if rms > 1e-9 else -120.0)
    return out


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    minimal, fixture = sys.argv[1], sys.argv[2]

    work = tempfile.mkdtemp(prefix="silencer-verify-")
    quiet = ["-v", "error", "-y"]

    for name, args in ENCODINGS:
        subprocess.run([REFERENCE] + quiet + ["-i", fixture] + args
                       + [os.path.join(work, name)], check=True)
    for name, args in VIDEO:
        subprocess.run([REFERENCE] + quiet
                       + ["-f", "lavfi", "-i", "testsrc=size=320x240:rate=25:duration=42",
                          "-i", fixture] + args + ["-shortest", os.path.join(work, name)],
                       check=True)

    print("%-24s %9s  %12s  verdict" % ("file", "samples", "mean dB diff"))
    print("-" * 66)

    failures = 0
    for name, _ in ENCODINGS + VIDEO:
        path = os.path.join(work, name)
        mine, err = decode(minimal, path, path + ".a.f32")
        theirs, _ = decode(REFERENCE, path, path + ".b.f32")
        if mine is None:
            print("%-24s %9s  %12s  FAILED: %s" % (name, "-", "-", err))
            failures += 1
            continue
        if theirs is None:
            print("%-24s %9s  %12s  (reference failed, skipped)" % (name, "-", "-"))
            continue

        a, b = envelope(mine), envelope(theirs)
        n = min(len(a), len(b))
        # Compare where there is signal; digital silence differs harmlessly.
        pairs = [(x, y) for x, y in zip(a[:n], b[:n]) if x > -80 or y > -80]
        if not pairs:
            print("%-24s %9d  %12s  EMPTY" % (name, len(mine), "-"))
            failures += 1
            continue
        diff = sum(abs(x - y) for x, y in pairs) / len(pairs)
        length = abs(len(mine) - len(theirs)) / max(len(mine), len(theirs))
        ok = diff < 1.5 and length < 0.02
        failures += 0 if ok else 1
        print("%-24s %9d  %12.3f  %s" % (name, len(mine), diff, "ok" if ok else "MISMATCH"))

    print()
    print("failures:", failures)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
