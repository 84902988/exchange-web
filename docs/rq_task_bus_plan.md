# RQ 任务总线设计与迁移计划

本文档只描述 RQ 队列总线方案和现有任务清点，不代表已经迁移任何业务任务。当前阶段不改业务 service，不改手续费、分红、BD、邀请、锁仓、提现逻辑，不新增自动发放行为。

## 当前 RQ 现状

当前 RQ 配置位于 `backend/app/core/rq.py`。

已定义队列：

- `collection`
- `gas`
- `tx_confirm`

当前 helper：

- `get_redis_url()`：优先读取 `REDIS_URL`，否则使用 `settings.redis_url`。
- `get_redis_connection()`：创建 Redis 连接。
- `get_queue(name)`：只允许读取已定义队列。
- `enqueue_job(queue_name, func, *args, **kwargs)`：统一入队。

当前 worker 启动脚本：

- `backend/scripts/start_collection_worker.py`

该脚本加载 `QUEUE_NAMES` 中全部队列，并使用 RQ `SimpleWorker` 执行。

当前入队点：

- `enqueue_collection_task(task_id)` -> `collection` queue -> `process_collection_task(task_id)`
- `enqueue_gas_task(task_id)` -> `gas` queue -> `process_gas_task(task_id)`
- `enqueue_tx_confirm_collection_task(task_id)` -> `tx_confirm` queue -> `process_tx_confirm_collection_task(task_id)`
- `enqueue_tx_confirm_gas_task(task_id)` -> `tx_confirm` queue -> `process_tx_confirm_gas_task(task_id)`

重要安全边界：

- 自动 worker 默认 `allow_real_send=False`。
- 后台真实发送入口是单条手动入口，不属于自动批量 worker。
- 真实发送仍受 env 总开关、确认文本、白名单、限额和 guard 限制。

## RQ 适用边界

适合 RQ 的任务应满足：

- 是离散的一次性任务。
- 输入参数可以被序列化，例如 `record_id`、`task_id`、`pool_id`。
- 任务可以幂等重试。
- 失败可以落到明确状态或 job log。
- 不要求毫秒级循环扫描。
- 不需要长时间持有内存状态。
- 不依赖 websocket 长连接或本地线程生命周期。

典型适合项：

- 发送邮件或验证码。
- 单条佣金发放。
- 单条分红发放或单个分红池处理。
- 单条锁仓释放。
- 单条归集任务。
- 单条补 Gas 任务。
- 单条 tx confirm。

## 独立守护进程边界

以下任务应继续作为独立守护进程或独立服务，暂不迁入 RQ：

- withdraw watcher
- dealer loop
- liquidation scanner
- contract TP/SL scanner
- contract limit order scanner

原因：

- 它们是持续轮询或高频扫描。
- 它们通常需要全局节奏控制、进程内锁、延迟等待或持续观察市场/链上状态。
- 部分任务会执行撮合、爆仓、止盈止损、限价单等高风险交易状态推进。
- 放入普通 RQ 可能造成重复扫描、并发执行、队列积压或延迟不可控。

如果未来要拆分，应先做独立调度器和分布式锁设计，不应直接把循环体塞进 RQ worker。

## 推荐 Queue 划分

短期保持现有队列：

- `collection`
- `gas`
- `tx_confirm`

后续建议新增：

- `email`
- `payout`
- `release`
- `maintenance`

推荐映射：

| Queue | 任务类型 | 说明 |
| --- | --- | --- |
| `email` | 邮件 / 验证码发送 | 快速失败、可少量重试 |
| `payout` | dividend / BD commission / user invite commission | 涉及余额变更，必须强幂等 |
| `release` | stock token release | 锁仓释放，必须记录 release log |
| `collection` | collection task | 已 RQ-ready |
| `gas` | gas task | 已 RQ-ready |
| `tx_confirm` | collection/gas tx confirm | 已 RQ-ready |
| `maintenance` | 低风险后台清理或补偿任务 | 后续再评估 |

不建议新增：

- `trading`
- `liquidation`
- `withdraw_watcher`

这些名字容易让高风险循环任务被误放入普通 RQ。

## 可迁移任务清单

### Email / 验证码

现状：

- `send_verify_code_email` 被认证 OTP 和提现 OTP 直接调用。

适合 RQ 的部分：

- 邮件实际发送动作。

不应迁移的部分：

- OTP 创建、哈希、过期时间、频率限制和验证逻辑仍应同步完成。

幂等要求：

- 同一 OTP 发送 job 应包含 `otp_id` 或业务唯一 key。
- 重试只能重发同一验证码，不得生成新验证码。

重试策略：

- 3 次以内。
- 指数退避。
- SMTP/供应商限流要降级为失败状态或待重试状态。

失败状态：

- 记录发送失败原因。
- 前端仍应得到明确提示，不应假装已发送。

### Dividend payout

现状：

- `dividend_job.py` 是单实例线程 job。
- `process_dividend_job_once()` 会检查时间、创建/计算/发放分红池并写 job log。

适合 RQ 的部分：

- 按 `pool_id` 处理单个分红池。
- 按 `record_id` 发放单条分红记录。

迁移前要求：

- 引入 DB 锁或 Redis 分布式锁。
- 拆分“创建池”“计算池”“发放记录”边界。
- 明确 PAID 记录不可重复发放。

重试策略：

- 单条记录可重试。
- 整池任务只能在锁保护下重试。

失败状态：

- `DividendJobLog` 必须记录 `FAILED / PARTIAL_FAILED`。
- pool 或 record 必须保留可恢复状态。

### BD commission payout

现状：

- `bd_commission_job.py` 自动扫描 `PENDING` 记录并调用 `pay_bd_commission_record`。
- 后台也有单条和批量发放入口。

适合 RQ 的部分：

- `pay_bd_commission_record(record_id)` 单条发放。
- 批量入口可拆成多个单条 job。

幂等要求：

- 单条 record 必须只从 `PENDING` 推进到 `PAID` 或 `FAILED`。
- 已 `PAID` 不可重复入账。

重试策略：

- 单条 3 次以内。
- 余额不足或状态不允许不应无限重试。

失败状态：

- record 标记 `FAILED` 或保留 `PENDING` 并写错误，需根据现有业务规则确定。
- `BdCommissionJobLog` 记录批次结果。

### User invite commission payout

现状：

- `pay_user_invite_commission_record(record_id)` 和 `pay_pending_user_invite_commissions(limit)` 存在。
- 后台有普通邀请分成发放入口。

适合 RQ 的部分：

- 单条 `UserInviteCommissionRecord` 发放。
- 批量入口后续可拆成多个单条 job。

幂等要求：

- 已 `PAID` 记录不可重复发放。
- balance log 应使用稳定 biz key。

重试策略：

- 单条 3 次以内。
- 永久性校验失败不重试。

失败状态：

- record 应明确 `FAILED` 或可人工重试状态。
- 失败原因写入记录或 job log。

### Stock token release

现状：

- `stock_token_release_job.py` 每分钟调用 `release_stock_token_locks`。
- 已有 release log。

适合 RQ 的部分：

- 单条 lock release。
- 指定批次拆成多个 lock id job。

幂等要求：

- 已释放锁仓不可重复释放。
- release log 必须记录 item id 和结果。

重试策略：

- 单条可重试。
- 并发释放同一 lock 必须由 DB 锁或状态条件阻止。

失败状态：

- release log 记录 `FAILED`。
- lock 状态保持可人工排查。

### Collection / Gas / Tx Confirm

现状：

- 已 RQ-ready。
- `collection`、`gas`、`tx_confirm` 队列已存在。

幂等要求：

- 任务仅允许从 `PENDING / QUEUED / FAILED` 执行。
- 自动 worker 默认 dry-run。
- 真实发送仅后台单条入口允许。
- tx confirm 只扫描 `SENT`。

重试策略：

- collection/gas 失败可按 retry_count 控制。
- tx confirm 对交易未找到或 RPC 短暂失败应保留 `PENDING/SENT`，后续再扫。

失败状态：

- collection/gas 失败落 `FAILED` 并写 `last_error`。
- tx receipt status=0 落 `FAILED`。

## 不适合 RQ 的任务清单

### Withdraw watcher

原因：

- 需要持续监听提现交易回执。
- 成功/失败会调用提现结算逻辑，涉及 frozen/available balance。
- 更适合独立守护进程和严格单实例控制。

保留建议：

- 独立进程或独立线程。
- 明确 `ENABLE_WITHDRAW_WATCHER`。
- 单实例运行。

### Dealer loop

原因：

- 高频处理 dealer 订单。
- 与撮合/盘口/价格状态耦合。
- 延迟和重复执行风险高。

保留建议：

- 独立守护进程。
- 保留运行间隔和进程内锁。

### Liquidation scanner

原因：

- 扫描并执行爆仓是高风险交易动作。
- 不适合普通异步任务堆积。

保留建议：

- 独立 scanner。
- 明确运行窗口、限速、风险日志和人工开关。

### Contract TP/SL scanner

原因：

- 高频扫描触发条件。
- 需要接近实时处理。
- 普通 RQ 延迟不可控。

保留建议：

- 独立守护进程。
- 分布式部署前先设计全局锁。

### Contract limit order scanner

原因：

- 高频扫描限价单成交条件。
- 与行情和撮合强相关。

保留建议：

- 独立守护进程。
- 保留固定 interval 和单实例约束。

## Worker 启动建议

短期：

```powershell
.venv\Scripts\python.exe backend\scripts\start_collection_worker.py
```

后续拆队列后建议：

```powershell
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py collection gas tx_confirm
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py email
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py payout
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py release
```

注意：以上是建议形态，当前尚未实现通用 `start_rq_worker.py`。

生产建议：

- collection/gas/tx_confirm 单独 worker。
- email 单独 worker，避免 SMTP 慢请求拖慢资金任务。
- payout 单独 worker，限制并发。
- release 单独 worker，限制并发。
- 高风险 payout/release worker 不与普通 email worker 混跑。

## 后续迁移顺序

建议顺序：

1. Email / 验证码发送。
2. Stock token release 单条任务。
3. User invite commission 单条发放。
4. BD commission 单条发放。
5. Dividend 单条 record 或单个 pool 阶段任务。
6. 保持 collection/gas/tx_confirm 独立队列并完善监控。

不建议第一批迁移：

- withdraw watcher。
- dealer loop。
- liquidation scanner。
- contract TP/SL scanner。
- contract limit order scanner。

## 迁移前验收要求

每类任务迁移到 RQ 前必须具备：

- 独立 job wrapper。
- 明确输入参数。
- 幂等键或状态条件。
- 最大重试次数。
- 可观测 job log。
- 失败状态定义。
- 后台或脚本级手动补偿方案。
- 不改变原业务 service 语义。

## 当前结论

当前项目已经具备 collection/gas/tx_confirm 的 RQ-ready 基础。下一阶段可以把低风险离散任务逐步迁入 RQ，但不应把高频交易扫描器、提现 watcher 或 dealer loop 直接迁入普通 RQ。

本阶段只完成方案设计，不迁移任何任务。
