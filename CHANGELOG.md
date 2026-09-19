# Changelog

## 1.0.0

First release.

- Silence detection from the timeline's own audio: every source file is
  decoded to a 10 ms loudness envelope and mapped into sequence time, so
  overlapping clips, in/out points and clip speed are all accounted for.
- Automatic threshold picked from the timeline's loudness distribution, with a
  manual override.
- Tunable minimum silence length, padding around speech, blip rejection, and
  head/tail trimming; the waveform preview updates as the sliders move.
- Cuts across every video and audio track at once, closing the gaps without
  losing sync.
- Duplicates the sequence into a backup bin before touching anything.
- Markers-only mode for checking settings without editing.
- Optional ffmpeg support for ProRes, DNxHD and other codecs Chromium cannot
  decode.
- One-click installers for Windows and macOS, plus an Inno Setup `.exe` built
  in CI.
