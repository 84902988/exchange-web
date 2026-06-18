# Core Financial Tables Lifecycle Policy V1

Date: 2026-06-19

This policy protects core accounting and trading ledger tables. It does not migrate data, delete data, or change trading, funds, orders, withdrawal, collection, contract, dividend, BD, or invite business logic.

## Core Protected Tables

| Table | Type | Current Policy | Hot Data Recommendation | Later Handling |
| --- | --- | --- | --- | --- |
| `balance_logs` | 资金流水 | 禁止清理，只允许归档 | 12～24 个月 | 月度归档 / 冷数据迁移 |
| `orders` | 现货订单 | 禁止清理，只允许归档 | 12～24 个月 | 月度归档 / 冷数据迁移 |
| `trades` | 现货成交 | 禁止清理，只允许归档 | 12～24 个月 | 月度归档 / 冷数据迁移 |
| `contract_orders` | 合约订单 | 禁止清理，只允许归档 | 12～24 个月 | 月度归档 / 冷数据迁移 |
| `contract_trades` | 合约成交 | 禁止清理，只允许归档 | 12～24 个月 | 月度归档 / 冷数据迁移 |
| `contract_margin_logs` | 保证金流水 | 禁止清理，只允许归档 | 12～24 个月 | 月度归档 / 冷数据迁移 |
| `deposits` | 充值 | 禁止清理，只允许归档 | 24 个月更稳 | 月度归档 / 冷数据迁移 |
| `withdraw_logs` | 提现 | 禁止清理，只允许归档 | 24 个月更稳 | 月度归档 / 冷数据迁移 |
| `user_balances` | 用户余额 | 禁止清理，只允许归档 | 长期在线 | 仅快照归档 |
| `platform_adjust_logs` | 平台调账 | 禁止清理，只允许归档 | 24 个月更稳 | 月度归档 / 冷数据迁移 |
| `bd_commission_records` | BD 发放记录 | 禁止清理，只允许归档 | 12～24 个月 | 月度归档 / 冷数据迁移 |
| `user_invite_commission_records` | 邀请发放记录 | 禁止清理，只允许归档 | 12～24 个月 | 月度归档 / 冷数据迁移 |
| `user_dividend_records` | 分红发放记录 | 禁止清理，只允许归档 | 12～24 个月 | 月度归档 / 冷数据迁移 |
| `dividend_pools` | 分红池 | 禁止清理，只允许归档 | 12～24 个月 | 月度归档 / 冷数据迁移 |
| `dividend_pool_items` | 分红明细 | 禁止清理，只允许归档 | 12～24 个月 | 月度归档 / 冷数据迁移 |

Implementation note: the runtime guard also protects legacy or actual physical aliases such as `withdraws`, `invite_commission_records`, and `dividend_records` when present.

## Forbidden Operations

These operations are forbidden for core protected tables in lifecycle cleanup work:

- `DELETE`
- `TRUNCATE`
- unconditional `UPDATE`
- cleanup job deletion
- adding any core protected table into cleanup allowlists

If a protected table is accidentally included in cleanup specs, the job must skip it and record:

- `table_name`
- `skipped=true`
- `reason=PROTECTED_CORE_TABLE`

The low-level cleanup function also defaults to safe execution: a direct call with `dry_run=false` is forced back to dry-run unless the approved worker/manual wrapper explicitly enables execution. This prevents ad-hoc validation code from accidentally deleting eligible operational log rows.

V1.2 adds an explicit execute confirmation guard:

- confirm text: `DELETE_NON_CORE_TEMP_DATA`;
- CLI `--execute` requires `--confirm DELETE_NON_CORE_TEMP_DATA`;
- scheduler remains dry-run by default;
- scheduler can request execute only when env/config explicitly enables execute and confirms the text;
- real delete log rows must be marked `operation_mode=EXECUTE` and `risk_level=REAL_DELETE`.

## V1.2 Safety Incident Note

During V1.1 validation, a low-level cleanup call was executed with `dry_run=false` while testing protected-table behavior. It affected only eligible non-core temporary tables:

- `user_otps`: 22 rows
- `user_sessions`: 555 rows

Read-only follow-up confirmed:

- core financial tables had no observed change;
- `balance_logs` remained unchanged;
- protected table attempts are now skipped as `PROTECTED_CORE_TABLE`.

The follow-up V1.2 guardrails are:

- low-level cleanup defaults to dry-run unless the approved wrapper passes `allow_execute=true`;
- CLI execute requires confirm text;
- maintenance scheduler defaults to dry-run;
- execute results are visibly marked as `EXECUTE / REAL_DELETE`.

## Allowed Operations

Allowed lifecycle work for these tables:

- admin query range narrowing
- read-only audits
- index optimization after separate review
- monthly archive planning
- cold data migration after backup and reconciliation checks

## Archive V2 Plan

Archive is not deletion. Archived data remains retained long term.

V2 should use:

- archive tables with the same structure as hot tables;
- monthly archive windows;
- small migration batches;
- source and archive `COUNT(*)` verification;
- checksum or numeric `SUM(...)` verification for financial fields;
- archive manifest per table/month;
- backup confirmation before any hot-table migration-out step;
- rollback procedure before execution approval;
- keyset pagination for archive review pages.

No V1 task should move rows out of hot core tables.

## Read-Only Index Review

Checked on 2026-06-19 through `information_schema.statistics`. No index was added in this phase.

| Table | Required Access Pattern | Current Coverage | Recommendation |
| --- | --- | --- | --- |
| `balance_logs` | `user_id + created_at` | Covered by `idx_user_time` | No V1 action |
| `balance_logs` | `coin_symbol + created_at` | Not directly covered; existing `idx_coin_chain_time` is `coin_symbol, chain_key, created_at` | Consider `coin_symbol, created_at` only if admin queries often omit `chain_key` |
| `balance_logs` | `biz_id` | Covered by `idx_balance_logs_biz_id` | No V1 action |
| `balance_logs` | `request_id` | Covered by `idx_balance_logs_request_id` | No V1 action |
| `orders` | `user_id + created_at` | Covered by `idx_orders_user_created` | No V1 action |
| `orders` | `trading_pair_id + created_at` | Covered by `idx_orders_pair_created` | No V1 action |
| `orders` | `status + created_at` | Covered by `idx_orders_status_created` / `idx_status_created_at` | No V1 action |
| `orders` | `order_no` | Covered by `idx_orders_order_no` / `uk_order_no` | No V1 action |
| `trades` | `buyer_user_id + created_at` | Covered by `idx_trades_buyer_created` | No V1 action |
| `trades` | `seller_user_id + created_at` | Covered by `idx_trades_seller_created` | No V1 action |
| `trades` | `trading_pair_id + created_at` | Covered by `idx_trades_pair_created` | No V1 action |
| `contract_orders` | `user_id + created_at` | Covered by `idx_contract_orders_user_created` | No V1 action |
| `contract_orders` | `symbol + created_at` | Covered by `idx_contract_orders_symbol_created` | No V1 action |
| `contract_orders` | `status + created_at` | Covered by `idx_contract_orders_status_created` / `idx_contract_orders_status_created_at` | No V1 action |
| `contract_orders` | `order_no` | Covered by `idx_contract_orders_order_no` / `uk_contract_orders_order_no` | No V1 action |
| `contract_trades` | `user_id + created_at` | Covered by `idx_contract_trades_user_created` | No V1 action |
| `contract_trades` | `symbol + created_at` | Covered by `idx_contract_trades_symbol_created` | No V1 action |
| `contract_margin_logs` | `user_id + created_at` | Not covered; current indexes include separate `user_id` and `created_at` | P1: consider `user_id, created_at` |
| `contract_margin_logs` | `symbol + created_at` | Not covered; table may not currently expose a `symbol` index | P1: confirm column and query path, then consider `symbol, created_at` if used |
| `deposits` | `user_id + created_at` | Covered by `ix_deposit_user_time` | No V1 action |
| `deposits` | `status + created_at` | Not covered; current `ix_deposit_status` covers status only | P2: consider `status, created_at` for admin status range queries |
| `deposits` | `tx_hash` | Not covered under this exact name; existing lookup is `chain_key, txid, log_index` | P2: align admin filter with `txid`, or add exact index only after query review |
| `withdraw_logs` | `user_id + created_at` | Not covered; current `idx_user_asset_chain` is `user_id, coin_symbol, chain_key` | P1: consider `user_id, created_at` |
| `withdraw_logs` | `status + created_at` | Covered by `idx_status_created` | No V1 action |
| `withdraw_logs` | `tx_hash` | Covered by `idx_tx_hash` | No V1 action |

## Governance

P0 guardrail:

- cleanup job must never delete from core protected tables;
- protected specs must be skipped and recorded as `PROTECTED_CORE_TABLE`;
- admin pages must keep default query ranges and precise-condition requirements for large tables.

P1 before archive:

- finalize archive schema and manifest format;
- add missing high-value indexes only after query-plan review;
- add archive verification reports.

P2 after launch:

- keyset pagination for hot and archive ledgers;
- cold data export workflow;
- worker dashboard for archive manifests and checksums.
