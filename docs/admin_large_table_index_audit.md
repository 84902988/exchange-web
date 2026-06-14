# 后台大表查询索引审计 V1

审计日期：2026-05-29

本审计只基于当前代码查询函数和当前数据库 introspection 结果输出建议，不修改业务代码、不修改数据库、不新增 Alembic migration。

## 审计范围

覆盖已落地大表查询策略的后台页面：

- `/admin/balance-logs` -> `balance_logs`
- `/admin/orders` -> `orders`
- `/admin/trades` -> `trades`
- `/admin/contract-orders` -> `contract_orders`
- `/admin/contract-trades` -> `contract_trades`
- `/admin/deposit-records` -> `deposits`
- `/admin/withdraw-records` -> `withdraw_logs`
- `/admin/user-transfers` -> `user_transfers`
- `/admin/audit` -> `audit_logs`

优先级说明：

- P0：默认 7 天查询或高频精准查询马上可能影响性能，建议优先评估创建。
- P1：常用筛选可进一步优化，但当前已有部分索引可兜底。
- P2：低频或需要先调整查询语义后再评估，暂不建议立即创建。

## 总体结论

- `orders`、`trades`、`contract_orders`、`contract_trades` 已具备较完整的 `created_at + id`、用户、品种、状态相关索引，暂不建议新增 P0 索引。
- `balance_logs` 已有用户、币种账户、业务类型、`request_id`、`biz_id` 索引，但缺少独立的 `(created_at, id)`，默认最近 7 天按时间倒序查询仍建议补齐。
- `deposits`、`withdraw_logs`、`user_transfers` 缺少默认列表直接适配的 `(created_at, id)`，这是本轮最明确的 P0 建议。
- `audit_logs` 当前数据库中表不存在，字段和索引均跳过；待表落地后再按实际字段审计。
- 多个页面存在 `LIKE '%xxx%'` 查询，例如 `request_id`、`txid`、`tx_hash`、单号。普通 BTree 索引无法有效支持前置通配模糊查询。索引建议只解决等值或前缀匹配场景；后续如要充分利用索引，应将精准字段查询语义改为等值或右侧通配。

## 1. balance_logs

页面路径：`/admin/balance-logs`

查询函数：`admin_query_balance_logs`

当前表结构：

`id`, `user_id`, `coin_symbol`, `chain_key`, `change_type`, `direction`, `change_amount`, `before_available`, `after_available`, `before_frozen`, `after_frozen`, `biz_type`, `biz_id`, `request_id`, `remark`, `created_at`, `asset_id`

主要筛选条件：

- `user_id = ?`
- `coin_symbol = ?`
- `chain_key = ?`
- `change_type = ?`
- `biz_type = ?`
- `biz_id = ?`
- `request_id LIKE ?`
- `tx_hash` 当前不是字段，查询实际匹配 `request_id LIKE ? OR biz_id LIKE ? OR remark LIKE ?`
- `direction = ?`
- `created_at >= ?`
- `created_at < ?`

排序方式：

`ORDER BY created_at DESC, id DESC`

已有索引：

- `PRIMARY KEY (id)`
- `idx_user_time (user_id, created_at)`
- `idx_coin_chain_time (coin_symbol, chain_key, created_at)`
- `idx_biz (biz_type, biz_id)`
- `idx_balance_logs_biz_id (biz_id)`
- `idx_balance_logs_request_id (request_id)`
- `idx_balance_logs_biz_type_created (biz_type, created_at)`
- `idx_balance_logs_change_type_created (change_type, created_at)`
- `uq_user_coin_chain_biz_change (user_id, coin_symbol, chain_key, biz_type, biz_id, change_type)` unique

缺失索引建议：

- P0：建议评估新增 `(created_at, id)`，用于默认最近 7 天列表和无精准条件的时间窗查询。
- P1：`(user_id, created_at, id)` 可评估；当前已有 `(user_id, created_at)`，InnoDB 二级索引包含主键，短期可先观察。
- P2：`tx_hash` 字段不存在，跳过。当前 `tx_hash` 搜索落到 `request_id/biz_id/remark LIKE '%...%'`，普通索引收益有限。

## 2. orders

页面路径：`/admin/orders`

查询函数：`admin_query_orders`

当前表结构：

`id`, `order_no`, `user_id`, `trading_pair_id`, `side`, `order_type`, `price`, `amount`, `filled_amount`, `avg_price`, `frozen_amount`, `executed_quote_amount`, `fee_amount`, `fee_asset_id`, `status`, `source`, `created_at`, `updated_at`, `execution_mode`, `fee_asset_symbol`

主要筛选条件：

- `id = ?`
- `order_no LIKE ?`
- `user_id = ?`
- `tp.symbol = ?`
- `side = ?`
- `order_type = ?`
- `execution_mode = ?`
- `tp.market_mode = ?`
- `status = ?` 或 `status IN ('CANCELED', 'CANCELLED')`
- `created_at >= ?`
- `created_at <= ?`

排序方式：

`ORDER BY created_at DESC, id DESC`

已有索引：

- `PRIMARY KEY (id)`
- `uk_order_no (order_no)` unique
- `idx_orders_order_no (order_no)`
- `idx_orders_created_id (created_at, id)`
- `idx_orders_user_created (user_id, created_at)`
- `idx_orders_pair_created (trading_pair_id, created_at)`
- `idx_orders_status_created (status, created_at)`
- `idx_orders_side_created (side, created_at)`
- `idx_orders_type_created (order_type, created_at)`
- `idx_orders_exec_mode_created (execution_mode, created_at)`
- `idx_created_at (created_at)`
- `idx_user_id (user_id)`
- `idx_trading_pair_id (trading_pair_id)`
- `idx_user_pair_status (user_id, trading_pair_id, status)`
- `idx_orders_match_scan (trading_pair_id, side, order_type, execution_mode, status, price, id)`

缺失索引建议：

- P0：无。默认排序和主要筛选已有较完整索引。
- P1：`symbol` 不在 `orders` 表，当前通过 `trading_pairs.symbol` 关联定位。若交易对筛选非常频繁，应单独确认 `trading_pairs.symbol` 是否有唯一或普通索引。
- P2：`order_no LIKE '%...%'` 对 BTree 索引利用有限；如作为精准条件，建议后续改为等值或前缀匹配。

## 3. trades

页面路径：`/admin/trades`

查询函数：`admin_query_trades`

当前表结构：

`id`, `trading_pair_id`, `buy_order_id`, `sell_order_id`, `buyer_user_id`, `seller_user_id`, `price`, `amount`, `quote_amount`, `maker_order_id`, `taker_order_id`, `created_at`, `counterparty_type`, `fee_amount`, `fee_asset_symbol`, `buyer_fee_amount`, `buyer_fee_asset_symbol`, `seller_fee_amount`, `seller_fee_asset_symbol`

主要筛选条件：

- `id = ?`
- `tp.symbol = ?`
- `(buyer_user_id = ? OR seller_user_id = ?)`
- `buyer_user_id = ?`
- `seller_user_id = ?`
- `(buy_order_id = ? OR sell_order_id = ? OR maker_order_id = ? OR taker_order_id = ?)`
- `sell_order_id = ?`
- `maker_order_id = ?`
- `taker_order_id = ?`
- `counterparty_type = ?`
- `created_at >= ?`
- `created_at <= ?`

排序方式：

`ORDER BY created_at DESC, id DESC`

已有索引：

- `PRIMARY KEY (id)`
- `idx_trades_created_id (created_at, id)`
- `idx_trades_pair_created (trading_pair_id, created_at)`
- `idx_trades_buyer_created (buyer_user_id, created_at)`
- `idx_trades_seller_created (seller_user_id, created_at)`
- `idx_trades_buy_order (buy_order_id)`
- `idx_trades_buy_order_id (buy_order_id)`
- `idx_trades_sell_order (sell_order_id)`
- `idx_trades_sell_order_id (sell_order_id)`
- `idx_trades_counterparty_created (counterparty_type, created_at)`
- `idx_trades_trading_pair_id (trading_pair_id)`
- `idx_trades_buyer_user_id (buyer_user_id)`
- `idx_trades_seller_user_id (seller_user_id)`
- `idx_trades_counterparty_type (counterparty_type)`

缺失索引建议：

- P0：无。默认排序、买卖用户、交易对、买卖订单已有索引。
- P1：建议评估 `maker_order_id`、`taker_order_id` 单列索引；当前 `order_id` 筛选会同时匹配这两个字段，但当前数据库未见对应索引。
- P1：若按 `user_id` 合并查询买方/卖方非常高频，当前 OR 条件依赖两个索引合并，短期可接受；后续可根据慢查询再评估查询拆分。
- P2：`symbol` 不在 `trades` 表，当前通过 `trading_pairs.symbol` 关联定位。需要单独确认 `trading_pairs.symbol` 索引。

## 4. contract_orders

页面路径：`/admin/contract-orders`

查询函数：`list_admin_contract_orders`

当前表结构：

`id`, `order_no`, `user_id`, `symbol`, `side`, `position_side`, `action`, `order_type`, `price`, `quantity`, `leverage`, `margin_amount`, `spread_x_snapshot`, `spread_fee`, `trigger_price`, `filled_quantity`, `avg_price`, `status`, `fail_reason`, `created_at`, `updated_at`, `position_id`, `take_profit_price`, `stop_loss_price`, `fee_amount`

主要筛选条件：

- `id = ?`
- `order_no LIKE ?`
- `user_id = ?`
- `symbol = ?`
- `position_id = ?`
- `side = ?`
- `action = ?`
- `position_side = ?`
- `order_type = ?`
- `status = ?` 或 `status IN ('CANCELED', 'CANCELLED')`
- `created_at >= ?`
- `created_at <= ?`

排序方式：

`ORDER BY created_at DESC, id DESC`

已有索引：

- `PRIMARY KEY (id)`
- `uk_contract_orders_order_no (order_no)` unique
- `idx_contract_orders_order_no (order_no)`
- `idx_contract_orders_created_id (created_at, id)`
- `idx_contract_orders_user_created (user_id, created_at)`
- `idx_contract_orders_symbol_created (symbol, created_at)`
- `idx_contract_orders_status_created (status, created_at)`
- `idx_contract_orders_status_created_at (status, created_at)`
- `idx_contract_orders_position_created (position_id, created_at)`
- `idx_contract_orders_action_created (action, created_at)`
- `idx_contract_orders_side_created (side, created_at)`
- `idx_contract_orders_position_side_created (position_side, created_at)`
- `idx_contract_orders_type_created (order_type, created_at)`
- `idx_contract_orders_user_symbol_status (user_id, symbol, status)`
- `idx_contract_orders_user (user_id)`
- `idx_contract_orders_symbol (symbol)`
- `idx_contract_orders_position (position_id)`

缺失索引建议：

- P0：无。默认排序和主要筛选已有较完整索引。
- P1：`order_no LIKE '%...%'` 对 BTree 索引利用有限；如作为精准条件，建议后续改为等值或前缀匹配。
- P2：`status_created` 与 `status_created_at` 重复度较高，后续做索引整理时可评估是否保留一份；本次不建议改库。

## 5. contract_trades

页面路径：`/admin/contract-trades`

查询函数：`list_admin_contract_trades`

当前表结构：

`id`, `trade_no`, `order_id`, `position_id`, `user_id`, `symbol`, `side`, `position_side`, `action`, `price`, `quantity`, `notional`, `leverage`, `margin_amount`, `spread_fee`, `realized_pnl`, `created_at`, `fee_amount`

主要筛选条件：

- `id = ?`
- `trade_no LIKE ?`
- `user_id = ?`
- `symbol = ?`
- `order_id = ?`
- `position_id = ?`
- `side = ?`
- `action = ?`
- `position_side = ?`
- `co.order_type = ?`
- `created_at >= ?`
- `created_at <= ?`

排序方式：

`ORDER BY created_at DESC, id DESC`

已有索引：

- `PRIMARY KEY (id)`
- `uk_contract_trades_trade_no (trade_no)` unique
- `idx_contract_trades_created_id (created_at, id)`
- `idx_contract_trades_created_at (created_at)`
- `idx_contract_trades_user_created (user_id, created_at)`
- `idx_contract_trades_symbol_created (symbol, created_at)`
- `idx_contract_trades_order_created (order_id, created_at)`
- `idx_contract_trades_position_created (position_id, created_at)`
- `idx_contract_trades_action_created (action, created_at)`
- `idx_contract_trades_side_created (side, created_at)`
- `idx_contract_trades_position_side_created (position_side, created_at)`
- `idx_contract_trades_user (user_id)`
- `idx_contract_trades_symbol (symbol)`
- `idx_contract_trades_order (order_id)`
- `idx_contract_trades_position (position_id)`

缺失索引建议：

- P0：无。默认排序、用户、品种、订单、持仓筛选已有索引。
- P1：`trade_no LIKE '%...%'` 对 BTree 索引利用有限；如作为精准条件，建议后续改为等值或前缀匹配。
- P2：`order_type` 来自关联表 `contract_orders`，当前不在 `contract_trades` 表；字段不存在，跳过。

## 6. deposits

页面路径：`/admin/deposit-records`

查询函数：`admin_query_deposit_records`

当前表结构：

`id`, `user_id`, `coin_symbol`, `chain_key`, `address`, `memo`, `txid`, `log_index`, `from_address`, `amount`, `status`, `confirmations`, `confirm_required`, `block_number`, `block_hash`, `created_at`, `updated_at`, `confirmed_at`

主要筛选条件：

- `id = ?`
- `deposit_no LIKE ?`：当前字段不存在，跳过
- `user_id = ?`
- `coin_symbol = ?`
- `chain_key = ?`
- `status = ?`
- `txid LIKE ?`
- `request_id LIKE ?`：当前字段不存在，跳过
- `(address LIKE ? OR from_address LIKE ?)`
- `DATE(created_at) >= ?`
- `DATE(created_at) <= ?`

排序方式：

`ORDER BY created_at DESC, id DESC`

已有索引：

- `PRIMARY KEY (id)`
- `ix_deposit_user_time (user_id, created_at)`
- `ix_deposit_status (status)`
- `ix_deposit_tx_lookup (chain_key, txid, log_index)`
- `uq_deposit_chain_txid_log_index (chain_key, txid, log_index)` unique
- `ix_deposits_user_id (user_id)`
- `ix_deposits_coin_symbol (coin_symbol)`
- `ix_deposits_chain_key (chain_key)`

缺失索引建议：

- P0：建议评估新增 `(created_at, id)`，用于默认最近 7 天列表和时间窗排序。
- P1：建议评估新增 `(status, created_at, id)`，当前只有 `status` 单列，状态筛选叠加时间窗时不够理想。
- P1：如充值 TxID 作为精准定位高频使用，建议评估单列 `(txid)`。当前已有 `(chain_key, txid, log_index)`，但只传 `txid` 且使用 `LIKE '%...%'` 时收益有限。
- P2：`deposit_no`、`request_id` 字段当前不存在，跳过。
- P2：`address/from_address LIKE '%...%'` 对普通索引收益有限，暂不建议新增地址索引。

## 7. withdraw_logs

页面路径：`/admin/withdraw-records`

查询函数：`admin_query_withdraw_records`

当前表结构：

`id`, `user_id`, `coin_symbol`, `chain_key`, `to_address`, `amount`, `fee`, `net_amount`, `status`, `tx_hash`, `verify_code_hash`, `verify_expires_at`, `created_at`, `updated_at`, `fail_reason`

主要筛选条件：

- `id = ?`
- `withdraw_no LIKE ?`：当前字段不存在，跳过
- `user_id = ?`
- `coin_symbol = ?`
- `chain_key = ?`
- `status = ?`
- `tx_hash LIKE ?`
- `request_id LIKE ?`：当前字段不存在，跳过
- `to_address LIKE ?`
- `DATE(created_at) >= ?`
- `DATE(created_at) <= ?`

排序方式：

`ORDER BY created_at DESC, id DESC`

已有索引：

- `PRIMARY KEY (id)`
- `idx_status_created (status, created_at)`
- `idx_tx_hash (tx_hash)`
- `idx_user_id (user_id)`
- `idx_user_asset_chain (user_id, coin_symbol, chain_key)`

缺失索引建议：

- P0：建议评估新增 `(created_at, id)`，用于默认最近 7 天列表和时间窗排序。
- P1：建议评估新增 `(user_id, created_at, id)`，当前只有 `user_id` 单列，用户维度叠加时间窗时不够理想。
- P1：建议评估新增 `(coin_symbol, chain_key, created_at, id)`，用于币种/链筛选叠加时间窗。
- P2：`withdraw_no`、`request_id` 字段当前不存在，跳过。
- P2：`tx_hash` 已有单列索引；但当前查询使用 `LIKE '%...%'`，普通 BTree 索引可能无法充分利用。若改为等值查询，现有索引即可。

## 8. user_transfers

页面路径：`/admin/user-transfers`

查询函数：`admin_query_user_transfer_records`

当前表结构：

`id`, `transfer_no`, `request_id`, `from_user_id`, `to_user_id`, `coin_symbol`, `from_account`, `to_account`, `amount`, `fee_amount`, `net_amount`, `status`, `recipient_email_mask`, `sender_available_before`, `sender_available_after`, `receiver_available_before`, `receiver_available_after`, `remark`, `created_at`, `updated_at`

主要筛选条件：

- `id = ?`
- `transfer_no LIKE ?`
- `(from_user_id = ? OR to_user_id = ?)`
- `from_user_id = ?`
- `to_user_id = ?`
- `coin_symbol = ?`
- `request_id LIKE ?`
- `status = ?`
- `DATE(created_at) >= ?`
- `DATE(created_at) <= ?`

排序方式：

`ORDER BY created_at DESC, id DESC`

已有索引：

- `PRIMARY KEY (id)`
- `uq_user_transfers_transfer_no (transfer_no)` unique
- `uq_user_transfers_from_request (from_user_id, request_id)` unique
- `idx_user_transfers_from_time (from_user_id, created_at)`
- `idx_user_transfers_to_time (to_user_id, created_at)`
- `idx_user_transfers_coin_time (coin_symbol, created_at)`
- `idx_user_transfers_status_time (status, created_at)`

缺失索引建议：

- P0：建议评估新增 `(created_at, id)`，用于默认最近 7 天列表和时间窗排序。
- P1：建议评估新增 `(request_id)`，当前 `request_id` 只作为 `(from_user_id, request_id)` 的第二列，单独按请求ID定位时无法直接利用该复合索引。
- P2：`transfer_no` 已有唯一索引；但当前查询使用 `LIKE '%...%'`，普通 BTree 索引可能无法充分利用。若改为等值查询，现有唯一索引即可。
- P2：`user_id` 是页面合并条件，不是表字段；查询实际拆到 `from_user_id/to_user_id`，已有两个方向的时间索引。

## 9. audit_logs

页面路径：`/admin/audit`

查询函数：`admin_query_audit_logs`

当前表结构：

当前数据库中不存在 `audit_logs` 表。

主要筛选条件：

代码层按可选字段兼容以下条件：

- `id = ?`
- `admin_user_id = ?` 或 `operator_id = ?`
- `operator_id = ?` 或 `admin_user_id = ?`
- `target_user_id = ?`
- `action = ?`
- `module = ?`
- `request_id LIKE ?`
- `ip/ip_address/admin_ip/client_ip LIKE ?`
- `DATE(created_at) >= ?`
- `DATE(created_at) <= ?`

排序方式：

`ORDER BY created_at DESC, id DESC`

已有索引：

表不存在，跳过。

缺失索引建议：

- P0：表不存在，跳过。
- P1：待 `audit_logs` 表落地后，如字段存在，建议优先评估 `(created_at, id)`、`(admin_user_id, created_at, id)`、`(action, created_at, id)`。
- P2：`operator_id`、`target_user_id`、`module`、`request_id`、`ip` 等字段当前不存在，跳过；待实际表结构确认后再评估。

## P0 建议汇总

本轮 P0 建议控制在最少数量，避免一次性增加过多写入成本：

1. `balance_logs (created_at, id)`
2. `deposits (created_at, id)`
3. `withdraw_logs (created_at, id)`
4. `user_transfers (created_at, id)`

其余表当前已有默认排序或高频筛选索引，先观察慢查询日志即可。

## P1 建议汇总

以下为后续结合慢查询再评估的索引：

1. `trades (maker_order_id)`、`trades (taker_order_id)`
2. `deposits (status, created_at, id)`
3. `deposits (txid)`，前提是后续 TxID 查询改为等值或前缀匹配
4. `withdraw_logs (user_id, created_at, id)`
5. `withdraw_logs (coin_symbol, chain_key, created_at, id)`
6. `user_transfers (request_id)`
7. `audit_logs` 表落地后，再评估 `(created_at, id)`、`(admin_user_id, created_at, id)`、`(action, created_at, id)`

## 注意事项

- 本文档仅输出建议，不代表立即创建索引。
- 创建索引前应结合生产数据量、写入 QPS、慢查询日志、Explain 结果和线上维护窗口。
- 对 `LIKE '%keyword%'` 查询，BTree 索引通常无法有效利用。若运营语义是精准定位，后续更推荐改为等值查询或右侧通配前缀查询。
- 本轮未检查任务日志表 `job_logs` 家族；如后续对任务日志也落地 7/15/30 天策略，应按同一方法补充审计。
