@echo off
setlocal enabledelayedexpansion
title Silencer - Install

rem ---------------------------------------------------------------------------
rem  Silencer installer for Windows.
rem  Copies the panel into Premiere's user extension folder and tells CEP that
rem  unsigned extensions are allowed to load. Nothing needs admin rights,
rem  because everything lives under the current user's AppData.
rem
rem  Switches:  /silent    no prompts, no pause at the end
rem ---------------------------------------------------------------------------

set "EXT_ID=com.niterix.silencer"
set "DEST=%APPDATA%\Adobe\CEP\extensions\%EXT_ID%"
set "SILENT=0"

for %%A in (%*) do (
  if /i "%%~A"=="/silent" set "SILENT=1"
)

echo.
echo  ===========================================
echo    Silencer for Premiere Pro
echo  ===========================================
echo.

rem --- locate the payload ----------------------------------------------------
set "SRC="
if exist "%~dp0extension\CSXS\manifest.xml" set "SRC=%~dp0extension"
if not defined SRC if exist "%~dp0..\..\extension\CSXS\manifest.xml" set "SRC=%~dp0..\..\extension"
if not defined SRC if exist "%~dp0..\extension\CSXS\manifest.xml" set "SRC=%~dp0..\extension"

if not defined SRC (
  echo  [X] Could not find the "extension" folder next to this installer.
  echo      Keep Install-Windows.bat in the same folder as "extension".
  goto :fail
)

rem --- is Premiere running? --------------------------------------------------
tasklist /fi "imagename eq Adobe Premiere Pro.exe" 2>nul | find /i "Adobe Premiere Pro.exe" >nul
if not errorlevel 1 (
  echo  [!] Premiere Pro is open. The panel will only appear after you restart it.
  echo.
)

rem --- copy ------------------------------------------------------------------
echo  Installing to:
echo    %DEST%
echo.

if exist "%DEST%" (
  rd /s /q "%DEST%" 2>nul
)
mkdir "%DEST%" 2>nul
xcopy "%SRC%\*" "%DEST%\" /e /i /q /y >nul
if errorlevel 1 (
  echo  [X] Copy failed. Close Premiere Pro and run this again.
  goto :fail
)
echo  [ok] Panel files copied.

rem --- allow unsigned extensions --------------------------------------------
for %%V in (6 7 8 9 10 11 12) do (
  reg add "HKCU\Software\Adobe\CSXS.%%V" /v PlayerDebugMode /t REG_SZ /d 1 /f >nul 2>&1
)
echo  [ok] Unsigned extensions enabled for CEP 6-12.

rem --- ffmpeg ----------------------------------------------------------------
rem ffmpeg ships inside the extension now. Nothing is downloaded at install
rem time: an installer that fetched an archive and dropped an executable into
rem an app folder looked exactly like a dropper to antivirus, and a real-time
rem scan of it could stall this script for minutes with no output.
if exist "%DEST%\bin\ffmpeg.exe" (
  echo  [ok] ffmpeg is bundled ^(audio-only build, no download needed^).
  goto :done
)

where ffmpeg >nul 2>&1
if not errorlevel 1 (
  echo  [ok] No bundled ffmpeg in this copy, but one is on your PATH.
  goto :done
)

echo  [--] This copy has no bundled ffmpeg. Silencer still works with its
echo       built-in decoder, which covers MP4/H.264 with AAC, M4A, MP3, WAV,
echo       FLAC and OGG. For ProRes, DNxHD or very large files either grab
echo       the official release from
echo         https://github.com/NiteRix/Silencer/releases
echo       or run:  winget install Gyan.FFmpeg

rem ---------------------------------------------------------------------------
:done
echo.
echo  ===========================================
echo    Done.
echo.
echo    Restart Premiere Pro, then open:
echo      Window  ^>  Extensions  ^>  Silencer
echo  ===========================================
echo.
if "%SILENT%"=="0" pause
exit /b 0

:fail
echo.
if "%SILENT%"=="0" pause
exit /b 1
