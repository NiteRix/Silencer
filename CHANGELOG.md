# Changelog

## 1.0.1

Fixes the install hang and the antivirus warnings.

### ffmpeg is bundled, nothing is downloaded

1.0.0 fetched a 185 MB archive during install and unpacked an executable into
the extension folder. That is the shape of a dropper, so heuristic antivirus
took an interest, and a real-time scan could stall the installer for minutes
with nothing on screen. The installer also described the download as "about
30 MB", which was wrong by 6x, and had no timeout to fail on.

Windows releases now carry ffmpeg inside them. It is a purpose-built binary:
`--disable-everything` plus only the audio demuxers, audio decoders and raw-PCM
muxer that Silencer's single ffmpeg command uses, with libavutil's double and
fixed-point transforms removed. 7 MB against upstream's 127 MB, LGPL v2.1,
verified to decode AAC, MP3, FLAC, ALAC, AC3, Opus, Vorbis, WMA, PCM in MOV
and MKV, H.264/AAC MP4 and ProRes MOV bit-identically to a full build.

### The panel can no longer trap you

- **Cancel button.** Analysis was uninterruptible; the only way out of a slow
  or wedged decode was closing the panel. Cancel now stops the chain and kills
  any ffmpeg still running.
- **Real progress.** The bar sat at 0% for the whole of a single large file.
  It now reads ffmpeg's own progress and shows a per-file percentage.
- **Stall detection.** A decode that goes 90 seconds without progress is killed
  and reported, instead of hanging forever.
- **Only the used range is decoded.** A four-hour rush with ninety seconds on
  the timeline now costs ninety seconds of work rather than four hours.

### Also

- Documented SmartScreen and antivirus behaviour, and what to do about each.
- Releases publish `SHA256SUMS.txt`.
- "Ignore blips shorter than N ms" now means N ms. The 20 ms RMS window made
  every burst measure about one hop longer than it was.
- Fixed checkbox rows in Detection settings losing their layout.

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
