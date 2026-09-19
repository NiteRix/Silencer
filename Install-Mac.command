#!/bin/bash
#
# Silencer installer for macOS.
# Copies the panel into Premiere's user extension folder and tells CEP that
# unsigned extensions may load. No admin rights required.
#
# Flags: --ffmpeg / --no-ffmpeg / --silent

set -u

EXT_ID="com.niterix.silencer"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXT_ID"
FF_CHOICE="ask"
SILENT=0

for arg in "$@"; do
  case "$arg" in
    --ffmpeg)    FF_CHOICE="yes" ;;
    --no-ffmpeg) FF_CHOICE="no" ;;
    --silent)    SILENT=1 ;;
  esac
done
[ "$SILENT" = "1" ] && [ "$FF_CHOICE" = "ask" ] && FF_CHOICE="no"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo
echo "  ==========================================="
echo "    Silencer for Premiere Pro"
echo "  ==========================================="
echo

# --- locate the payload ------------------------------------------------------
SRC=""
for candidate in "$HERE/extension" "$HERE/../../extension" "$HERE/../extension"; do
  if [ -f "$candidate/CSXS/manifest.xml" ]; then
    SRC="$(cd "$candidate" && pwd)"
    break
  fi
done

if [ -z "$SRC" ]; then
  echo "  [X] Could not find the \"extension\" folder next to this installer."
  echo "      Keep Install-Mac.command in the same folder as \"extension\"."
  [ "$SILENT" = "0" ] && read -r -p "  Press return to close." _
  exit 1
fi

if pgrep -x "Adobe Premiere Pro" >/dev/null 2>&1; then
  echo "  [!] Premiere Pro is open. The panel appears after you restart it."
  echo
fi

# --- copy --------------------------------------------------------------------
echo "  Installing to:"
echo "    $DEST"
echo

rm -rf "$DEST"
mkdir -p "$DEST"
if ! cp -R "$SRC/." "$DEST/"; then
  echo "  [X] Copy failed."
  [ "$SILENT" = "0" ] && read -r -p "  Press return to close." _
  exit 1
fi
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true
echo "  [ok] Panel files copied."

# --- allow unsigned extensions ----------------------------------------------
for v in 6 7 8 9 10 11 12; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1 2>/dev/null || true
done
killall cfprefsd >/dev/null 2>&1 || true
echo "  [ok] Unsigned extensions enabled for CEP 6-12."

# --- optional ffmpeg ---------------------------------------------------------
if command -v ffmpeg >/dev/null 2>&1; then
  echo "  [ok] ffmpeg is already on your PATH."
elif [ -x "$DEST/bin/ffmpeg" ]; then
  echo "  [ok] ffmpeg is already bundled with the panel."
else
  if [ "$FF_CHOICE" = "ask" ]; then
    echo
    echo "  Silencer decodes most footage on its own. ffmpeg adds support for"
    echo "  ProRes, DNxHD and other pro codecs, and handles very long files"
    echo "  more efficiently."
    echo
    if command -v brew >/dev/null 2>&1; then
      read -r -p "  Install ffmpeg with Homebrew now? [Y/n] " answer
      case "${answer:-y}" in [Nn]*) FF_CHOICE="no" ;; *) FF_CHOICE="yes" ;; esac
    else
      echo "  Homebrew is not installed, so ffmpeg cannot be added automatically."
      echo "  Install it later with:  brew install ffmpeg"
      FF_CHOICE="no"
    fi
  fi

  if [ "$FF_CHOICE" = "yes" ] && command -v brew >/dev/null 2>&1; then
    echo "  ... installing ffmpeg via Homebrew"
    if brew install ffmpeg; then
      echo "  [ok] ffmpeg installed."
    else
      echo "  [!] Homebrew could not install ffmpeg. The built-in decoder still works."
    fi
  else
    echo "  [--] Skipping ffmpeg."
  fi
fi

echo
echo "  ==========================================="
echo "    Done."
echo
echo "    Restart Premiere Pro, then open:"
echo "      Window  >  Extensions  >  Silencer"
echo "  ==========================================="
echo
[ "$SILENT" = "0" ] && read -r -p "  Press return to close." _
exit 0
