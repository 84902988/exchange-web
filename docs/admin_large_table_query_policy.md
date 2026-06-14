# 后台大表查询策略 V1

## 一、背景

当前测试环境中，资金流水 `balance_logs` 已有 28 万+ 数据。上线后，`balance_logs`、`orders`、`trades`、`contract_trades`、`audit_logs`、各类 `job_logs` 等后台表会随着交易、资金、审计和任务执行快速增长。

后台管理页不能再默认全表浏览，也不应鼓励运营通过翻到几千页以后来定位问题。大表查询需要默认收敛时间范围，并引导运营通过用户、订单、流水、TxID、请求 ID 等精准条件定位。

## 二、适用页面

本策略适用于所有可能快速增长的后台查询页面，至少包括：

- 资金流水 `balance_logs`
- 现货订单 `orders`
- 现货成交 `trades`
- 合约订单 `contract_orders`
- 合约成交 `contract_trades`
- 操作审计 `audit_logs`
- 任务日志 `job logs`
- 充值记录 `deposit_logs`
- 提现记录 `withdraw_logs`

## 三、统一查询规则

1. 默认时间范围：最近 7 天。
2. 快捷时间范围：
   - 7 天
   - 15 天
   - 30 天
3. 普通查询最大范围：30 天。
4. 超过 30 天时，必须至少提供一个精准条件：
   - `user_id`
   - `order_id`
   - `trade_id`
   - `request_id`
   - `biz_id`
   - `tx_hash`
   - `withdraw_no` / `deposit_no`
5. 默认排序：`created_at DESC, id DESC`。
6. 禁止默认全表 `COUNT` + 深 `offset` 翻页。
7. 后台页面不再鼓励翻到几千页以后，运营应通过筛选定位。

## 四、分页策略

### 当前 V1

- 保留现有分页。
- 默认范围控制在最近 7 天，降低 `offset` 压力。

### 后续 V2

- 大表改为 keyset pagination。
- 使用游标条件：
  - `id < last_id`
  - `created_at < last_time`
- 不再使用大 `offset`。

## 五、索引建议

以下仅为后续改造建议，本策略文档不要求立即创建索引。

- `balance_logs`: `(user_id, created_at)`, `(coin_symbol, created_at)`, `(request_id)`, `(biz_id)`, `(created_at, id)`
- `orders`: `(user_id, created_at)`, `(trading_pair_id, created_at)`, `(status, created_at)`, `(created_at, id)`
- `trades`: `(buyer_user_id, created_at)`, `(seller_user_id, created_at)`, `(created_at, id)`
- `contract_orders`: `(user_id, created_at)`, `(symbol, created_at)`, `(status, created_at)`
- `contract_trades`: `(user_id, created_at)`, `(symbol, created_at)`
- `withdraw_logs`: `(user_id, created_at)`, `(status, created_at)`, `(tx_hash)`
- `deposit_logs`: `(user_id, created_at)`, `(tx_hash)`, `(status, created_at)`
- `audit_logs`: `(admin_user_id, created_at)`, `(action, created_at)`

## 六、改造优先级

### P0

- 资金流水
- 现货订单
- 现货成交
- 合约订单
- 合约成交

### P1

- 充值记录
- 提现记录
- 操作审计
- 任务日志

## 七、页面交互规范

每个大表页面顶部增加快捷按钮：

- 最近7天
- 最近15天
- 最近30天

默认选中最近7天。

如果用户选择超过 30 天但没有精准条件，页面提示：

> 为避免大范围查询影响系统性能，超过30天请填写用户ID、订单号、TxID或请求ID等精准条件。

## 八、验收

- 文档新增成功。
- 不改业务代码。
- 不改数据库。
- 不改路由。
