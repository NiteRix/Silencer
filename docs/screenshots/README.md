# Screenshots

These are renders of the real panel — `extension/index.html` with its actual
CSS and all six of its scripts — driven by `scripts/make-screenshots.mjs`.
Only the CEP bridge is stubbed, so the waveform, the region detection and
every number on screen are genuine output from `analyzer.js` decoding a real
wav file.

Regenerate them with:

```bash
npm i playwright-core
python3 scripts/make-fixture-wav.py /tmp/fixture.wav
CHROMIUM_PATH=/path/to/chrome node scripts/make-screenshots.mjs /tmp/fixture.wav
```

| File | State |
|---|---|
| `0-panel.png` | The whole panel, analysed, settings open |
| `1-ready.png` | Freshly opened against a sequence |
| `2-analyzed.png` | After **Analyze silence** |
| `3-settings.png` | Detection settings, manual threshold |
| `4-after-cut.png` | After **Cut the silence**, with the log open |

The stub runs outside CEP, so Node.js is absent and the log says so. Inside
Premiere that line is replaced by whether ffmpeg was found.
