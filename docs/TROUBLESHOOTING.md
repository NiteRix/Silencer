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

## Windows says "protected your PC", or your antivirus objects

Both are expected, and neither means something is wrong. Here is exactly why.

### SmartScreen: "Windows protected your PC"

Silencer's installer is not signed with a code-signing certificate. Those cost
money per year, and this is free software, so the installer has no publisher
identity and no download reputation. Windows shows the same dialog for every
unsigned installer on earth until enough people have run it.

To continue: **More info** then **Run anyway**.

If you would rather not click through that at all, use the **portable zip**
instead. It contains no installer executable, just the panel files and a `.bat`
that copies them, so SmartScreen has nothing to object to.

### Antivirus scanning, or flagging, the download

Two things to know:

**Silencer 1.0.1 and later no longer download anything during install.** The
earlier version fetched an ffmpeg archive and unpacked an executable into the
extension folder. That is the same shape as a malware dropper, so heuristic
scanners took an interest, and a real-time scan of the archive could stall the
installer for minutes with no output on screen. ffmpeg is now built into the
release, so nothing is fetched and nothing is unpacked.

**The bundled `bin/ffmpeg.exe` may still get scanned.** It is an unsigned
executable, so on-access scanning will look at it the first time it runs, which
can add a few seconds to your first analysis. That is the scanner doing its job.

If something is actually quarantined, it will be `bin\ffmpeg.exe`. You can:

- Restore it and add an exclusion for
  `%APPDATA%\Adobe\CEP\extensions\com.niterix.silencer`, or
- Delete it and let Silencer fall back to its built-in decoder, or
- Install ffmpeg separately with `winget install Gyan.FFmpeg`. Silencer finds
  a copy on your PATH automatically.

### Verifying what you downloaded

Every release publishes `SHA256SUMS.txt`. To check a download matches:

```powershell
Get-FileHash .\Silencer-1.0.1-Setup.exe -Algorithm SHA256
```

```bash
shasum -a 256 Silencer-1.0.1-portable.zip
```

All of the source is in this repository, and the installers are built by
GitHub Actions from it. The build log lists every file that went in.

## "Silencer's host script did not load"

The panel opened but ExtendScript did not. Close the panel, reopen it, and if
it persists, reinstall — usually `jsx/Silencer.jsx` failed to copy.

## "None of the audio could be decoded"

Chromium cannot decode your codec. Install ffmpeg and re-run the installer, or
put an `ffmpeg` binary in the extension's `bin/` folder. ProRes, DNxHD and
several `.mov` flavours always need it.

## "This file is N GB, which is too large to decode in the panel"

This means ffmpeg is missing, so the panel tried to read the whole file into
memory. With the bundled ffmpeg present it does not happen: ffmpeg streams, and
Silencer only decodes the slice of the file your timeline actually uses.

Check the **Details** section, which names the decoder it chose. If it says the
built-in decoder, see the antivirus section above; the likely cause is that
`bin\ffmpeg.exe` was quarantined or never installed.

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
