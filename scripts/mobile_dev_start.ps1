param(
    [string]$AvdName = "Medium_Phone",
    [int]$MetroPort = 8081,
    [int]$EmulatorTimeoutSeconds = 180,
    [int]$MetroTimeoutSeconds = 60
)

$ErrorActionPreference = "Stop"

chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$RepoRoot = Split-Path -Parent $PSScriptRoot
$MobileRoot = Join-Path $RepoRoot "mobile"
$AndroidSdkRoot = Join-Path $env:LOCALAPPDATA "Android\Sdk"
$AdbPath = Join-Path $AndroidSdkRoot "platform-tools\adb.exe"
$EmulatorPath = Join-Path $AndroidSdkRoot "emulator\emulator.exe"

function Require-File {
    param(
        [string]$Path,
        [string]$Name
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Name not found: $Path"
    }
}

function Require-Directory {
    param(
        [string]$Path,
        [string]$Name
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "$Name not found: $Path"
    }
}

function Get-EmulatorDevice {
    $devices = & $AdbPath devices
    foreach ($line in $devices) {
        if ($line -match "^(emulator-\d+)\s+device$") {
            return $Matches[1]
        }
    }

    return $null
}

function Wait-ForEmulatorDevice {
    param([int]$TimeoutSeconds)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $device = Get-EmulatorDevice
        if ($device) {
            return $device
        }

        Start-Sleep -Seconds 3
    } while ((Get-Date) -lt $deadline)

    throw "Timed out waiting for an emulator device after $TimeoutSeconds seconds."
}

function Test-MetroRunning {
    param([int]$Port)

    try {
        $response = Invoke-WebRequest `
            -Uri "http://127.0.0.1:$Port/status" `
            -UseBasicParsing `
            -TimeoutSec 2

        if ($response.Content -is [byte[]]) {
            $content = [System.Text.Encoding]::UTF8.GetString($response.Content)
        } else {
            $content = [string]$response.Content
        }

        $status = $content.Trim()
        return ($status -eq "packager-status:running" -or $status -eq "running")
    } catch {
        return $false
    }
}

function Wait-ForMetro {
    param(
        [int]$Port,
        [int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (Test-MetroRunning -Port $Port) {
            return
        }

        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)

    throw "Timed out waiting for Metro on port $Port after $TimeoutSeconds seconds."
}

Require-Directory -Path $MobileRoot -Name "Mobile project"
Require-File -Path $AdbPath -Name "adb.exe"
Require-File -Path $EmulatorPath -Name "emulator.exe"

Write-Host "Checking Android emulator device..."
$Device = Get-EmulatorDevice
if (-not $Device) {
    Write-Host "No emulator device found. Starting AVD: $AvdName"
    Start-Process -FilePath $EmulatorPath -ArgumentList @("-avd", $AvdName)
    $Device = Wait-ForEmulatorDevice -TimeoutSeconds $EmulatorTimeoutSeconds
}

Write-Host "Using Android device: $Device"
$env:ANDROID_SERIAL = $Device

Write-Host "Configuring adb reverse for Metro port $MetroPort..."
& $AdbPath -s $Device reverse "tcp:$MetroPort" "tcp:$MetroPort"
if ($LASTEXITCODE -ne 0) {
    throw "adb reverse failed for $Device."
}

if (Test-MetroRunning -Port $MetroPort) {
    Write-Host "检测到 Metro 已运行，复用 $MetroPort"
} else {
    Write-Host "Metro is not running. Opening a new PowerShell window for npm.cmd start..."
    $metroCommand = "Set-Location -LiteralPath '$MobileRoot'; npm.cmd start"
    Start-Process -FilePath "powershell.exe" -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $metroCommand)
    Wait-ForMetro -Port $MetroPort -TimeoutSeconds $MetroTimeoutSeconds
}

Write-Host "Starting Android app without starting another packager..."
Push-Location -LiteralPath $MobileRoot
try {
    npm.cmd run android -- --no-packager
} finally {
    Pop-Location
}
