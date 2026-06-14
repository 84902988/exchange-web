# 资金归集 + 补 Gas V1 运营 Runbook

本文档面向后台运营和技术值守人员，说明如何查看、dry-run、人工小额真实发送和排查资金归集 / 补 Gas 任务。

## 后台入口

常用页面：

- 归集批次：`/admin/collections/batches`
- 归集任务：`/admin/collections/tasks`
- 补 Gas 任务：`/admin/collections/gas-tasks`

后台只开放单条操作：

- 单条 dry-run。
- 单条真实发送。

不开放批量真实发送。

## 创建或扫描归集任务

归集任务通常由 candidate scanner 发现候选余额后创建。

运营侧应先确认：

- 用户链上地址正确。
- 目标归集地址正确。
- 币种和链正确。
- 任务金额不是异常大额。
- 任务状态为 `PENDING / QUEUED / FAILED` 才可手动执行。

如需手动扫描，应使用既有 scanner 或后台入口生成候选，不要直接手写数据库记录。

## 查看 collection_tasks

进入 `/admin/collections/tasks` 后重点检查：

- `task_no`
- `user_id`
- `chain_key`
- `coin_symbol`
- `from_address`
- `to_address`
- `amount`
- `status`
- `tx_hash`
- `last_error`
- `created_at / sent_at / confirmed_at`

执行前必须确认 `to_address` 与上线白名单目标一致。

## 查看 gas_tasks

进入 `/admin/collections/gas-tasks` 后重点检查：

- `task_no`
- `collection_task_id`
- `user_id`
- `chain_key`
- `gas_coin_symbol`
- `from_address`
- `to_address`
- `topup_amount`
- `target_balance`
- `status`
- `tx_hash`
- `last_error`

补 Gas 真实发送前必须确认：

- `from_address` 是可控热钱包地址。
- `to_address` 是对应用户归集地址。
- `topup_amount` 极小且在 guard 限额内。

## Dry-run 操作

Dry-run 用于验证任务状态流转，不发送链上交易。

步骤：

1. 确认 `COLLECTION_ENABLE_REAL_SEND=false`，或确认当前只是点击 `Dry-run 执行`。
2. 在任务列表找到单条 `PENDING / QUEUED / FAILED` 任务。
3. 点击 `Dry-run 执行`。
4. 确认浏览器弹窗。
5. 查看结果。

归集 dry-run 成功：

- 状态为 `CONFIRMED`。
- `tx_hash` 以 `DRYRUN_` 开头。

补 Gas dry-run 成功：

- 状态为 `CONFIRMED`。
- `tx_hash` 以 `DRYGAS_` 开头。

Dry-run 不应出现真实链上 hash。

## Real-send 前检查项

真实发送只允许首次小额、单链、单地址、单任务验收。

执行前必须逐项确认：

- `COLLECTION_ENABLE_REAL_SEND=true`
- `COLLECTION_REAL_SEND_CONFIRM=I_UNDERSTAND_COLLECTION_REAL_SEND`
- `COLLECTION_ALLOWED_CHAINS` 只包含验收链。
- `COLLECTION_ALLOWED_TARGET_ADDRESSES` 只包含验收目标地址。
- 单笔上限足够小。
- 日限额足够小。
- 当前任务金额小于单笔上限。
- 当日累计不会超过日限额。
- 当前任务状态为 `PENDING / QUEUED / FAILED`。
- 页面二次确认文案已阅读。

真实发送成功后：

- 任务只应进入 `SENT`。
- 不应立即进入 `CONFIRMED`。
- 后续等待 tx confirm watcher。

## Tx Confirm 确认

tx confirm watcher 负责检查已发送交易。

状态推进：

- `SENT`：交易已广播，等待链上确认。
- `CONFIRMED`：链上确认成功。
- `FAILED`：交易失败或确认失败。
- `PENDING`：等待执行。
- `QUEUED`：已排队。
- `BLOCKED`：被前置条件阻塞，需人工检查。

运营确认方式：

1. 在任务列表查看 `tx_hash`。
2. 在链上浏览器查看交易状态。
3. 等待 tx confirm watcher 更新状态。
4. 如果长时间保持 `SENT`，检查 RPC、链浏览器和 watcher 日志。

## 状态解释

- `PENDING`：任务已创建，尚未执行。
- `QUEUED`：任务已进入执行队列或准备执行。
- `SENDING`：任务正在发送流程中。
- `SENT`：真实交易已广播，等待确认。
- `CONFIRMED`：任务已确认完成。dry-run 会用虚拟 hash 直接确认。
- `FAILED`：任务执行失败，可根据错误决定是否重试。
- `SKIPPED`：任务被跳过，例如不满足归集条件。
- `BLOCKED`：任务被阻塞，需要人工排查。

## 常见错误排查

### env 未开启

现象：

- 后台真实发送提示真实发送开关未开启。

处理：

- 仅在人工小额验收窗口内设置 `COLLECTION_ENABLE_REAL_SEND=true`。
- 验收结束立即改回 `false`。

### confirm 文本错误

现象：

- 提示真实发送确认文本未配置或不正确。
- guard 返回 `REAL_SEND_CONFIRM_MISSING`。

处理：

- 设置 `COLLECTION_REAL_SEND_CONFIRM=I_UNDERSTAND_COLLECTION_REAL_SEND`。
- 不要使用近似文本。

### 链不在白名单

现象：

- guard 返回 `CHAIN_NOT_ALLOWED`。

处理：

- 检查任务 `chain_key`。
- 检查 `COLLECTION_ALLOWED_CHAINS`。
- 首次验收只配置一个链。

### 目标地址不在白名单

现象：

- guard 返回 `TARGET_ADDRESS_NOT_ALLOWED`。

处理：

- 检查任务 `to_address`。
- 检查 `COLLECTION_ALLOWED_TARGET_ADDRESSES`。
- 首次验收只配置一个目标地址。

### 超过单笔限额

现象：

- 归集返回 `COLLECT_SINGLE_LIMIT_EXCEEDED`。
- 补 Gas 返回 `GAS_SINGLE_LIMIT_EXCEEDED`。

处理：

- 不要临时放大到高风险额度。
- 拆成更小金额，先完成小额验收。

### 超过日限额

现象：

- 归集返回 `COLLECT_DAILY_LIMIT_EXCEEDED`。
- 补 Gas 返回 `GAS_DAILY_LIMIT_EXCEEDED`。

处理：

- 停止当天真实发送。
- 第二天再重新验收。
- 不要为了继续发送而临时放大日限额。

### 私钥派生失败

现象：

- 归集真实发送进入私钥派生或私钥地址匹配错误。

处理：

- 停止真实发送。
- 复查用户地址派生审计结果。
- 复查链标识和 user_id。
- 不要手动替换用户私钥。

### 链上余额不足

现象：

- 归集候选无法满足发送金额。
- 链上确认 helper 判断不可归集。

处理：

- 检查用户地址 token 余额。
- 检查 token decimals。
- 检查 RPC 返回是否正常。

### Gas 不足

现象：

- 归集交易无法发送。
- candidate scanner 或余额 helper 提示 gas required。

处理：

- 先创建并 dry-run 补 Gas 任务。
- 真实补 Gas 只能单条小额执行。
- 补 Gas 成功并确认后，再处理归集任务。

## 运营红线

- 不允许批量真实发送。
- 不允许绕过后台单条入口。
- 不允许直接改数据库把任务置为 `SENT` 或 `CONFIRMED`。
- 不允许扩大白名单覆盖多个未知地址。
- 不允许真实发送后跳过 tx confirm watcher。
- 不允许在 guard 拒绝时重试签名或广播。
