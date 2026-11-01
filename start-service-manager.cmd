@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1"
set "BOOTSTRAP_EXIT=%ERRORLEVEL%"
if not "%BOOTSTRAP_EXIT%"=="0" (
  echo.
  echo Setup did not finish. Follow the message above, then run this file again.
  pause
)
exit /b %BOOTSTRAP_EXIT%
