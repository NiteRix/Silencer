@echo off
setlocal enabledelayedexpansion
title Silencer - Install

rem ---------------------------------------------------------------------------
rem  Silencer installer for Windows.
rem  Copies the panel into Premiere's user extension folder and tells CEP that
rem  unsigned extensions are allowed to load. Nothing needs admin rights,
rem  because everything lives under the current user's AppData.
rem
rem  Switches:  /ffmpeg    install ffmpeg without asking
rem             /noffmpeg  skip ffmpeg without asking
rem             /silent    no prompts, no pause at the end
rem ---------------------------------------------------------------------------

set "EXT_ID=com.niterix.silencer"
set "DEST=%APPDATA%\Adobe\CEP\extensions\%EXT_ID%"
set "FF_CHOICE=ask"
set "SILENT=0"
set "FFONLY=0"

for %%A in (%*) do (
  if /i "%%~A"=="/ffmpeg"     set "FF_CHOICE=yes"
  if /i "%%~A"=="/noffmpeg"   set "FF_CHOICE=no"
  if /i "%%~A"=="/silent"     set "SILENT=1"
  if /i "%%~A"=="/ffmpegonly" set "FFONLY=1"
)
if "%SILENT%"=="1" if "%FF_CHOICE%"=="ask" set "FF_CHOICE=no"

rem The .exe installer has already placed the panel; it only needs the codec helper.
if "%FFONLY%"=="1" (
  set "DEST=%~dp0"
  if "!DEST:~-1!"=="\" set "DEST=!DEST:~0,-1!"
  call :install_ffmpeg
  goto :done
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

rem --- optional ffmpeg -------------------------------------------------------
where ffmpeg >nul 2>&1
if not errorlevel 1 (
  echo  [ok] ffmpeg is already on your PATH.
  goto :done
)
if exist "%DEST%\bin\ffmpeg.exe" (
  echo  [ok] ffmpeg is already bundled with the panel.
  goto :done
)

if "%FF_CHOICE%"=="ask" (
  echo.
  echo  Silencer decodes most footage on its own. ffmpeg ^(about 30 MB^) adds
  echo  support for ProRes, DNxHD and other pro codecs, and handles very long
  echo  files more efficiently.
  echo.
  set /p "ANSWER=  Download ffmpeg now? [Y/n] "
  if /i "!ANSWER!"=="n" (set "FF_CHOICE=no") else (set "FF_CHOICE=yes")
)
if "%FF_CHOICE%"=="no" (
  echo  [--] Skipping ffmpeg. You can re-run this installer later to add it.
  goto :done
)

call :install_ffmpeg
goto :done

rem ---------------------------------------------------------------------------
:install_ffmpeg
where curl >nul 2>&1
if errorlevel 1 (
  echo  [!] curl is unavailable, so ffmpeg cannot be downloaded automatically.
  exit /b 0
)
set "FFTMP=%TEMP%\silencer-ffmpeg"
set "FFZIP=%FFTMP%\ffmpeg.zip"
if exist "%FFTMP%" rd /s /q "%FFTMP%" 2>nul
mkdir "%FFTMP%" 2>nul

echo  ... downloading ffmpeg
curl -L --fail --retry 2 --retry-delay 2 -o "%FFZIP%" ^
  "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip"
if errorlevel 1 (
  echo  [!] Download failed. Silencer will use its built-in decoder instead.
  rd /s /q "%FFTMP%" 2>nul
  exit /b 0
)

echo  ... extracting
tar -xf "%FFZIP%" -C "%FFTMP%" >nul 2>&1
if errorlevel 1 (
  echo  [!] Could not unpack the download. Skipping ffmpeg.
  rd /s /q "%FFTMP%" 2>nul
  exit /b 0
)

set "FFEXE="
for /r "%FFTMP%" %%F in (ffmpeg.exe) do if not defined FFEXE set "FFEXE=%%F"
if not defined FFEXE (
  echo  [!] ffmpeg.exe was not in the archive. Skipping.
  rd /s /q "%FFTMP%" 2>nul
  exit /b 0
)

mkdir "%DEST%\bin" 2>nul
copy /y "!FFEXE!" "%DEST%\bin\ffmpeg.exe" >nul
rd /s /q "%FFTMP%" 2>nul
echo  [ok] ffmpeg installed alongside the panel.
exit /b 0

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
