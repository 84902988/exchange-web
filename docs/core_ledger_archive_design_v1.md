# Core Ledger Archive Design V1

Date: 2026-06-19

Scope: read-only audit and archive design for core ledger / trading history tables. This document does not create tables, migrate data, delete data, or change trading, funds, orders, withdrawals, collection, contract, dividend, BD, or invite business logic.

## 1. Read-Only Evidence

Evidence was collected with read-only SQL and static source inspection:

- `information_schema.tables`
- `information_schema.columns`
- `information_schema.key_column_usage`
- `information_schema.statistics`
- grouped `SELECT status, COUNT(*)`
- `SHOW CREATE TABLE <target>`
- model/source inspection for status enums and semantic ID references

No `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, DDL, migration, or cleanup execution was run.

Target tables:

| Table | Exact count | Earliest created_at | Latest created_at |
| --- | ---: | --- | --- |
| balance_logs | 285,457 | 2026-01-10 01:00:00 | 2026-06-17 20:11:21 |
| orders | 140,955 | 2026-03-25 11:24:20 | 2026-06-17 13:56:44 |
| trades | 140,623 | 2026-03-26 18:19:57 | 2026-06-17 21:56:44 |
| contract_margin_logs | 1,317 | 2026-05-03 03:46:56 | 2026-06-17 20:10:22 |
| contract_orders | 565 | 2026-05-03 03:46:56 | 2026-06-17 20:10:22 |
| contract_trades | 519 | 2026-05-03 03:46:56 | 2026-06-17 20:10:22 |
| contract_positions | 260 | 2026-05-03 03:46:56 | 2026-06-17 20:09:28 |
| deposits | 137 | 2026-02-04 04:58:19 | 2026-06-17 17:51:37 |
| withdraw_logs | 131 | 2026-02-04 05:07:18 | 2026-06-17 20:10:37 |

`information_schema.table_rows` is an InnoDB estimate; exact counts above came from `COUNT(*)`.

## 2. Foreign Key Audit

Current DB-enforced foreign keys touching the target tables:

| Table | Column | References | Impact |
| --- | --- | --- | --- |
| orders | trading_pair_id | trading_pairs.id | Hot `orders` rows depend on hot reference data. |
| orders | fee_asset_id | assets.id | Hot `orders` rows depend on hot asset data. |

`SHOW CREATE TABLE` confirmed no DB-enforced foreign key lines for:

- trades
- contract_orders
- contract_trades
- contract_margin_logs
- deposits
- withdraw_logs
- contract_positions

No current DB-enforced foreign key depends on `orders` or `trades`.

Important model/schema drift:

- The SQLAlchemy `Trade` model declares `ForeignKey("orders.id")` for `buy_order_id` and `sell_order_id`.
- The current MySQL `trades` table does not have DB-enforced FK constraints.
- Archive V2 must treat the live database as the source of truth for migration safety, and separately decide whether model-declared but unenforced relationships should be preserved as semantic references only.

## 3. Semantic Dependencies

Even without DB-enforced FK constraints, hot-table migrate-out can break application joins or admin lookup screens if semantic ID references are not handled.

Semantic order/trade references found by column scan:

| Table | Columns | Notes |
| --- | --- | --- |
| trades | buy_order_id, sell_order_id, maker_order_id, taker_order_id | Spot trades semantically depend on spot orders. |
| balance_logs | trade_id | Ledger rows may link to spot trade IDs. |
| bd_commission_records | order_id, trade_id | BD commission records may link to spot order/trade IDs. |
| user_invite_commission_records | order_id, trade_id | Invite commission records may link to spot order/trade IDs. |
| dealer_risk_hit_logs | order_id | Risk logs may link to spot order IDs. |
| contract_trades | order_id, trade_no | Contract trades semantically depend on contract orders. |
| contract_margin_logs | order_id, trade_id | Contract margin ledger semantically depends on contract order/trade IDs. |
| orders | order_no | External lookup key. |
| contract_orders | order_no | External lookup key. |

Design conclusion:

- Moving rows out of hot `orders` / `trades` will not break current DB FK constraints.
- It can break application lookups unless query layers know how to search both hot and archive storage.
- V2 archive must provide hot-plus-archive lookup by `order_no`, `trade_id`, `user_id`, and date before any hot-table migrate-out.

## 4. Terminal Status Audit

Status values observed in current DB:

| Table | Observed status values |
| --- | --- |
| balance_logs | No status column |
| trades | No status column |
| contract_trades | No status column |
| contract_margin_logs | No status column |
| orders | FILLED 140,743; CANCELED 200; FAILED 6; OPEN 5; PARTIALLY_FILLED 1 |
| contract_orders | FILLED 519; CANCELED 45; OPEN 1 |
| contract_positions | CLOSED 248; LIQUIDATED 7; OPEN 5 |
| deposits | CONFIRMED 134; DETECTING 3 |
| withdraw_logs | SUCCESS 55; VERIFYING 27; CANCELED 25; REJECTED 10; FROZEN 7; FAILED 5; SENT 2 |

Recommended archive eligibility by table:

| Table | Archivable statuses | Do not archive statuses | Notes |
| --- | --- | --- | --- |
| balance_logs | No status; only archive by cold period after related business is terminal | N/A | Ledger rows are immutable. Use strict date window and reconciliation. |
| trades | No status; archive by cold period and linked orders terminal | N/A | Must preserve lookup by trade ID and linked order IDs. |
| contract_trades | No status; archive by cold period and linked order/position terminal | N/A | Must preserve lookup by trade_no, order_id, position_id. |
| contract_margin_logs | No status; archive by cold period and linked order/position terminal | N/A | Must reconcile margin sums before migrate-out. |
| orders | FILLED, CANCELED, FAILED | OPEN, PARTIALLY_FILLED, NEW if introduced | Require age threshold and no open liabilities. |
| contract_orders | FILLED, CANCELED, FAILED | NEW, OPEN, PARTIALLY_FILLED if introduced | Contract order enum supports NEW/OPEN/FILLED/CANCELED/FAILED. |
| contract_positions | CLOSED, LIQUIDATED | OPEN | Never archive open positions from hot table. |
| deposits | CONFIRMED, FAILED/CANCELED if introduced and terminal | DETECTING, PENDING-like states | Current table has DETECTING and CONFIRMED. |
| withdraw_logs | SUCCESS, CANCELED, REJECTED, FAILED | VERIFYING, FROZEN, SENT, PENDING, APPROVED, BROADCASTING | SENT still needs chain watcher finality. FROZEN may still hold funds. |

Archive should use both status and time:

- Recommended hot retention: 12 to 24 months for orders/trades/balance logs/contract tables.
- Deposits and withdraw logs: 24 months is safer.
- Never archive rows newer than the configured hot-retention window, even if terminal.

## 5. Index Audit

Current index coverage summary:

| Table | Present key coverage | Missing / weak coverage |
| --- | --- | --- |
| balance_logs | user_id + created_at; biz_id; request_id; biz_type + created_at; change_type + created_at; created_at + id | coin_symbol + created_at is not directly covered; current index is coin_symbol + chain_key + created_at. |
| orders | user_id + created_at; trading_pair_id + created_at; status + created_at; order_no | Good for V1 archive candidate scans and lookups. |
| trades | buyer_user_id + created_at; seller_user_id + created_at; trading_pair_id + created_at; buy/sell order ID | Good for V1 archive candidate scans and lookups. |
| contract_orders | user_id + created_at; symbol + created_at; status + created_at; order_no | Good for V1 archive candidate scans and lookups. |
| contract_trades | user_id + created_at; symbol + created_at; order_id + created_at; position_id + created_at; trade_no | Good for V1 archive candidate scans and lookups. |
| contract_margin_logs | created_at; user_id; symbol column exists but no symbol + created_at | Missing user_id + created_at and symbol + created_at. |
| contract_positions | user_id; symbol; status; user_id + symbol + status | Missing user_id + created_at, symbol + created_at, status + created_at. |
| deposits | user_id + created_at; chain_key + txid + log_index; status-only | Missing status + created_at. `tx_hash` does not exist; actual field is `txid`. |
| withdraw_logs | status + created_at; tx_hash; created_at + id | Missing user_id + created_at. |

Index recommendations only; do not add in this phase:

| Priority | Table | Suggested index | Reason |
| --- | --- | --- | --- |
| P1 | contract_margin_logs | user_id, created_at | Admin and archive scans by user/date. |
| P1 | contract_margin_logs | symbol, created_at | Contract ledger archive and symbol-date queries. |
| P1 | withdraw_logs | user_id, created_at | User withdrawal history and archive candidate scans. |
| P1 | deposits | status, created_at | Terminal deposit archive scans. |
| P2 | deposits | txid | Only if admin/search often queries txid without chain_key/log_index. |
| P2 | balance_logs | coin_symbol, created_at | Only if coin-only date queries are common without chain_key. |
| P2 | contract_positions | status, created_at | Closed/liquidated position archive candidate scans. |
| P2 | contract_positions | user_id, created_at | User position archive/history queries. |
| P2 | contract_positions | symbol, created_at | Symbol/date archive scans. |

## 6. Archive Table Design

Recommended naming:

| Source table | Archive table |
| --- | --- |
| balance_logs | archive_balance_logs |
| orders | archive_orders |
| trades | archive_trades |
| contract_orders | archive_contract_orders |
| contract_trades | archive_contract_trades |
| contract_margin_logs | archive_contract_margin_logs |
| deposits | archive_deposits |
| withdraw_logs | archive_withdraw_logs |
| contract_positions | archive_contract_positions |

Recommended archive table structure:

- Copy source table columns with the same data types.
- Preserve original `id`, `order_no`, `trade_no`, `tx_hash` / `txid`, and business identifiers.
- Add archive metadata columns:
  - `archive_month` such as `2026-03`; alternatively `DATE` set to the first day of the month.
  - `archive_batch_id` as a stable batch ID.
  - `archived_at`.
- Keep lookup indexes needed by admin/customer support:
  - `id`
  - `user_id + created_at`
  - `created_at + id`
  - `archive_month`
  - `archive_batch_id`
  - business keys such as `order_no`, `trade_no`, `tx_hash` / `txid`, `request_id`, `biz_id`.

Foreign keys on archive tables:

- Do not add DB-enforced foreign keys in V1 archive tables.
- Store original IDs as immutable reference values.
- Reason: source rows may later move out of hot tables while reference rows may remain hot or archive at different times. Enforced FKs across hot/archive tables create brittle migration ordering.

Unique constraints on archive tables:

- Preserve uniqueness where it protects lookup integrity, such as `order_no` and `trade_no`.
- For copied source IDs, either keep `id` as primary key inside each archive table or use a composite unique key such as `(archive_batch_id, id)`.
- Recommended V1: keep original `id` as primary key in each archive table because each archive table stores rows from only one source table.

## 7. Archive Manifest / Batch Table Design

Recommended table: `core_archive_batches`

Suggested fields:

| Field | Purpose |
| --- | --- |
| id | Primary key. |
| batch_id | Stable external batch identifier. |
| source_table | Source hot table name. |
| archive_table | Target archive table name. |
| archive_month | Month being archived. |
| period_start | Inclusive source time window. |
| period_end | Exclusive source time window. |
| status | DRY_RUN, COPYING, COPIED, VERIFYING, VERIFIED, APPROVED, MIGRATING_OUT, COMPLETED, FAILED, CANCELED. |
| dry_run | Whether the batch is non-mutating. |
| source_count | Count from hot source for the batch window. |
| copied_count | Count inserted/copied into archive. |
| verified_count | Count verified after copy. |
| deleted_count | Rows migrated out of hot table after manual approval. |
| min_id | Minimum source ID in batch. |
| max_id | Maximum source ID in batch. |
| checksum_json | Checksums by key columns, e.g. ID hash ranges or CRC summaries. |
| sum_json | Decimal sum checks, e.g. amount, fee, quote_amount, margin_amount, pnl fields. |
| started_at | Batch start time. |
| finished_at | Batch finish time. |
| error_message | Failure reason. |
| created_by | Operator or job identity. |
| approved_by | Manual approver identity. |
| approved_at | Manual approval time. |

Manifest rules:

- One batch should cover one source table and one archive month.
- Re-running a batch must be idempotent.
- Copy-only batches must never delete hot rows.
- Migrate-out must require manual approval and independent verification.

## 8. Archive Flow

### 8.1 Dry-run

Read-only stage.

Steps:

1. Select eligible month and source table.
2. Apply terminal status rules.
3. Apply hot-retention threshold.
4. Count rows.
5. Compute `min_id`, `max_id`.
6. Compute decimal sums and checksum preview.
7. Report semantic dependencies for the selected window.

No DB writes should occur in dry-run unless a future operator explicitly enables manifest logging. For the current design phase, dry-run is conceptual only.

### 8.2 Copy-only

Write only to archive tables and manifest, never delete from hot tables.

Steps:

1. Create or reuse archive table for the source.
2. Insert eligible rows in batches.
3. Populate archive metadata columns.
4. Record copied counts.
5. Leave hot rows untouched.

### 8.3 Verify

Read-only verification after copy.

Checks:

- `source_count == copied_count`.
- `min_id` and `max_id` match.
- Key checksum matches.
- Decimal sums match:
  - balance_logs: change_amount, before/after balances by direction.
  - orders: amount, filled_amount, frozen_amount, fee_amount.
  - trades: amount, quote_amount, fee fields.
  - contract tables: quantity, margin_amount, fee_amount, spread_fee, realized_pnl where present.
  - deposits / withdraw_logs: amount, fee, net_amount.
- Random sample rows match field-by-field.

### 8.4 Manual Approve

Human approval gate.

Requirements:

- Verification passed.
- Backup exists.
- Product/support query path for archive data is available.
- Operations confirms the archive window.
- Finance confirms no active reconciliation task needs those hot rows.

### 8.5 Hot Table Migrate-out

This is not deletion from business history. It is moving already-copied, verified cold rows out of hot storage.

Rules:

- Only after manual approval.
- Batch by primary key range.
- Hard cap per batch.
- Require exact `source_table`, `period_start`, `period_end`, `archive_batch_id`, and terminal status predicate.
- Never run against open / pending / detecting / sent / frozen states.
- Record `deleted_count` in manifest.
- Stop immediately on count mismatch.
- Keep rollback plan and backup reference.

## 9. Query Layer Requirements Before Migrate-out

Do not migrate out hot rows until these read paths support archive lookup:

- Admin order lookup by `order_no`.
- Admin trade lookup by trade ID and order ID.
- User order/trade history beyond hot retention.
- Balance log lookup by user, `biz_id`, `request_id`, `trade_id`.
- Deposit lookup by `txid`.
- Withdrawal lookup by `tx_hash`.
- Contract order/trade/position lookup by user, symbol, order_no, trade_no.
- Commission/risk lookup paths that link to `order_id` or `trade_id`.

Recommended query pattern:

- Default hot-table query for recent data.
- Archive query only when the requested date range is outside hot retention or a precise identifier is supplied.
- No deep offset pagination across hot-plus-archive data in V1; plan keyset pagination in V2.

## 10. V1 Conclusions

No immediate FK blocker exists in the current DB for moving rows out of `orders` or `trades`, because no table currently has DB-enforced FK dependencies on them.

There is still significant semantic dependency risk. `trades`, `balance_logs`, commission records, risk logs, contract trades, and contract margin logs all store order/trade IDs. Archive V2 must preserve lookup behavior across hot and archive storage before any hot-table migrate-out.

Safe V1 design position:

- Do not use the cleanup job for core ledger tables.
- Do not delete core ledger data.
- Build archive tables as same-structure copies plus archive metadata.
- Use copy-only first.
- Verify by counts, checksums, and sums.
- Require manual approval before any hot-table migrate-out.
- Treat archive as long-term retention, not data removal.

## 11. Next Steps for Archive V2

Recommended implementation order:

1. Add read-only archive dry-run command.
2. Add `core_archive_batches` manifest migration.
3. Add archive table DDL generator for one pilot table, preferably `orders` or `trades`.
4. Add copy-only job with `dry_run=true` default.
5. Add verification command.
6. Add admin read-only archive batch page.
7. Add hot-plus-archive lookup for precise identifiers.
8. Only then design migrate-out, with manual approval and backup requirements.
