# Changelog

## 1.1.0

Fixes three problems an editor reported, and adds presets.

**Presets.** Four buttons above **Analyze**: *Natural* for podcasts and
interviews, *Balanced* for talking-head videos, *Tight* for Shorts, Reels and
TikTok, and *Dead air* to take out long stretches of nothing and leave normal
pauses alone. Each sets the timing in one click. Move a slider afterwards and
the panel shows *Custom*. Your old settings carry over and are matched to a
preset if they line up with one.

**Picture no longer drifts away from separately recorded sound.** Premiere
does not document whether moving a clip from a script also moves the audio
linked to it. 1.0 assumed it did not. If it does, the camera's own audio got
moved twice, and from the second cut on, the picture slid further and further
out of sync with any audio that is not linked to it, such as a lav or a
separate mic synced by hand. Every clip's destination is now worked out once,
before anything moves, so a clip that was carried along with its partner is
simply left where it landed. Sync holds either way.

**Picture and sound stay linked.** Splitting tracks one at a time could leave
the pieces of a camera clip unlinked, so clicking the picture no longer
selected its audio. After cutting, picture and sound that come from the same
file and cover the same frames are linked again. Nothing else gets linked.

**No more one-frame leftovers.** Two causes, both fixed:

- A silence that ended a frame or two short of one of your own edits left
  that frame of the shot behind, flashing between two jumps. Cuts now snap
  onto a nearby existing edit.
- Speech between two silences that was only a frame or two long was kept.
  It now goes with the cut.

*Never leave a piece shorter than N frames* in Detection settings controls
both. The default is 4.

**Cuts follow each word.** A single loudness line clipped the quiet parts of
words: a soft first syllable, a trailing "s", a sentence that fades out.
Speech is now traced down to where it actually ends, up to 10 dB below the
threshold and for up to a quarter of a second. Room noise sits well below
that and is left alone. Turn it off with *Follow quiet word endings*.

Under the hood:

- All cutting is done in whole frames using Premiere's exact frame length, so
  29.97 and 23.976 sequences no longer pick up rounding drift. The panel's
  preview and the cut use the same planning code, so the waveform shows
  exactly what will be cut.
- A clip that landed a fraction of a frame off target could be moved a second
  time. Each clip now moves once.
- A silent piece that was lifted out along with its linked partner is no
  longer reported as "could not be deleted".
- New tests run the real cutting code against a simulated Premiere timeline:
  linked and unlinked clips, a separate mic, 29.97, and both possible
  answers to the move question. The old code fails four of them; this release
  passes all of them.

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
