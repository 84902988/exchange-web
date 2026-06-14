# Linux 常驻服务部署说明

本文整理本地 `backend/scripts/start_dev_all.ps1` 中的 FastAPI、RQ worker、scheduler，以及当前由 FastAPI startup 承载的 loop/scanner 类进程在 Linux 上的 systemd 拆分方式。本文只描述进程部署，不改变业务逻辑。

## 基础约定

- 代码目录：`/opt/exchange-web`
- 后端工作目录：`/opt/exchange-web/backend`
- Python 虚拟环境：`/opt/exchange-web/.venv`
- 后端环境文件：`/opt/exchange-web/backend/.env`
- 运行用户：`exchange:exchange`
- Redis 必须先启动。模板里写的是 `redis.service`，如果发行版使用 `redis-server.service`，需要同步替换 unit 里的 `After=`。

所有模板位于：

```bash
deploy/systemd/
```

复制到系统目录后执行：

```bash
sudo cp deploy/systemd/*.service /etc/systemd/system/
sudo systemctl daemon-reload
```

## 服务作用

| 服务 | 作用 | 漏启动影响 |
| --- | --- | --- |
| `exchange-api.service` | FastAPI 后端 API、后台页面、Webhook、用户接口 | 用户端和后台接口不可用，Webhook 无法接收 |
| `exchange-rq-email.service` | 消费 `email` 队列，发送验证码/通知邮件 | API 可能已入队，但邮件不会真正发出 |
| `exchange-rq-withdraw.service` | 消费 `withdraw` 队列，执行异步提现链上发送 | 提现提交/审核后可能停留在待发送或处理中 |
| `exchange-rq-payout.service` | 消费 `payout` 队列，处理返佣/分红等出款类任务 | 相关 payout job 积压，不会继续结算 |
| `exchange-rq-release.service` | 消费 `release` 队列，处理股票锁仓释放任务 | 锁仓释放 job 积压，用户资产释放延迟 |
| `exchange-rq-tx-confirm.service` | 消费 `tx_confirm` 队列，确认链上交易状态 | 充值、归集、gas 或提现相关确认可能不更新 |
| `exchange-rq-collection.service` | 消费 `collection` 队列，处理归集任务 | 归集任务积压，资产不会按策略归集 |
| `exchange-rq-gas.service` | 消费 `gas` 队列，处理 gas 补给任务 | 链上发送可能因 gas 不足被卡住 |
| `exchange-rq-maintenance.service` | 消费 `maintenance` 队列，执行维护类任务 | 已入队维护任务不会执行，例如提现手续费维护 |
| `exchange-withdraw-fee-scheduler.service` | 定时扫描并投递提现手续费维护任务 | 不会产生新的自动维护任务，worker 空转 |
| `exchange-collection-auto-scheduler.service` | 按自动归集规则扫描候选地址，创建归集任务并投递现有 collection/gas worker | 自动归集规则页无调度心跳，满足条件的候选不会自动生成归集任务 |
| `exchange-dealer-loop.service` | dealer 订单撮合/补单 loop 模板 | dealer 相关挂单处理不继续推进；如 API 已内嵌启动，不能重复启用 |
| `exchange-liquidation-scanner.service` | 合约强平扫描 loop 模板 | 风险仓位不会被自动扫描执行强平 |
| `exchange-tp-sl-scanner.service` | 合约止盈止损扫描 loop 模板 | TP/SL 条件不会被自动触发 |

## 启动顺序

推荐顺序：

1. MySQL/PostgreSQL 等数据库。
2. Redis。RQ worker 和 scheduler 都依赖 Redis。
3. Alembic 迁移和必要 seed。
4. `exchange-api.service`。
5. RQ workers：`email`、`withdraw`、`payout`、`release`、`tx_confirm`、`collection`、`gas`、`maintenance`。
6. scheduler/loop/scanner：提现手续费 scheduler、自动归集 scheduler、dealer loop、强平 scanner、TP/SL scanner。

Redis 没启动时，RQ worker 和 scheduler 即使被 systemd 拉起，也会反复重启或无法消费队列。

## API 和 RQ worker 必须分离

FastAPI 负责接收 HTTP 请求并把异步任务入队。RQ worker 负责从 Redis 队列取任务并执行。上线时不要把 RQ worker 塞进 uvicorn 进程，否则接口响应、任务执行、重启策略和日志都会互相影响。

本地 Windows 的 `start_dev_all.ps1` 会打开多个 PowerShell 窗口；Linux 上对应的是多个 systemd service。每个窗口/服务只承担一个职责，便于单独重启、查看日志和扩容。

## Scheduler 和 Worker 的区别

Scheduler 是“投递者”，负责按时间或规则扫描并 enqueue job。Worker 是“执行者”，负责消费队列并运行 job。

例如提现手续费维护需要两个服务配合：

- `exchange-withdraw-fee-scheduler.service`：定时投递维护任务到 `maintenance` 队列。
- `exchange-rq-maintenance.service`：消费 `maintenance` 队列并执行实际维护。

只启动 scheduler 不启动 worker，任务会积压；只启动 worker 不启动 scheduler，则不会自动产生新的维护任务。

## 启用与运维命令

启用并立即启动单个服务：

```bash
sudo systemctl enable --now exchange-api.service
```

一次启动核心服务：

```bash
sudo systemctl enable --now \
  exchange-api.service \
  exchange-rq-email.service \
  exchange-rq-withdraw.service \
  exchange-rq-payout.service \
  exchange-rq-release.service \
  exchange-rq-tx-confirm.service \
  exchange-rq-collection.service \
  exchange-rq-gas.service \
  exchange-rq-maintenance.service \
  exchange-withdraw-fee-scheduler.service \
  exchange-collection-auto-scheduler.service
```

查看状态：

```bash
sudo systemctl status exchange-api.service
sudo systemctl status exchange-rq-withdraw.service
```

重启：

```bash
sudo systemctl restart exchange-api.service
sudo systemctl restart exchange-rq-withdraw.service
```

查看日志：

```bash
sudo journalctl -u exchange-api.service -f
sudo journalctl -u exchange-rq-withdraw.service -f
```

查看最近 200 行日志：

```bash
sudo journalctl -u exchange-rq-maintenance.service -n 200 --no-pager
```

停止并取消开机启动：

```bash
sudo systemctl disable --now exchange-rq-email.service
```

## RQ worker 拆分建议

模板按队列拆成多个 worker：

- `email` 独立，避免邮件延迟阻塞其它任务。
- `withdraw` 独立，链上发送不占用确认或归集 worker。
- `payout` 独立，初期建议单进程保守运行。
- `release` 独立，股票锁仓释放任务不占用 payout 或 maintenance worker。
- `collection`、`gas`、`tx_confirm` 独立，便于按链上延迟单独扩容。
- `maintenance` 独立，执行定时维护类 job。

如果生产负载较低，也可以把多个队列放到同一个 worker 命令里，但要保留 API 与 worker 分离的原则。

## Loop/Scanner 单实例注意

当前项目里部分 loop 是 FastAPI startup 内嵌线程，例如 dealer order loop、TP/SL job，以及若干单实例后台 job。上线时必须选择唯一 owner：

- 方案 A：只跑一个 `exchange-api.service` 实例，让 API 继续拥有内嵌 loop。
- 方案 B：把 loop 拆成独立 systemd service，同时确保 API 侧不会再启动同一 loop。

不要让同一个 loop 同时被 API 和独立 service 启动，否则可能重复扫描、重复执行或产生锁竞争。若要多 API 副本上线，先确认对应 job 已有 env 开关或独立 runner。

## 上线检查清单

1. `.env` 中 Redis、数据库、链上配置、邮件配置均为生产值。
2. Redis 服务已启动，`systemctl status redis.service` 正常。
3. 数据库迁移已执行。
4. `exchange-api.service` 启动正常，`/health` 返回正常。
5. 每个 RQ worker 的日志中能看到监听对应 queue。
6. `exchange-withdraw-fee-scheduler.service` 能定时投递维护任务。
7. 如果启用 loop/scanner 独立服务，确认 API 中没有重复 owner。
8. 对 `withdraw`、`payout`、`collection/gas` 这类资金相关服务，先用小流量验证日志和幂等行为。

## 模板校验

在 Linux 主机上复制 unit 后，可用以下命令检查语法：

```bash
sudo systemd-analyze verify /etc/systemd/system/exchange-*.service
```

如果提示 `redis.service` 不存在，通常是 Redis 服务名不同。把模板里的 `redis.service` 改为发行版实际名称，例如 `redis-server.service`。

## 生产日志治理

上线后不建议用“每日重启服务”来控制日志增长。API、RQ worker、scheduler、loop、scanner 都应作为长期运行进程交给 systemd 管理；异常退出时由 `Restart=always` 自动拉起，正常轮询日志应在代码层降噪，日志保留由 journald 控制。

建议在服务器上配置 journald 容量和保留时间，例如编辑 `/etc/systemd/journald.conf`：

```ini
[Journal]
SystemMaxUse=1G
SystemKeepFree=2G
MaxRetentionSec=14day
```

具体数值需要按服务器磁盘大小调整。修改后重启 journald：

```bash
sudo systemctl restart systemd-journald
```

常用日志排查命令：

```bash
journalctl -u exchange-api.service -f
journalctl -u exchange-rq-maintenance.service -f
journalctl -u exchange-withdraw-fee-scheduler.service -f
journalctl -u exchange-collection-auto-scheduler.service -f
journalctl -u exchange-dealer-loop.service -f
journalctl -u exchange-liquidation-scanner.service -f
journalctl -u exchange-tp-sl-scanner.service -f
```

查看 journald 当前占用：

```bash
journalctl --disk-usage
```

手动清理旧日志：

```bash
sudo journalctl --vacuum-time=14d
sudo journalctl --vacuum-size=1G
```

日志级别建议：

- 正常高频轮询、无任务变化、heartbeat 成功写入不输出 INFO。
- 有任务入队、服务启动、关键状态变化保留 INFO。
- Redis/DB 连接失败、链上发送失败、资金入账/扣减失败、强平/TP-SL 执行异常、风控阻断等必须保留 WARNING/ERROR。
- 需要定位细节时临时调高到 DEBUG，排查后恢复 INFO。
