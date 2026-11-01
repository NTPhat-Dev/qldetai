param([switch]$InstallWsl, [switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$managerProject = Join-Path $projectRoot 'service-manager\ServiceManager.csproj'

function Update-ProcessPath {
  $paths = @(
    (Join-Path $env:ProgramFiles 'dotnet'),
    (Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'),
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }
  $env:PATH = (($paths + $env:PATH.Split([IO.Path]::PathSeparator)) | Select-Object -Unique) -join [IO.Path]::PathSeparator
}

function Get-WingetPath {
  Update-ProcessPath
  $command = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  try {
    Add-AppxPackage -RegisterByFamilyName -MainPackage Microsoft.DesktopAppInstaller_8wekyb3d8bbwe -ErrorAction Stop
  } catch { }
  Update-ProcessPath
  $command = Get-Command winget.exe -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  try { Start-Process 'ms-windows-store://pdp/?ProductId=9NBLGGH4NNS1' } catch { }
  throw 'Máy chưa có WinGet (App Installer). Cài App Installer từ Microsoft Store, sau đó chạy lại start-service-manager.cmd.'
}

function Install-WithWinget([string]$PackageId) {
  Write-Host "Đang cài $PackageId bằng WinGet..." -ForegroundColor Cyan
  & $script:winget install --id $PackageId --exact --silent --accept-source-agreements
  if ($LASTEXITCODE -ne 0) {
    throw "WinGet không cài được $PackageId (mã $LASTEXITCODE). Nếu hiện yêu cầu quyền quản trị hoặc điều khoản ứng dụng, hoàn tất rồi chạy lại start-service-manager.cmd."
  }
  Update-ProcessPath
}

function Test-Dotnet10 {
  Update-ProcessPath
  $dotnet = Get-Command dotnet.exe -ErrorAction SilentlyContinue
  if (-not $dotnet) { return $false }
  $sdks = & $dotnet.Source --list-sdks 2>$null
  return ($sdks | Where-Object { $_ -match '^10\.' } | Select-Object -First 1) -ne $null
}

function Find-DockerDesktop {
  $programFiles = $env:ProgramFiles
  $local = $env:LOCALAPPDATA
  $candidates = @(
    (Join-Path $programFiles 'Docker\Docker\Docker Desktop.exe'),
    (Join-Path $programFiles 'Docker\Docker\frontend\Docker Desktop.exe'),
    (Join-Path $local 'Programs\Docker\Docker\Docker Desktop.exe'),
    (Join-Path $local 'Programs\DockerDesktop\Docker Desktop.exe'),
    (Join-Path $local 'Programs\DockerDesktop\frontend\Docker Desktop.exe')
  )
  return $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}

function Test-Wsl2Available {
  $wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
  if (-not (Test-Path -LiteralPath $wsl)) { return $false }
  & $wsl --version *> $null
  return $LASTEXITCODE -eq 0
}

if ($InstallWsl) {
  $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Error 'Cần quyền quản trị để bật WSL 2.'
    exit 1
  }
  $wsl = Join-Path $env:SystemRoot 'System32\wsl.exe'
  & $wsl --install --no-distribution
  if ($LASTEXITCODE -ne 0) {
    Write-Error 'Không cài được WSL 2. Kiểm tra yêu cầu hệ thống và thử lại.'
    exit 1
  }
  exit 0
}

try {
  Set-Location $projectRoot
  $script:winget = Get-WingetPath

  if (-not (Test-Dotnet10)) { Install-WithWinget 'Microsoft.DotNet.SDK.10' }
  if (-not (Test-Dotnet10)) { throw 'Chưa tìm thấy .NET SDK 10 sau khi cài. Đóng cửa sổ này, mở Terminal mới rồi chạy lại.' }

  if (-not (Test-Wsl2Available)) {
    Write-Host 'Máy cần WSL 2 cho Docker Desktop. Windows sẽ yêu cầu quyền quản trị và có thể cần khởi động lại.' -ForegroundColor Yellow
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-InstallWsl')
    $elevated = Start-Process -FilePath 'powershell.exe' -Verb RunAs -ArgumentList $arguments -Wait -PassThru
    if ($elevated.ExitCode -ne 0) { throw 'Không cài được WSL 2.' }
    throw 'Đã cài WSL 2. Hãy khởi động lại Windows rồi chạy lại start-service-manager.cmd để tiếp tục.'
  }

  if (-not (Find-DockerDesktop)) { Install-WithWinget 'Docker.DockerDesktop' }
  if (-not (Find-DockerDesktop)) { throw 'Chưa tìm thấy Docker Desktop sau khi cài. Khởi động lại Windows rồi chạy lại start-service-manager.cmd.' }
  Update-ProcessPath

  if ($CheckOnly) {
    Write-Host 'Đã có .NET SDK 10, WSL 2 và Docker Desktop.' -ForegroundColor Green
    exit 0
  }

  Write-Host 'Đang mở trình quản lý và chuẩn bị các dịch vụ...' -ForegroundColor Green
  & dotnet run --project $managerProject
  exit $LASTEXITCODE
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
