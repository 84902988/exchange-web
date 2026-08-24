param(
    [string]$AvdName = "Medium_Phone",
    [string]$DebugApplicationId = "com.exchangemobile.debug",
    [int]$MetroPort = 8081,
    [int]$ApiPort = 8000,
    [int]$ChartWebPort = 3000,
    [int]$EmulatorTimeoutSeconds = 180,
    [int]$MetroTimeoutSeconds = 60,
    [int]$ChartWebTimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"

chcp 65001 | Out-Null
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$RepoRoot = Split-Path -Parent $PSScriptRoot
$MobileRoot = Join-Path $RepoRoot "mobile"
$WebRoot = Join-Path $RepoRoot "web"
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
    param([string]$ExpectedAvdName)

    $devices = & $AdbPath devices
    foreach ($line in $devices) {
        if ($line -match "^(emulator-\d+)\s+device$") {
            $serial = $Matches[1]
            $reportedAvdName = [string](& $AdbPath -s $serial shell getprop ro.boot.qemu.avd_name 2>$null | Select-Object -First 1)
            $reportedAvdName = $reportedAvdName.Trim()
            if ($reportedAvdName -eq $ExpectedAvdName) {
                return $serial
            }
        }
    }

    return $null
}

function Wait-ForEmulatorDevice {
    param(
        [string]$ExpectedAvdName,
        [int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $device = Get-EmulatorDevice -ExpectedAvdName $ExpectedAvdName
        if ($device) {
            return $device
        }

        Start-Sleep -Seconds 3
    } while ((Get-Date) -lt $deadline)

    throw "Timed out waiting for an emulator device after $TimeoutSeconds seconds."
}

function Wait-ForEmulatorBoot {
    param(
        [string]$Device,
        [int]$TimeoutSeconds
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $bootCompleted = [string](& $AdbPath -s $Device shell getprop sys.boot_completed 2>$null | Select-Object -First 1)
        $bootCompleted = $bootCompleted.Trim()
        if ($bootCompleted -eq "1") {
            return
        }

        Start-Sleep -Seconds 3
    } while ((Get-Date) -lt $deadline)

    throw "Timed out waiting for Android boot completion on $Device after $TimeoutSeconds seconds."
}

function Wake-EmulatorScreen {
    param([string]$Device)

    Write-Host "Waking Android emulator screen..."
    & $AdbPath -s $Device shell input keyevent KEYCODE_WAKEUP
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to wake Android emulator screen on $Device."
    }

    # A fresh development AVD can boot into its non-secure keyguard. This only
    # dismisses that keyguard; it cannot bypass a configured device credential.
    & $AdbPath -s $Device shell wm dismiss-keyguard
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to dismiss the Android emulator keyguard on $Device."
    }

    Start-Sleep -Milliseconds 800
}

function Test-MetroRunning {
    param([int]$Port)

    try {
        $response = Invoke-WebRequest `
            -Uri "http://127.0.0.1:$Port/status" `
            -UseBasicParsing `
            -TimeoutSec 8

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

function Set-AdbReverse {
    param(
        [string]$Device,
        [int]$Port,
        [string]$ServiceName
    )

    Write-Host "Configuring adb reverse for $ServiceName port $Port..."
    & $AdbPath -s $Device reverse "tcp:$Port" "tcp:$Port"
    if ($LASTEXITCODE -ne 0) {
        throw "adb reverse failed for $ServiceName on $Device (port $Port)."
    }
}

function Test-PortListening {
    param([int]$Port)

    return [bool](
        Get-NetTCPConnection `
            -State Listen `
            -LocalPort $Port `
            -ErrorAction SilentlyContinue `
        | Select-Object -First 1
    )
}

function Wait-ForChartWeb {
    param(
        [int]$Port,
        [int]$TimeoutSeconds
    )

    $warmupUri = "http://127.0.0.1:$Port/mobile/advanced-chart?market=contract&symbol=XAUUSDT_PERP&interval=1m&lang=zh&sessionId=mobile-warmup-0001&category=cfd"
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest `
                -Uri $warmupUri `
                -UseBasicParsing `
                -TimeoutSec 15
            if ($response.StatusCode -eq 200) {
                return
            }
        } catch {
            # The first request can wait for Next.js to compile the route.
        }

        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $deadline)

    throw "Chart web did not become ready on port $Port after $TimeoutSeconds seconds."
}

function Ensure-ChartWeb {
    param(
        [int]$Port,
        [int]$TimeoutSeconds
    )

    if (Test-PortListening -Port $Port) {
        Write-Host "Chart web is already running. Reusing port $Port."
    } else {
        Write-Host "Chart web is not running. Starting it in the background..."
        $chartWebCommand = "Set-Location -LiteralPath '$WebRoot'; npm.cmd run dev -- --hostname 0.0.0.0 --port $Port"
        Start-Process `
            -FilePath "powershell.exe" `
            -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $chartWebCommand) `
            -WindowStyle Hidden
    }

    Write-Host "Warming the mobile advanced-chart route..."
    Wait-ForChartWeb -Port $Port -TimeoutSeconds $TimeoutSeconds
}

Require-Directory -Path $MobileRoot -Name "Mobile project"
Require-Directory -Path $WebRoot -Name "Web project"
Require-File -Path $AdbPath -Name "adb.exe"
Require-File -Path $EmulatorPath -Name "emulator.exe"

Write-Host "Checking Android emulator device..."
$Device = Get-EmulatorDevice -ExpectedAvdName $AvdName
if (-not $Device) {
    Write-Host "No emulator device found. Starting AVD: $AvdName"
    Start-Process -FilePath $EmulatorPath -ArgumentList @("-avd", $AvdName)
    $Device = Wait-ForEmulatorDevice `
        -ExpectedAvdName $AvdName `
        -TimeoutSeconds $EmulatorTimeoutSeconds
}

Wait-ForEmulatorBoot -Device $Device -TimeoutSeconds $EmulatorTimeoutSeconds
Wake-EmulatorScreen -Device $Device

Write-Host "Using Android device: $Device"
$env:ANDROID_SERIAL = $Device

Set-AdbReverse -Device $Device -Port $MetroPort -ServiceName "Metro"
Set-AdbReverse -Device $Device -Port $ApiPort -ServiceName "API"
Set-AdbReverse -Device $Device -Port $ChartWebPort -ServiceName "chart web"

Ensure-ChartWeb `
    -Port $ChartWebPort `
    -TimeoutSeconds $ChartWebTimeoutSeconds

if (Test-MetroRunning -Port $MetroPort) {
    Write-Host "Metro is already running. Reusing port $MetroPort."
} else {
    Write-Host "Metro is not running. Starting it in the background..."
    # Android Emulator resolves the development host as 10.0.2.2. Bind Metro
    # on IPv4 as well as localhost so the emulator can actually reach it.
    $metroCommand = "Set-Location -LiteralPath '$MobileRoot'; npm.cmd start -- --host 0.0.0.0"
    Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @("-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $metroCommand) `
        -WindowStyle Hidden
    Wait-ForMetro -Port $MetroPort -TimeoutSeconds $MetroTimeoutSeconds
}

Write-Host "Starting Android app without starting another packager..."
Push-Location -LiteralPath $MobileRoot
try {
    # ANDROID_SERIAL alone is not honored consistently by the React Native CLI
    # when another emulator (for example MuMu) is attached. Pass the serial
    # explicitly so install/launch never spills into a non-development device.
    npm.cmd run android -- `
        --no-packager `
        --appId $DebugApplicationId `
        --device $Device
} finally {
    Pop-Location
}
