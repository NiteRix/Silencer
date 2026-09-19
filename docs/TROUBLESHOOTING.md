# Troubleshooting

## The panel is not in the Extensions menu

Work through these in order.

**1. Did you restart Premiere?** CEP only scans for extensions at launch.

**2. Are the files where Premiere looks for them?**

- Windows: `%APPDATA%\Adobe\CEP\extensions\com.niterix.silencer\CSXS\manifest.xml`
- macOS: `~/Library/Application Support/Adobe/CEP/extensions/com.niterix.silencer/CSXS/manifest.xml`

If that file is missing, the install did not land. Re-run the installer.

**3. Is debug mode set?** Silencer is not signed with an Adobe certificate, so
CEP refuses to load it unless this is on. The installers set it, but it can be
reverted by Creative Cloud updates.

Windows — check, then set:

```bat
reg query "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode
reg add "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /t REG_SZ /d 1 /f
```

macOS:

```bash
defaults read com.adobe.CSXS.11 PlayerDebugMode
defaults write com.adobe.CSXS.11 PlayerDebugMode 1
killall cfprefsd
```

Newer Premiere releases use CEP 12; older ones 9 or 10. Setting all of
`CSXS.9` through `CSXS.12` costs nothing.

## "Silencer's host script did not load"

The panel opened but ExtendScript did not. Close the panel, reopen it, and if
it persists, reinstall — usually `jsx/Silencer.jsx` failed to copy.

## "None of the audio could be decoded"

Chromium cannot decode your codec. Install ffmpeg and re-run the installer, or
put an `ffmpeg` binary in the extension's `bin/` folder. ProRes, DNxHD and
several `.mov` flavours always need it.

## "This file is N GB, which is too large to decode in the panel"

Same fix — ffmpeg streams instead of loading the whole file into memory.

## Cuts were skipped

The panel reports `N skipped` when Premiere would not split a clip at a cut
point. Transitions are almost always the cause: a cross-dissolve sitting on a
silence boundary cannot be razored.

Silencer drops the whole region in that case rather than applying half of it,
because a half-applied region is how timelines go out of sync. Remove the
transitions, cut, then put them back.

## "Unlock these tracks first"

A locked track cannot be edited, so it would stay put while every other track
moved left. Unlock everything and run again.

## "This version of Premiere cannot move clips from a script"

Cutting needs `TrackItem.move()`, which arrived in Premiere Pro 14.0 (2020).
On 13.x, use **Mark it instead** and cut by hand at the markers.

## Something went wrong mid-cut

Open the **Silencer Backups** bin in your project and double-click the backup
sequence. It is a copy of the timeline as it was immediately before the run.

## Debugging the panel itself

The panel ships with remote debugging on port 8721. With Premiere running and
the panel open, visit <http://localhost:8721> in Chrome for a full DevTools
session — console, network, the lot.

The **Details** section in the panel itself carries the same log, including
which decoder was chosen and anything ExtendScript reported.
