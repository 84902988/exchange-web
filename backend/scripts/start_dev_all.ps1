param(
    [string]$ApiHost = "127.0.0.1",
    [int]$ApiPort = 8000,
    [string]$PythonExe = "",
    [switch]$Reload,
    [ValidateSet("Auto", "Launcher", "External")]
    [string]$ApiOwnership = "Auto",
    [ValidateSet("Start", "Status", "Preflight")]
    [string]$Action = "Start",
    [string]$RuntimeStateDir = "",
    [ValidateRange(5, 120)]
    [int]$ApiStartupTimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Split-Path -Parent $ScriptDir
$RepoRoot = Split-Path -Parent $BackendDir
$RepoRoot = (Resolve-Path -LiteralPath $RepoRoot).Path

if ($ApiPort -lt 1 -or $ApiPort -gt 65535) {
    throw "ApiPort must be between 1 and 65535."
}

if (-not $PythonExe) {
    $VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $VenvPython) {
        $PythonExe = $VenvPython
    } else {
        $PythonExe = "python"
    }
}

if (Test-Path -LiteralPath $PythonExe) {
    $PythonExe = (Resolve-Path -LiteralPath $PythonExe).Path
} elseif (-not (Get-Command $PythonExe -ErrorAction SilentlyContinue)) {
    throw "Python executable not found: $PythonExe"
}

function Quote-ForPowerShell {
    param([Parameter(Mandatory = $true)][string]$Value)
    return "'" + ($Value -replace "'", "''") + "'"
}

function Get-StableRepoKey {
    param([Parameter(Mandatory = $true)][string]$Path)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Path.ToLowerInvariant())
        $hash = $sha.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hash).Replace("-", "").Substring(0, 16)).ToLowerInvariant()
    } finally {
        $sha.Dispose()
    }
}

$RepoKey = Get-StableRepoKey -Path $RepoRoot
if (-not $RuntimeStateDir) {
    $RuntimeBase = $env:LOCALAPPDATA
    if (-not $RuntimeBase) {
        $RuntimeBase = [System.IO.Path]::GetTempPath()
    }
    $RuntimeStateDir = Join-Path $RuntimeBase "exchange-web\dev-runtime\$RepoKey"
}

function New-RoleDefinition {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$ScriptRelativePath,
        [string[]]$Arguments = @(),
        [ValidateSet("Repo", "Backend")][string]$WorkingDirectory = "Repo"
    )

    $scriptPath = Join-Path $RepoRoot $ScriptRelativePath
    if (-not (Test-Path -LiteralPath $scriptPath)) {
        throw "Missing process script for role '$Name': $scriptPath"
    }

    return [pscustomobject]@{
        Name = $Name
        Title = $Title
        ScriptPath = (Resolve-Path -LiteralPath $scriptPath).Path
        ScriptLeaf = Split-Path -Leaf $scriptPath
        Arguments = @($Arguments)
        WorkingDirectory = if ($WorkingDirectory -eq "Backend") { $BackendDir } else { $RepoRoot }
    }
}

$Roles = @(
    (New-RoleDefinition -Name "rq-core" -Title "exchange RQ collection/gas/tx_confirm/withdraw" -ScriptRelativePath "backend\scripts\start_rq_worker.py" -Arguments @("collection", "gas", "tx_confirm", "withdraw")),
    (New-RoleDefinition -Name "rq-email" -Title "exchange RQ email" -ScriptRelativePath "backend\scripts\start_rq_worker.py" -Arguments @("email")),
    (New-RoleDefinition -Name "rq-payout" -Title "exchange RQ payout" -ScriptRelativePath "backend\scripts\start_rq_worker.py" -Arguments @("payout")),
    (New-RoleDefinition -Name "rq-release" -Title "exchange RQ release" -ScriptRelativePath "backend\scripts\start_rq_worker.py" -Arguments @("release")),
    (New-RoleDefinition -Name "rq-maintenance" -Title "exchange RQ maintenance" -ScriptRelativePath "backend\scripts\start_rq_worker.py" -Arguments @("maintenance")),
    (New-RoleDefinition -Name "withdraw-fee-scheduler" -Title "exchange withdraw fee scheduler" -ScriptRelativePath "backend\scripts\start_withdraw_fee_scheduler.py"),
    (New-RoleDefinition -Name "collection-auto-scheduler" -Title "exchange collection auto scheduler" -ScriptRelativePath "backend\scripts\start_collection_auto_scheduler.py"),
    (New-RoleDefinition -Name "spot-match-worker" -Title "exchange spot match worker" -ScriptRelativePath "backend\scripts\start_spot_match_worker.py"),
    (New-RoleDefinition -Name "dealer-loop" -Title "exchange dealer loop" -ScriptRelativePath "backend\scripts\start_dealer_loop.py"),
    (New-RoleDefinition -Name "liquidation-scanner" -Title "exchange liquidation scanner" -ScriptRelativePath "backend\scripts\start_liquidation_scanner.py"),
    (New-RoleDefinition -Name "tp-sl-scanner" -Title "exchange TP SL scanner" -ScriptRelativePath "backend\scripts\start_tp_sl_scanner.py"),
    (New-RoleDefinition -Name "contract-limit-order-scanner" -Title "exchange contract limit order scanner" -ScriptRelativePath "backend\scripts\start_contract_limit_order_scanner.py"),
    (New-RoleDefinition -Name "contract-accounting-reconciliation-scheduler" -Title "exchange contract accounting reconciliation scheduler" -ScriptRelativePath "backend\scripts\start_contract_accounting_reconciliation_scheduler.py")
)

function Get-ProcessSnapshot {
    $items = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine)
    $byId = @{}
    foreach ($item in $items) {
        $byId[[int]$item.ProcessId] = $item
    }
    return [pscustomobject]@{ Items = $items; ById = $byId }
}

function Test-IsPythonProcess {
    param($ProcessInfo)
    if ($null -eq $ProcessInfo) {
        return $false
    }
    return $ProcessInfo.Name -ieq "python.exe" -or $ProcessInfo.Name -ieq "pythonw.exe"
}

function Get-CommandWords {
    param([string]$CommandLine)
    if (-not $CommandLine) {
        return @()
    }
    return @(($CommandLine -replace '["'']', ' ') -split '\s+' | Where-Object { $_ })
}

function Test-ProcessFromRepo {
    param($ProcessInfo)

    $commandLine = [string]$ProcessInfo.CommandLine
    if ($commandLine -and $commandLine.IndexOf($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        return $true
    }
    if ($ProcessInfo.ExecutablePath) {
        return ([string]$ProcessInfo.ExecutablePath).StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)
    }
    return $false
}

function Test-RoleProcessMatch {
    param($ProcessInfo, $Role)

    if (-not (Test-IsPythonProcess -ProcessInfo $ProcessInfo)) {
        return $false
    }
    if (-not (Test-ProcessFromRepo -ProcessInfo $ProcessInfo)) {
        return $false
    }
    $commandLine = [string]$ProcessInfo.CommandLine
    if (-not $commandLine -or $commandLine.IndexOf($Role.ScriptLeaf, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) {
        return $false
    }
    $words = @(Get-CommandWords -CommandLine $commandLine)
    foreach ($argument in $Role.Arguments) {
        if (-not ($words -contains $argument)) {
            return $false
        }
    }

    if ($Role.ScriptLeaf -ieq "start_rq_worker.py") {
        $queueNames = @("collection", "gas", "tx_confirm", "withdraw", "email", "payout", "release", "maintenance")
        $actualQueues = @($queueNames | Where-Object { $words -contains $_ })
        if ($actualQueues.Count -ne $Role.Arguments.Count) {
            return $false
        }
    }
    return $true
}

function Get-UnmanagedRqRootProcesses {
    param($Snapshot)

    $rqRoles = @($Roles | Where-Object { $_.ScriptLeaf -ieq "start_rq_worker.py" })
    $rqProcesses = @($Snapshot.Items | Where-Object {
        (Test-IsPythonProcess -ProcessInfo $_) -and
        (Test-ProcessFromRepo -ProcessInfo $_) -and
        ([string]$_.CommandLine).IndexOf("start_rq_worker.py", [System.StringComparison]::OrdinalIgnoreCase) -ge 0
    })
    $rqIds = @{}
    foreach ($item in $rqProcesses) {
        $rqIds[[int]$item.ProcessId] = $true
    }
    $roots = @($rqProcesses | Where-Object { -not $rqIds.ContainsKey([int]$_.ParentProcessId) })
    return @($roots | Where-Object {
        $processInfo = $_
        -not ($rqRoles | Where-Object { Test-RoleProcessMatch -ProcessInfo $processInfo -Role $_ })
    })
}

function Get-RoleRootProcesses {
    param($Snapshot, $Role)

    $matches = @($Snapshot.Items | Where-Object { Test-RoleProcessMatch -ProcessInfo $_ -Role $Role })
    $matchIds = @{}
    foreach ($match in $matches) {
        $matchIds[[int]$match.ProcessId] = $true
    }
    return @($matches | Where-Object { -not $matchIds.ContainsKey([int]$_.ParentProcessId) })
}

function Get-ProcessLineage {
    param($Snapshot, [int]$ProcessId)

    $lineage = @()
    $seen = @{}
    $currentId = $ProcessId
    for ($depth = 0; $depth -lt 10; $depth++) {
        if ($seen.ContainsKey($currentId) -or -not $Snapshot.ById.ContainsKey($currentId)) {
            break
        }
        $seen[$currentId] = $true
        $item = $Snapshot.ById[$currentId]
        $lineage += $item
        $currentId = [int]$item.ParentProcessId
    }
    return $lineage
}

function Test-IsIntendedApiListener {
    param($Snapshot, [int[]]$ProcessIds)

    foreach ($processId in $ProcessIds) {
        foreach ($item in @(Get-ProcessLineage -Snapshot $Snapshot -ProcessId $processId)) {
            $commandLine = [string]$item.CommandLine
            if (-not $commandLine) {
                continue
            }
            $isUvicorn = $commandLine.IndexOf("uvicorn", [System.StringComparison]::OrdinalIgnoreCase) -ge 0
            $isApp = $commandLine.IndexOf("app.main:app", [System.StringComparison]::OrdinalIgnoreCase) -ge 0
            $fromRepo = $commandLine.IndexOf($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
            if (-not $fromRepo -and $item.ExecutablePath) {
                $fromRepo = ([string]$item.ExecutablePath).StartsWith($RepoRoot, [System.StringComparison]::OrdinalIgnoreCase)
            }
            if ($isUvicorn -and $isApp -and $fromRepo) {
                return $true
            }
        }
    }
    return $false
}

function Test-ApiHealth {
    param([string]$HostName, [int]$Port)

    $probeHost = $HostName
    if ($probeHost -in @("0.0.0.0", "::", "[::]")) {
        $probeHost = "127.0.0.1"
    }
    try {
        $response = Invoke-RestMethod -Uri "http://${probeHost}:$Port/health" -Method Get -TimeoutSec 3
        return $null -ne $response -and $response.ok -eq $true
    } catch {
        return $false
    }
}

function Get-ApiPortState {
    param($Snapshot)

    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) {
        throw "Get-NetTCPConnection is required to verify API port ownership safely."
    }
    $listeners = @(Get-NetTCPConnection -LocalPort $ApiPort -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) {
        return [pscustomobject]@{ State = "Free"; ProcessIds = @(); Healthy = $false; Intended = $false }
    }
    $processIds = @($listeners | ForEach-Object { [int]$_.OwningProcess } | Sort-Object -Unique)
    $intended = Test-IsIntendedApiListener -Snapshot $Snapshot -ProcessIds $processIds
    $healthy = Test-ApiHealth -HostName $ApiHost -Port $ApiPort
    $state = if ($intended -and $healthy) { "HealthyIntended" } elseif ($intended) { "UnhealthyIntended" } else { "OccupiedUnknown" }
    return [pscustomobject]@{ State = $state; ProcessIds = $processIds; Healthy = $healthy; Intended = $intended }
}

function Resolve-ApiPlan {
    param($ApiState)

    if ($ApiState.State -eq "Free") {
        if ($ApiOwnership -eq "External") {
            throw "API ownership is External, but $ApiHost`:$ApiPort has no listener. Start the intended API first or use -ApiOwnership Auto/Launcher."
        }
        return "Start"
    }

    $pidText = ($ApiState.ProcessIds -join ", ")
    if ($ApiState.State -ne "HealthyIntended") {
        throw "API port $ApiHost`:$ApiPort is $($ApiState.State) (PID: $pidText). Refusing to start workers against an unknown or unhealthy backend."
    }
    if ($ApiOwnership -eq "Launcher") {
        throw "API ownership is Launcher, but the intended API already owns $ApiHost`:$ApiPort (PID: $pidText). Use -ApiOwnership Auto or External."
    }
    return "Reuse"
}

function Get-RoleCommand {
    param($Role)

    $parts = @((Quote-ForPowerShell $PythonExe), (Quote-ForPowerShell $Role.ScriptPath))
    $parts += @($Role.Arguments | ForEach-Object { Quote-ForPowerShell $_ })
    return "& " + ($parts -join " ")
}

function Start-DevProcess {
    param(
        [Parameter(Mandatory = $true)]$Role,
        [Parameter(Mandatory = $true)][string]$GroupId
    )

    $safeTitle = $Role.Title -replace "'", "''"
    $safeWorkingDirectory = Quote-ForPowerShell $Role.WorkingDirectory
    $safeGroupId = $GroupId -replace "'", "''"
    $safeRole = $Role.Name -replace "'", "''"
    $command = Get-RoleCommand -Role $Role
    $windowCommand = @"
`$Host.UI.RawUI.WindowTitle = '$safeTitle'
Set-Location -LiteralPath $safeWorkingDirectory
`$env:EXCHANGE_DEV_GROUP_ID = '$safeGroupId'
`$env:EXCHANGE_DEV_ROLE = '$safeRole'
Write-Host "[$safeRole] starting..." -ForegroundColor Cyan
try {
    $command
    `$exitCode = `$LASTEXITCODE
    if (`$null -eq `$exitCode) { `$exitCode = 0 }
    if (`$exitCode -eq 0) {
        Write-Host "[$safeRole] exited normally (code 0)." -ForegroundColor Yellow
    } else {
        Write-Host "[$safeRole] exited with code `$exitCode. Review the log above." -ForegroundColor Red
    }
} catch {
    Write-Host "[$safeRole] failed: `$(`$_.Exception.Message)" -ForegroundColor Red
}
"@

    return Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $windowCommand) `
        -WorkingDirectory $Role.WorkingDirectory `
        -PassThru
}

function Start-ApiProcess {
    param([Parameter(Mandatory = $true)][string]$GroupId)

    $reloadArgs = ""
    if ($Reload) {
        $reloadArgs = " --reload --reload-dir app --reload-exclude '../tmp/pdfs/*' --reload-exclude '../tmp/*' --reload-exclude 'tmp/*' --reload-exclude '../output/*'"
    }
    $role = [pscustomobject]@{
        Name = "api"
        Title = "exchange FastAPI :$ApiPort"
        WorkingDirectory = $BackendDir
    }
    $safeTitle = $role.Title -replace "'", "''"
    $safeWorkingDirectory = Quote-ForPowerShell $BackendDir
    $safeGroupId = $GroupId -replace "'", "''"
    $quotedPython = Quote-ForPowerShell $PythonExe
    $windowCommand = @"
`$Host.UI.RawUI.WindowTitle = '$safeTitle'
Set-Location -LiteralPath $safeWorkingDirectory
`$env:EXCHANGE_DEV_GROUP_ID = '$safeGroupId'
`$env:EXCHANGE_DEV_ROLE = 'api'
`$env:EMBED_BACKGROUND_LOOPS_IN_API = '0'
`$env:ENABLE_SPOT_AUTO_MATCH_IN_API = '0'
`$env:ENABLE_CONTRACT_LIMIT_ORDER_JOB = '0'
Write-Host "[api] starting on $ApiHost`:$ApiPort..." -ForegroundColor Cyan
try {
    & $quotedPython -m uvicorn app.main:app --host $ApiHost --port $ApiPort --access-log$reloadArgs
    `$exitCode = `$LASTEXITCODE
    if (`$null -eq `$exitCode) { `$exitCode = 0 }
    if (`$exitCode -eq 0) {
        Write-Host "[api] exited normally (code 0)." -ForegroundColor Yellow
    } else {
        Write-Host "[api] exited with code `$exitCode. Review the log above." -ForegroundColor Red
    }
} catch {
    Write-Host "[api] failed: `$(`$_.Exception.Message)" -ForegroundColor Red
}

function Stop-StartedProcessTree {
    param([int]$RootProcessId)

    $snapshot = Get-ProcessSnapshot
    $childrenByParent = @{}
    foreach ($item in $snapshot.Items) {
        $parentId = [int]$item.ParentProcessId
        if (-not $childrenByParent.ContainsKey($parentId)) {
            $childrenByParent[$parentId] = @()
        }
        $childrenByParent[$parentId] += [int]$item.ProcessId
    }

    $ordered = New-Object System.Collections.Generic.List[int]
    $pending = New-Object System.Collections.Generic.Stack[int]
    $pending.Push($RootProcessId)
    while ($pending.Count -gt 0) {
        $currentId = $pending.Pop()
        $ordered.Add($currentId)
        if ($childrenByParent.ContainsKey($currentId)) {
            foreach ($childId in $childrenByParent[$currentId]) {
                $pending.Push($childId)
            }
        }
    }
    for ($index = $ordered.Count - 1; $index -ge 0; $index--) {
        Stop-Process -Id $ordered[$index] -Force -ErrorAction SilentlyContinue
    }
}

function Wait-ForApiReady {
    param([int]$TimeoutSeconds)

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        if (Test-ApiHealth -HostName $ApiHost -Port $ApiPort) {
            $readyState = Get-ApiPortState -Snapshot (Get-ProcessSnapshot)
            return $readyState.State -eq "HealthyIntended"
        }
        Start-Sleep -Milliseconds 250
    } while ([DateTime]::UtcNow -lt $deadline)
    return $false
}
"@

    return Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $windowCommand) `
        -WorkingDirectory $BackendDir `
        -PassThru
}

function Write-Manifest {
    param($Manifest)

    New-Item -ItemType Directory -Path $RuntimeStateDir -Force | Out-Null
    $manifestPath = Join-Path $RuntimeStateDir "latest.json"
    $temporaryPath = Join-Path $RuntimeStateDir ("latest.{0}.tmp" -f [guid]::NewGuid().ToString("N"))
    $Manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $temporaryPath -Encoding UTF8
    Move-Item -LiteralPath $temporaryPath -Destination $manifestPath -Force
    return $manifestPath
}

function Write-StatusReport {
    param($ApiState, $RoleStates, $UnmanagedRqProcesses)

    Write-Host "API $ApiHost`:$ApiPort : $($ApiState.State)" -ForegroundColor $(if ($ApiState.State -eq "HealthyIntended") { "Green" } elseif ($ApiState.State -eq "Free") { "Yellow" } else { "Red" })
    if ($ApiState.ProcessIds.Count -gt 0) {
        Write-Host "  listener PID(s): $($ApiState.ProcessIds -join ', ')"
    }
    foreach ($state in $RoleStates) {
        $color = if ($state.Count -eq 1) { "Green" } elseif ($state.Count -eq 0) { "Yellow" } else { "Red" }
        $detail = if ($state.Count -eq 0) { "not running" } else { "PID(s): $($state.ProcessIds -join ', ')" }
        Write-Host ("{0,-46} {1}" -f $state.Name, $detail) -ForegroundColor $color
    }
    if ($UnmanagedRqProcesses.Count -gt 0) {
        Write-Host ("{0,-46} PID(s): {1}" -f "unmanaged-rq-layout", (@($UnmanagedRqProcesses.ProcessId) -join ", ")) -ForegroundColor Red
    }
}

$Snapshot = Get-ProcessSnapshot
$ApiState = Get-ApiPortState -Snapshot $Snapshot
$UnmanagedRqProcesses = @(Get-UnmanagedRqRootProcesses -Snapshot $Snapshot)
$RoleStates = @()
foreach ($role in $Roles) {
    $processes = @(Get-RoleRootProcesses -Snapshot $Snapshot -Role $role)
    $RoleStates += [pscustomobject]@{
        Name = $role.Name
        Role = $role
        Count = $processes.Count
        ProcessIds = @($processes | ForEach-Object { [int]$_.ProcessId })
    }
}

if ($Action -eq "Status") {
    Write-Host "Exchange local process status" -ForegroundColor Cyan
    Write-Host "Repo root: $RepoRoot"
    Write-StatusReport -ApiState $ApiState -RoleStates $RoleStates -UnmanagedRqProcesses $UnmanagedRqProcesses
    return
}

$ApiPlan = Resolve-ApiPlan -ApiState $ApiState
$duplicateRoles = @($RoleStates | Where-Object { $_.Count -gt 1 })
if ($duplicateRoles.Count -gt 0) {
    $details = @($duplicateRoles | ForEach-Object { "$($_.Name)=[$($_.ProcessIds -join ',')]" }) -join "; "
    throw "Duplicate logical role processes detected: $details. Refusing to add more processes; stop the duplicate instance(s) deliberately first."
}
if ($UnmanagedRqProcesses.Count -gt 0) {
    $unmanagedPids = @($UnmanagedRqProcesses | ForEach-Object { [int]$_.ProcessId }) -join ", "
    throw "Unmanaged RQ queue layout detected for this repository (PID: $unmanagedPids). Refusing to add overlapping local workers."
}

Write-Host "Exchange local process preflight" -ForegroundColor Cyan
Write-Host "Repo root: $RepoRoot"
Write-Host "Python: $PythonExe"
Write-Host "API ownership: $ApiOwnership (plan: $ApiPlan)"
Write-Host "Runtime state: $RuntimeStateDir"
Write-Host ""
Write-StatusReport -ApiState $ApiState -RoleStates $RoleStates -UnmanagedRqProcesses $UnmanagedRqProcesses

$missingRoleStates = @($RoleStates | Where-Object { $_.Count -eq 0 })
if ($Action -eq "Preflight") {
    Write-Host ""
    Write-Host "Preflight passed. API action: $ApiPlan; worker roles to start: $($missingRoleStates.Count); existing roles to reuse: $($Roles.Count - $missingRoleStates.Count)." -ForegroundColor Green
    return
}

$mutexName = "Local\ExchangeWebDevLauncher_$RepoKey"
$mutex = New-Object System.Threading.Mutex($false, $mutexName)
$lockTaken = $false
try {
    try {
        $lockTaken = $mutex.WaitOne(0)
    } catch [System.Threading.AbandonedMutexException] {
        $lockTaken = $true
    }
    if (-not $lockTaken) {
        throw "Another start_dev_all.ps1 invocation is already launching this repository. Try again after it finishes."
    }

    # Refresh after taking the lock so two concurrent launchers cannot pass the same stale preflight.
    $Snapshot = Get-ProcessSnapshot
    $ApiState = Get-ApiPortState -Snapshot $Snapshot
    $ApiPlan = Resolve-ApiPlan -ApiState $ApiState
    $UnmanagedRqProcesses = @(Get-UnmanagedRqRootProcesses -Snapshot $Snapshot)
    if ($UnmanagedRqProcesses.Count -gt 0) {
        throw "Unmanaged RQ queue layout appeared while acquiring launch lock (PID: $(@($UnmanagedRqProcesses.ProcessId) -join ', '))."
    }
    $RoleStates = @()
    foreach ($role in $Roles) {
        $processes = @(Get-RoleRootProcesses -Snapshot $Snapshot -Role $role)
        if ($processes.Count -gt 1) {
            throw "Duplicate logical role '$($role.Name)' detected after acquiring launch lock (PID: $(@($processes.ProcessId) -join ', '))."
        }
        $RoleStates += [pscustomobject]@{
            Name = $role.Name
            Role = $role
            Count = $processes.Count
            ProcessIds = @($processes | ForEach-Object { [int]$_.ProcessId })
        }
    }

    $groupId = [guid]::NewGuid().ToString("N")
    $manifestEntries = @()
    $startedCount = 0

    if ($ApiPlan -eq "Start") {
        $apiProcess = Start-ApiProcess -GroupId $groupId
        if (-not (Wait-ForApiReady -TimeoutSeconds $ApiStartupTimeoutSeconds)) {
            Write-Host "API did not become healthy within $ApiStartupTimeoutSeconds seconds. Workers were not started." -ForegroundColor Red
            if (-not $apiProcess.HasExited) {
                Stop-StartedProcessTree -RootProcessId $apiProcess.Id
            }
            throw "API startup health check failed on http://$ApiHost`:$ApiPort/health"
        }
        $startedCount++
        $manifestEntries += [ordered]@{ role = "api"; ownership = "launcher"; wrapper_pid = [int]$apiProcess.Id; listener_pids = @() }
    } else {
        if ($Reload) {
            Write-Warning "-Reload only applies when this launcher starts the API; the existing external API was left unchanged."
        }
        $manifestEntries += [ordered]@{ role = "api"; ownership = "external"; wrapper_pid = $null; listener_pids = @($ApiState.ProcessIds) }
    }

    foreach ($state in $RoleStates) {
        if ($state.Count -eq 1) {
            Write-Host "Reusing $($state.Name) (PID $($state.ProcessIds[0]))." -ForegroundColor DarkGreen
            $manifestEntries += [ordered]@{ role = $state.Name; ownership = "external"; wrapper_pid = $null; process_pids = @($state.ProcessIds) }
            continue
        }
        $process = Start-DevProcess -Role $state.Role -GroupId $groupId
        $startedCount++
        $manifestEntries += [ordered]@{ role = $state.Name; ownership = "launcher"; wrapper_pid = [int]$process.Id; process_pids = @() }
    }

    $manifest = [ordered]@{
        schema_version = 1
        group_id = $groupId
        repo_root = $RepoRoot
        generated_at = [DateTimeOffset]::Now.ToString("o")
        api_host = $ApiHost
        api_port = $ApiPort
        api_ownership_mode = $ApiOwnership
        processes = $manifestEntries
    }
    $manifestPath = Write-Manifest -Manifest $manifest

    Write-Host ""
    if ($startedCount -eq 0) {
        Write-Host "All logical roles are already running; no new windows were opened." -ForegroundColor Green
    } else {
        Write-Host "Started $startedCount missing logical role(s); existing healthy roles were reused." -ForegroundColor Green
    }
    Write-Host "Process manifest: $manifestPath"
    Write-Host "Use -Action Status for a read-only ownership check."
    Write-Host "Keep Redis, Next.js, and tunnels running separately as described in docs/local_dev_startup.md."
} finally {
    if ($lockTaken) {
        $mutex.ReleaseMutex()
    }
    $mutex.Dispose()
}
