@echo off
cd /d "%~dp0"
where dotnet >nul 2>nul
if errorlevel 1 (
  echo Vui long cai .NET 10 SDK de chay trinh quan ly dich vu Windows.
  echo Tai tai: https://dotnet.microsoft.com/download/dotnet/10.0
  pause
  exit /b 1
)
dotnet run --project service-manager\ServiceManager.csproj
if errorlevel 1 pause
