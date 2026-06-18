param(
    [string]$ApiHost = "127.0.0.1",
    [int]$ApiPort = 8000,
    [string]$PythonExe = "",
    [switch]$Reload
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BackendDir = Split-Path -Parent $ScriptDir
$RepoRoot = Split-Path -Parent $BackendDir

if (-not $PythonExe) {
    $VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $VenvPython) {
        $PythonExe = $VenvPython
    } else {
        $PythonExe = "python"
    }
}

function Quote-ForPowerShell {
    param([string]$Value)
    return "'" + ($Value -replace "'", "''") + "'"
}

function Start-DevProcess {
    param(
        [string]$Title,
        [string]$WorkingDirectory,
        [string]$Command
    )

    $SafeTitle = $Title -replace "'", "''"
    $SafeWorkingDirectory = Quote-ForPowerShell $WorkingDirectory
    $WindowCommand = @"
`$Host.UI.RawUI.WindowTitle = '$SafeTitle'
Set-Location -LiteralPath $SafeWorkingDirectory
$Command
"@

    Start-Process `
        -FilePath "powershell.exe" `
        -ArgumentList @("-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", $WindowCommand) `
        -WorkingDirectory $WorkingDirectory
}

$QuotedPython = Quote-ForPowerShell $PythonExe
$ReloadArgs = ""
if ($Reload) {
    $ReloadArgs = " --reload --reload-dir app --reload-exclude '../tmp/pdfs/*' --reload-exclude '../tmp/*' --reload-exclude 'tmp/*' --reload-exclude '../output/*'"
}
$RqScript = Join-Path $RepoRoot "backend\scripts\start_rq_worker.py"
if (-not (Test-Path -LiteralPath $RqScript)) {
    throw "Missing RQ worker script: $RqScript"
}
$QuotedRqScript = Quote-ForPowerShell $RqScript
$WithdrawFeeSchedulerScript = Join-Path $RepoRoot "backend\scripts\start_withdraw_fee_scheduler.py"
if (-not (Test-Path -LiteralPath $WithdrawFeeSchedulerScript)) {
    throw "Missing withdraw fee scheduler script: $WithdrawFeeSchedulerScript"
}
$QuotedWithdrawFeeSchedulerScript = Quote-ForPowerShell $WithdrawFeeSchedulerScript
$CollectionAutoSchedulerScript = Join-Path $RepoRoot "backend\scripts\start_collection_auto_scheduler.py"
if (-not (Test-Path -LiteralPath $CollectionAutoSchedulerScript)) {
    throw "Missing collection auto scheduler script: $CollectionAutoSchedulerScript"
}
$QuotedCollectionAutoSchedulerScript = Quote-ForPowerShell $CollectionAutoSchedulerScript
$DealerLoopScript = Join-Path $RepoRoot "backend\scripts\start_dealer_loop.py"
if (-not (Test-Path -LiteralPath $DealerLoopScript)) {
    throw "Missing dealer loop script: $DealerLoopScript"
}
$QuotedDealerLoopScript = Quote-ForPowerShell $DealerLoopScript
$LiquidationScannerScript = Join-Path $RepoRoot "backend\scripts\start_liquidation_scanner.py"
if (-not (Test-Path -LiteralPath $LiquidationScannerScript)) {
    throw "Missing liquidation scanner script: $LiquidationScannerScript"
}
$QuotedLiquidationScannerScript = Quote-ForPowerShell $LiquidationScannerScript
$TpSlScannerScript = Join-Path $RepoRoot "backend\scripts\start_tp_sl_scanner.py"
if (-not (Test-Path -LiteralPath $TpSlScannerScript)) {
    throw "Missing TP/SL scanner script: $TpSlScannerScript"
}
$QuotedTpSlScannerScript = Quote-ForPowerShell $TpSlScannerScript
$ContractLimitOrderScannerScript = Join-Path $RepoRoot "backend\scripts\start_contract_limit_order_scanner.py"
if (-not (Test-Path -LiteralPath $ContractLimitOrderScannerScript)) {
    throw "Missing contract limit order scanner script: $ContractLimitOrderScannerScript"
}
$QuotedContractLimitOrderScannerScript = Quote-ForPowerShell $ContractLimitOrderScannerScript
$ContractAccountingReconciliationSchedulerScript = Join-Path $RepoRoot "backend\scripts\start_contract_accounting_reconciliation_scheduler.py"
if (-not (Test-Path -LiteralPath $ContractAccountingReconciliationSchedulerScript)) {
    throw "Missing contract accounting reconciliation scheduler script: $ContractAccountingReconciliationSchedulerScript"
}
$QuotedContractAccountingReconciliationSchedulerScript = Quote-ForPowerShell $ContractAccountingReconciliationSchedulerScript

Write-Host "Starting local development processes..."
Write-Host "Repo root: $RepoRoot"
Write-Host "Python: $PythonExe"
Write-Host ""

Start-DevProcess `
    -Title "exchange FastAPI :$ApiPort" `
    -WorkingDirectory $BackendDir `
    -Command "& $QuotedPython -m uvicorn app.main:app --host $ApiHost --port $ApiPort --access-log$ReloadArgs"

Start-DevProcess `
    -Title "exchange RQ collection/gas/tx_confirm/withdraw" `
    -WorkingDirectory $RepoRoot `
    -Command "& $QuotedPython $QuotedRqScript collection gas tx_confirm withdraw"

Start-DevProcess `
    -Title "exchange RQ email" `
    -WorkingDirectory $RepoRoot `
    -Command "& $QuotedPython $QuotedRqScript email"

Start-DevProcess `
    -Title "exchange RQ payout" `
    -WorkingDirectory $RepoRoot `
    -Command "& $QuotedPython $QuotedRqScript payout"

Start-DevProcess `
    -Title "exchange RQ release" `
    -WorkingDirectory $RepoRoot `
    -Command "& $QuotedPython $QuotedRqScript release"

Start-DevProcess `
    -Title "exchange RQ maintenance" `
    -WorkingDirectory $RepoRoot `
    -Command "& $QuotedPython $QuotedRqScript maintenance"

Start-DevProcess `
    -Title "exchange withdraw fee scheduler" `
    -WorkingDirectory $RepoRoot `
    -Command "& $QuotedPython $QuotedWithdrawFeeSchedulerScript"

Start-DevProcess `
    -Title "exchange collection auto scheduler" `
    -WorkingDirectory $RepoRoot `
    -Command "& $QuotedPython $QuotedCollectionAutoSchedulerScript"

Start-DevProcess `
    -Title "exchange dealer loop" `
    -WorkingDirectory $RepoRoot `
    -Command "& $QuotedPython $QuotedDealerLoopScript"

Start-DevProcess `
    -Title "exchange liquidation scanner" `
    -WorkingDirectory $RepoRoot `
    -Command "& $QuotedPython $QuotedLiquidationScannerScript"

Start-DevProcess `
    -Title "exchange TP SL scanner" `
    -WorkingDirectory $RepoRoot `
    -Command "& $QuotedPython $QuotedTpSlScannerScript"

Start-DevProcess `
    -Title "exchange contract limit order scanner" `
    -WorkingDirectory $RepoRoot `
    -Command "& $QuotedPython $QuotedContractLimitOrderScannerScript"

Start-DevProcess `
    -Title "exchange contract accounting reconciliation scheduler" `
    -WorkingDirectory $RepoRoot `
    -Command "& $QuotedPython $QuotedContractAccountingReconciliationSchedulerScript"

Write-Host "Started FastAPI, RQ worker, scheduler, loop, and scanner windows."
Write-Host "Keep Redis, Next.js, and cpolar tunnels running separately as described in docs/local_dev_startup.md."
