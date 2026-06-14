# RQ Migration Status

This document locks the current RQ boundary. It is an audit snapshot, not a migration plan that changes runtime behavior.

## Current Queue List

`backend/app/core/rq.py` defines exactly these queues:

- `collection`
- `gas`
- `tx_confirm`
- `email`
- `release`
- `payout`
- `maintenance`

No RQ queue is defined for:

- `trading`
- `liquidation`
- `withdraw_watcher`
- `dealer_loop`
- `tp_sl`
- `contract_limit_scanner`

## RQ-Ready Tasks

Current task modules:

- `backend/app/tasks/collection_tasks.py`
  - `collection`
  - `gas`
  - `tx_confirm`
- `backend/app/tasks/email_tasks.py`
  - `email`
- `backend/app/tasks/stock_token_release_tasks.py`
  - `release`
- `backend/app/tasks/user_invite_commission_tasks.py`
  - `payout`
- `backend/app/tasks/bd_commission_tasks.py`
  - `payout`
- `backend/app/tasks/dividend_tasks.py`
  - `payout` wrapper only; not wired into live dividend distribution.
- `backend/app/jobs/withdraw_fee_maintenance_rq_job.py`
  - `maintenance`

## Not RQ-Migrated

These flows remain on their existing execution paths:

- Withdraw watcher
- Dealer loop / dealer risk loop
- Contract liquidation scanner
- Contract TP/SL scanner
- Contract limit order scanner
- Spot matching loop
- Dividend pool distribution path

## High-Frequency Tasks Not To Move To RQ

Do not migrate these into generic RQ workers without a separate design:

- Trading / matching loops
- Dealer quote or dealer depth loops
- Liquidation scanner
- TP/SL scanner
- Contract limit order scanner
- Withdraw watcher

These jobs have timing, ordering, market-data, or settlement semantics that should be handled outside the current low-frequency RQ task bus.

## Payout Boundary

The `payout` queue currently covers discrete, record-based database payout wrappers:

- Ordinary invite commission single-record payout job
- BD commission single-record payout job
- Dividend single-record payout wrapper placeholder

Admin behavior:

- Ordinary invite commission:
  - Single-record admin payout stays synchronous.
  - Batch admin payout enqueues one payout job per pending record.
- BD commission:
  - Single-record admin payout stays synchronous.
  - Batch admin payout enqueues one payout job per pending record.
- Dividend:
  - Admin pool distribution is unchanged.
  - Automatic dividend job is unchanged.
  - The RQ wrapper does not perform real payout unless a future single-record dividend service is added.

## Dividend Placeholder Status

`backend/app/tasks/dividend_tasks.py` exists to reserve the single-record RQ integration point.

The current service layer does not expose a single-record dividend payout service such as:

- `pay_user_dividend_record`
- `distribute_user_dividend_record`
- `pay_dividend_record`

Because of that, the wrapper checks record state and returns a non-retryable failure for pending records instead of reimplementing balance changes. This preserves the existing dividend pool distribution semantics.

## Collection Boundary

RQ collection and gas task processing defaults to dry-run behavior. Real send still requires the guarded admin single-record endpoints and the existing real-send confirmation environment settings.

Current boundary:

- Automatic worker path does not allow real sends by default.
- Real collection send remains a guarded admin single-task action.
- Real gas send remains a guarded admin single-task action.
- There is no batch real-send endpoint.

## Worker Startup

Generic worker:

```powershell
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py
```

No arguments means all configured queues.

Targeted workers:

```powershell
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py collection gas tx_confirm
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py email
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py payout
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py release
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py maintenance
```

Withdraw fee maintenance is queued explicitly:

```powershell
.venv\Scripts\python.exe backend\scripts\enqueue_withdraw_fee_maintenance.py
```

The periodic enqueue loop runs outside FastAPI:

```powershell
.venv\Scripts\python.exe backend\scripts\start_withdraw_fee_maintenance_scheduler.py
```

Legacy worker:

```powershell
.venv\Scripts\python.exe backend\scripts\start_collection_worker.py
```

The legacy script remains available and still loads `QUEUE_NAMES` with `SimpleWorker`.

## Next-Stage Candidates

For the next global go-live technical closeout:

- Confirm Redis deployment, persistence, and monitoring.
- Define production worker process counts by queue.
- Add operational dashboards or logs for failed RQ jobs.
- Decide whether dividend distribution should remain pool-synchronous or gain a true single-record service first.
- Review payout worker concurrency after database lock behavior is verified.
- Add restart and drain procedures to deployment automation.

## Current Conclusion

RQ is ready as a bounded task bus for collection, gas, transaction confirmation, email, release, maintenance, and discrete payout jobs.

The current phase does not migrate high-frequency trading or risk loops, does not change balance semantics, does not change chain-send safeguards, and does not alter existing dividend execution paths.
