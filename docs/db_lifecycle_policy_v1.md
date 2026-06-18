# DB Lifecycle Policy V1

Date: 2026-06-19

This document defines the first-phase database lifecycle controls for the admin backend. It does not change trading, fund, order, withdrawal, collection, contract, dividend, BD, or invite core business logic.

## Scope

V1 includes:

- Admin large-table query default time ranges.
- Dry-run first cleanup job for non-core operational logs.
- Read-only review for `market_klines` and `stock_token_release_logs`.
- Policy notes for V2 archive and keyset pagination.

V1 does not include:

- Deleting or archiving core accounting tables.
- Changing order/trade/fund business semantics.
- Adding unique indexes to production data tables.
- Keyset pagination migration.

## Table Categories

### A. Core Accounting Tables

Do not directly delete these tables in V1. Archive only after a separate reviewed migration plan.

- `balance_logs`
- `orders`
- `trades`
- `contract_orders`
- `contract_trades`
- `contract_margin_logs`
- `deposits`
- `withdraw_logs`
- `user_balances`
- dividend payout records
- BD commission records
- invite commission records
- platform adjust logs

Recommended policy:

- Keep online for 12 to 24 months.
- Archive by month after the online retention window.
- Admin queries default to recent 7 days.
- Queries over 30 days must include a precise condition such as `user_id`, `order_no`, `trade_id`, `tx_hash`, `request_id`, `biz_id`, `status`, or `symbol`.

### B. Operational Audit Tables

Examples:

- `audit_logs`
- login logs
- risk/review logs

Recommended policy:

- Long-term retain or archive.
- Default admin query window is recent 7 days.
- Queries over 30 days must include precise conditions.

### C. Technical Job Logs

Examples:

- `dividend_job_logs`
- `bd_commission_job_logs`
- `stock_token_release_logs`
- collection/gas/confirm task logs

Recommended policy:

- Success logs: retain 90 days.
- Failure logs: retain 180 days.
- Keep failed records longer for diagnosis.
- Reduce no-op log writes in later versions.

### D. Access Control / Security Event Summary

Examples:

- `geo_access_logs`

Recommended policy:

- Retain 90 days.
- Store only meaningful BLOCK/MONITOR/allowlist/blocklist/blocked UNKNOWN events.
- Keep ordinary ALLOW out of the log table.

### E. Temporary Data

Examples:

- `user_otps`
- expired sessions/tokens

Recommended policy:

- OTP: retain 30 days.
- Sessions: retain 90 days, or clean rows expired for more than 30 days.

### F. Rebuildable Cache / Market Cache

Examples:

- short-term quote cache
- external ticker cache

Recommended policy:

- Rebuildable cache can be cleaned or overwritten.
- Formal K-line data must not be deleted casually.

## Admin Query Range Standard

For large admin pages, V1 applies:

- Default range: recent 7 days.
- Quick ranges: recent 7 days, 15 days, 30 days.
- Range over 30 days requires at least one precise condition:
  - `user_id`
  - `order_no`
  - `trade_id`
  - `tx_hash`
  - `request_id`
  - `biz_id`
  - `status`
  - `symbol`
- If a query exceeds 30 days without a precise condition, the backend narrows it to the latest 30 days and displays a notice.
- Page size remains capped at 100 for these admin list queries.
- V1 keeps offset pagination. V2 should migrate high-volume pages to keyset pagination.

Pages covered in V1:

- `balance_logs`
- `orders`
- `trades`
- `contract_orders`
- `contract_trades`
- `deposits`
- `withdraw_logs`
- `audit_logs`
- `dividend_job_logs`
- `bd_commission_job_logs`
- `stock_token_release_logs`

## Cleanup Job V1

V1.1 maintenance integration:

- Scheduler entry: `backend/scripts/start_db_lifecycle_cleanup_scheduler.py`
- Manual enqueue entry: `backend/scripts/enqueue_db_lifecycle_cleanup.py`
- Worker entry: `run_db_lifecycle_cleanup_job`
- Queue: `maintenance`
- Result table: `db_lifecycle_cleanup_logs`
- Admin view: `/admin/system/db-lifecycle`

Safe default config:

```env
DB_LIFECYCLE_CLEANUP_ENABLED=false
DB_LIFECYCLE_CLEANUP_DRY_RUN=true
DB_LIFECYCLE_CLEANUP_ALLOW_EXECUTE=false
DB_LIFECYCLE_CLEANUP_EXECUTE_CONFIRM=
DB_LIFECYCLE_CLEANUP_RETENTION_DAYS=90
DB_LIFECYCLE_CLEANUP_ENQUEUE_INTERVAL_SECONDS=86400
```

Scheduler behavior:

- `DB_LIFECYCLE_CLEANUP_ENABLED=false`: do not enqueue.
- `DB_LIFECYCLE_CLEANUP_ENABLED=true`: enqueue at most once per interval window.
- Worker rereads `DB_LIFECYCLE_CLEANUP_DRY_RUN` when the job executes.
- Scheduler defaults to dry-run. It can request execute only when `DB_LIFECYCLE_CLEANUP_ALLOW_EXECUTE=true`, `DB_LIFECYCLE_CLEANUP_DRY_RUN=false`, and `DB_LIFECYCLE_CLEANUP_EXECUTE_CONFIRM=DELETE_NON_CORE_TEMP_DATA`.
- Dry-run records matched rows but deletes zero rows.
- Each table writes one `db_lifecycle_cleanup_logs` row with matched/deleted/status/error.

V1.2 execute guard:

- Real execution requires confirm text: `DELETE_NON_CORE_TEMP_DATA`.
- `scripts/run_db_lifecycle_cleanup.py --execute` refuses to run unless `--confirm DELETE_NON_CORE_TEMP_DATA` is also passed.
- Even with confirm, execution is still blocked unless env/config explicitly allows execute.
- Execute log rows must be marked with `operation_mode=EXECUTE` and `risk_level=REAL_DELETE`.
- Dry-run log rows use `operation_mode=DRY_RUN` and `risk_level=SAFE_DRY_RUN`.

Manual entry:

```powershell
cd D:\exchange-web\backend
..\.venv\Scripts\python.exe scripts\run_db_lifecycle_cleanup.py
```

Default mode is dry-run. Real deletion requires:

```powershell
cd D:\exchange-web\backend
..\.venv\Scripts\python.exe scripts\run_db_lifecycle_cleanup.py --execute --confirm DELETE_NON_CORE_TEMP_DATA
```

Dry-run output includes:

- `table_name`
- `matched_count`
- `deleted_count`
- `retention_days`
- `dry_run`
- `status`
- `operation_mode`
- `risk_level`
- `error`

Safety rules:

- Default `dry_run=true`.
- Batch size is capped at 1000 rows.
- Each table is handled independently.
- Failure on one table does not block other tables.
- No `TRUNCATE`.
- No deletion without a `WHERE` predicate.
- Only allowlisted non-core operational tables are eligible.
- Cleanup result rows are operational logs and may be reviewed in `/admin/system/db-lifecycle`.

## V1.2 Safety Incident Note

During V1.1 validation, a low-level cleanup function was called with `dry_run=false` while testing protected-table behavior. It deleted eligible non-core temporary rows:

- `user_otps`: 22 rows
- `user_sessions`: 555 rows

Read-only follow-up confirmed:

- core accounting/trading tables were unchanged;
- `balance_logs` was unchanged;
- protected table attempts were logged as `SKIPPED / PROTECTED_CORE_TABLE`.

V1.2 guardrails added after the deviation:

- low-level cleanup defaults back to dry-run unless an approved wrapper passes `allow_execute=true`;
- execute requires confirm text `DELETE_NON_CORE_TEMP_DATA`;
- scheduler defaults to dry-run and needs explicit env/config to request execute;
- execute records must be visibly marked as `EXECUTE / REAL_DELETE`.

Allowed cleanup in V1:

| Table | Rule |
| --- | --- |
| `user_otps` | `created_at` older than 30 days |
| `user_sessions` | `created_at` older than 90 days, or `expires_at` older than 30 days |
| `geo_access_logs` | `last_seen_at` older than 90 days |
| `dividend_job_logs` | `SUCCESS` older than 90 days, `FAILED` older than 180 days |
| `bd_commission_job_logs` | `SUCCESS` older than 90 days, `FAILED` older than 180 days |
| `stock_token_release_logs` | `SUCCESS` / `NOOP` older than 90 days, `FAILED` older than 180 days |

Forbidden cleanup in V1:

- `balance_logs`
- `orders`
- `trades`
- `contract_orders`
- `contract_trades`
- `contract_margin_logs`
- `deposits`
- `withdraw_logs`
- `user_balances`
- dividend payout records
- `bd_commission_records`
- invite commission records
- platform adjust logs

## market_klines Read-Only Review

Read-only check result on 2026-06-19:

- Duplicate groups for `symbol + interval + open_time`: `0`
- Existing indexes:
  - `idx_market_klines_symbol_interval_open`: `symbol, interval, open_time`
  - `idx_market_klines_market_symbol_interval_open`: `market_type, symbol, interval, open_time`
  - `uq_market_klines_market_symbol_interval_open`: unique `market_type, symbol, interval, open_time`
- Missing suggested index for created-at range review:
  - `symbol, interval, created_at`

Recommendation:

- Do not delete K-line data in V1.
- Do not add a new unique index in V1.
- Consider adding `symbol + interval + created_at` in a separate index migration if admin/report queries use created-at windows.

## stock_token_release_logs Read-Only Review

Recent 30-day growth highlights:

| Date | Count | Zero Release | Real Release |
| --- | ---: | ---: | ---: |
| 2026-06-17 | 5 | 4 | 1 |
| 2026-06-07 | 2 | 0 | 2 |
| 2026-06-04 | 3 | 1 | 2 |
| 2026-06-02 | 7400 | 7398 | 2 |
| 2026-06-01 | 1556 | 1556 | 0 |
| 2026-05-31 | 530 | 530 | 0 |
| 2026-05-30 | 951 | 950 | 1 |

Status distribution:

| Status | Count | Released Sum |
| --- | ---: | ---: |
| `ENQUEUED` | 21726 | 0 |
| `SKIPPED` | 10205 | 0 |
| `SUCCESS` | 3571 | 64 |
| `FAILED` | 380 | 0 |

Trigger distribution:

| Trigger Type | Count | Released Sum |
| --- | ---: | ---: |
| `AUTO` | 25637 | 29 |
| `AUTO_RQ` | 10229 | 24 |
| `FORCE` | 11 | 10 |
| `MANUAL` | 5 | 1 |

The current table does not have dedicated `action` or `reason` columns. V1 uses `trigger_type`, `message`, and `error_message` as the read-only evidence for action/reason distribution.

2026-06-02 conclusion:

- Total rows: `7400`
- Zero-release rows: `7398`
- Real-release rows: `2`
- Dominant samples were repeated `SKIPPED / AUTO_RQ / released_count=0` messages:
  - `stock token lock not releasable: 6`
  - `stock token lock release job finished: 7`
  - `stock token lock not releasable: 8`
  - `stock token lock not releasable: 5`
- This looks like repeated no-op / skipped scan logging rather than real release volume.

Recommendation:

- Do not delete in this phase.
- Keep cleanup allowlist limited to old `SUCCESS` / `NOOP` / `FAILED` rows.
- V1.1 reduces database write amplification for no-op scans:
  - write DB logs for real releases where `released_count > 0`;
  - write DB logs for failures or exceptions;
  - skip pure no-op rows where `released_count = 0` and there is no failure;
  - use application debug logs for no-op observability instead of many `stock_token_release_logs` rows.
- V2 may add one aggregated no-op summary row per scheduled run if operators need that view.

## V2 Plan

V2 should include:

- Keyset pagination for high-volume admin pages.
- Monthly archive tables for core accounting data.
- Cold-data export for long-retention compliance records.
- Configurable retention days.
- Worker dashboard for cleanup and archive jobs.
- Reduced write amplification for no-op task logs.
