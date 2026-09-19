@echo off
setlocal
title Silencer - Uninstall

set "DEST=%APPDATA%\Adobe\CEP\extensions\com.niterix.silencer"

echo.
echo  Removing Silencer from:
echo    %DEST%
echo.

if not exist "%DEST%" (
  echo  Nothing to remove - Silencer is not installed for this user.
) else (
  rd /s /q "%DEST%"
  if exist "%DEST%" (
    echo  [X] Could not remove it. Close Premiere Pro and try again.
  ) else (
    echo  [ok] Silencer removed.
  )
)

echo.
echo  The CEP "unsigned extensions" setting was left alone, because other
echo  extensions may rely on it. To clear it yourself:
echo    reg delete "HKCU\Software\Adobe\CSXS.11" /v PlayerDebugMode /f
echo.
pause
