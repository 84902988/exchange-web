# 资金归集 + 补 Gas V1 上线验收清单

本文档用于资金归集与补 Gas V1 的上线前检查、dry-run 验收、小额真实发送验收和回滚操作。当前代码闭环已完成，但真实链上发送必须等待人工小额验收。

## 当前能力

- 支持派生地址审计和私钥派生验证。
- 支持归集批次、归集任务、补 Gas 任务表。
- 支持 collection/gas service 状态机。
- 支持 candidate scanner 生成待归集候选。
- 支持链上余额确认 helper。
- 支持 RQ-ready worker 入口。
- 支持 tx confirm watcher 将 SENT 任务推进到 CONFIRMED 或 FAILED。
- 支持 send helper dry-run 与真实发送分支。
- 支持 guard 保护层：总开关、确认文本、链白名单、目标地址白名单、单笔上限、日限额。
- 支持后台单条 dry-run。
- 支持后台单条真实发送入口。

## 上线前必须配置的 env

默认必须保持真实发送关闭：

```env
COLLECTION_ENABLE_REAL_SEND=false
```

小额真实发送人工验收前，才允许临时配置：

```env
COLLECTION_ENABLE_REAL_SEND=true
COLLECTION_REAL_SEND_CONFIRM=I_UNDERSTAND_COLLECTION_REAL_SEND
COLLECTION_ALLOWED_CHAINS=bsc
COLLECTION_ALLOWED_TARGET_ADDRESSES=0x...
COLLECTION_MAX_SINGLE_COLLECT_USDT=1
COLLECTION_DAILY_COLLECT_USDT_LIMIT=5
COLLECTION_MAX_SINGLE_GAS_NATIVE_BSC=0.001
COLLECTION_DAILY_GAS_NATIVE_LIMIT_BSC=0.005
```

补 Gas 真实发送还需要：

```env
COLLECTION_GAS_HOT_PRIVATE_KEY=...
```

也可使用已有热钱包变量：

```env
HOT_WALLET_PRIVATE_KEY=...
```

注意：
- `COLLECTION_ALLOWED_TARGET_ADDRESSES` 只能配置首次验收目标地址。
- 首次验收只允许单链、单地址、单小额、单任务。
- 不允许配置过大的单笔上限或日限额。
- 不允许把真实发送总开关长期保持开启。

## RQ Worker 启动方式

启动归集 worker 前确认：

- 真实发送默认关闭。
- worker 默认不允许真实发送。
- 后台真实发送入口才会显式允许单条真实发送。

示例：

```powershell
.venv\Scripts\python.exe backend\scripts\start_collection_worker.py
```

如需分别管理队列，应确认队列名称与 `app.core.rq` 中配置一致：

- collection queue
- gas queue
- tx confirm queue

## supervisor/systemd 建议

生产环境建议拆分成独立进程：

- API 服务。
- collection worker。
- gas worker。
- tx confirm worker。

systemd 示例结构：

```ini
[Unit]
Description=Exchange Collection Worker
After=network.target

[Service]
WorkingDirectory=/srv/exchange-web
EnvironmentFile=/srv/exchange-web/backend/.env
ExecStart=/srv/exchange-web/.venv/bin/python backend/scripts/start_collection_worker.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

上线前必须检查：

- worker 使用的 `.env` 与 API 一致。
- `COLLECTION_ENABLE_REAL_SEND=false`。
- 日志落盘并可检索。
- 进程重启不会自动触发批量真实发送。

## Dry-run 验收步骤

1. 确认真实发送关闭：

```env
COLLECTION_ENABLE_REAL_SEND=false
```

2. 在后台扫描或创建一条 `collection_task`。
3. 打开后台归集任务页。
4. 对单条 `PENDING / QUEUED / FAILED` 任务点击 `Dry-run 执行`。
5. 验证：

- 状态进入 `CONFIRMED`。
- `tx_hash` 以 `DRYRUN_` 开头。
- 没有链上广播。
- 没有签名。
- 没有用户余额变更。

6. 对一条 `gas_task` 点击 `Dry-run 执行`。
7. 验证：

- 状态进入 `CONFIRMED`。
- `tx_hash` 以 `DRYGAS_` 开头。
- 没有链上广播。
- 没有签名。
- 没有用户余额变更。

## 小额真实发送验收步骤

真实小额验收只能人工执行，不允许自动脚本批量执行。

1. 选择单链，例如 `bsc`。
2. 选择单个目标地址。
3. 配置极小单笔上限和日限额。
4. 配置真实发送确认文本。
5. 打开后台任务页，只选择一条任务。
6. 点击 `真实发送`。
7. 二次确认弹窗出现后，再人工确认。
8. 验证结果：

- 任务状态只进入 `SENT`。
- `tx_hash` 为真实链上 hash。
- 不直接进入 `CONFIRMED`。
- 后续由 tx confirm watcher 确认链上状态。

验收完成后立即关闭真实发送总开关。

## 回滚/关闭真实发送步骤

立即关闭：

```env
COLLECTION_ENABLE_REAL_SEND=false
```

同时建议：

- 清空或移除 `COLLECTION_REAL_SEND_CONFIRM`。
- 清空 `COLLECTION_ALLOWED_TARGET_ADDRESSES`。
- 将单笔上限和日限额降到最小或移除。
- 重启 API 和 worker，使 env 生效。
- 检查后台真实发送按钮不再可用。

## 风险开关说明

真实发送必须同时满足：

- `COLLECTION_ENABLE_REAL_SEND=true`
- `COLLECTION_REAL_SEND_CONFIRM=I_UNDERSTAND_COLLECTION_REAL_SEND`
- 链在 `COLLECTION_ALLOWED_CHAINS` 中。
- 目标地址在 `COLLECTION_ALLOWED_TARGET_ADDRESSES` 中。
- 金额不超过单笔上限。
- 当日累计不超过日限额。
- 后台单条真实发送入口显式触发。
- send helper guard 通过。

任一条件不满足，必须拒绝，不构造 raw tx、不校验私钥、不签名、不广播。

## 禁止事项

- 不允许直接批量真实发送。
- 不允许自动 worker 全量真实发送。
- 不允许绕过后台单条入口直接调用真实发送。
- 不允许放宽 guard。
- 不允许扩大白名单后跳过小额验收。
- 不允许真实发送成功后直接标记 `CONFIRMED`。

## 首次验收原则

首次真实链上验收只能：

- 单链。
- 单地址。
- 单小额。
- 单条 collection_task 或 gas_task。
- 人工确认。
- 完成后立即关闭真实发送。
