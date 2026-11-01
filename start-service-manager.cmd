@echo off
setlocal
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\bootstrap.ps1"
set "BOOTSTRAP_EXIT=%ERRORLEVEL%"
if "%BOOTSTRAP_EXIT%"=="2" (
  echo.
  echo WSL 2 is ready. Restart Windows, then run start-service-manager.cmd again.
  echo Setup log: "%LOCALAPPDATA%\QLDeTai\bootstrap.log"
  pause
  exit /b 2
)
if not "%BOOTSTRAP_EXIT%"=="0" (
  echo.
  echo Setup did not finish. See the details and log below, then run this file again.
  echo Setup log: "%LOCALAPPDATA%\QLDeTai\bootstrap.log"
  pause
)
exit /b %BOOTSTRAP_EXIT%
