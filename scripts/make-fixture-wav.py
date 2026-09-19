#!/usr/bin/env python3
"""
Generates the audio fixture used for the documentation screenshots: a mono wav
of speech-like bursts separated by room tone. Nothing recognisable is said -
it is filtered noise with syllable-rate amplitude modulation, which measures
like speech as far as the detector is concerned.

    python3 scripts/make-fixture-wav.py /tmp/fixture.wav
"""
import math
import os
import random
import struct
import sys
import wave

SR = 44100
DUR = 42.0
SPEECH = [(1.8, 7.2), (9.4, 15.8), (16.45, 22.0), (25.8, 33.0), (34.2, 40.0)]


def build():
    random.seed(7)
    n = int(DUR * SR)
    buf = [(random.random() * 2 - 1) * 0.0008 for _ in range(n)]   # ~-62 dBFS room tone

    for start, end in SPEECH:
        ia, ib = int(start * SR), min(int(end * SR), n)
        prev = 0.0
        phase = random.random() * 6.28
        for i in range(ia, ib):
            t = (i - ia) / SR
            syllables = 0.5 + 0.5 * math.sin(2 * math.pi * 4.1 * t + phase)
            phrase = 0.55 + 0.45 * math.sin(2 * math.pi * 0.23 * t)
            env = (syllables ** 1.7) * phrase
            if (t % 1.37) < 0.06:            # the gap between words
                env *= 0.12
            edge = min(1.0, (i - ia) / (0.02 * SR), (ib - i) / (0.02 * SR))
            prev = prev * 0.72 + (random.random() * 2 - 1) * 0.28    # one-pole lowpass
            buf[i] += prev * 0.62 * env * edge

    peak = max(abs(v) for v in buf)
    scale = 0.82 / peak
    return b''.join(struct.pack('<h', int(max(-1.0, min(1.0, v * scale)) * 32767)) for v in buf)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'fixture.wav'
    with wave.open(out, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(build())
    print(f'{out}  {os.path.getsize(out)} bytes  {DUR:.0f}s')


if __name__ == '__main__':
    main()
