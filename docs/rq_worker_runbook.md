# RQ Worker Runbook

This project uses RQ queues defined in `backend/app/core/rq.py`. Start only named queues from `QUEUE_NAMES`; do not invent queue names for loops that are not RQ-backed.

## Queue Layout

Configured queues:

- `collection`
- `gas`
- `tx_confirm`
- `email`
- `release`
- `payout`
- `maintenance`

Recommended production split:

- Collection worker: `collection gas tx_confirm`
- Email worker: `email`
- Payout worker: `payout`
- Release worker: `release`
- Maintenance worker: `maintenance`

The payout worker handles money-moving database jobs such as invite commission and BD commission payouts. Keep payout concurrency conservative, typically one worker process at first, then scale only after lock behavior and balance logs have been reviewed under load.

Email workers can be scaled independently because email sending latency should not block payout or collection work.

## Windows Local Examples

Run all configured queues:

```powershell
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py
```

Run collection-related queues:

```powershell
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py collection gas tx_confirm
```

Run email only:

```powershell
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py email
```

Run payout only:

```powershell
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py payout
```

Run stock-token release only:

```powershell
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py release
```

Run maintenance only:

```powershell
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py maintenance
```

Enqueue one withdraw fee maintenance job:

```powershell
.venv\Scripts\python.exe backend\scripts\enqueue_withdraw_fee_maintenance.py
```

Run the withdraw fee maintenance scheduler loop:

```powershell
.venv\Scripts\python.exe backend\scripts\start_withdraw_fee_maintenance_scheduler.py
```

Unknown queues fail fast and should not be ignored.

## systemd Examples

Collection worker:

```ini
[Unit]
Description=Exchange RQ worker collection/gas/tx_confirm
After=network.target redis.service

[Service]
WorkingDirectory=/opt/exchange-web
Environment=REDIS_URL=redis://127.0.0.1:6379/0
ExecStart=/opt/exchange-web/.venv/bin/python backend/scripts/start_rq_worker.py collection gas tx_confirm
Restart=always
RestartSec=5
User=exchange

[Install]
WantedBy=multi-user.target
```

Payout worker:

```ini
[Unit]
Description=Exchange RQ worker payout
After=network.target redis.service

[Service]
WorkingDirectory=/opt/exchange-web
Environment=REDIS_URL=redis://127.0.0.1:6379/0
ExecStart=/opt/exchange-web/.venv/bin/python backend/scripts/start_rq_worker.py payout
Restart=always
RestartSec=5
User=exchange

[Install]
WantedBy=multi-user.target
```

Email worker:

```ini
[Unit]
Description=Exchange RQ worker email
After=network.target redis.service

[Service]
WorkingDirectory=/opt/exchange-web
Environment=REDIS_URL=redis://127.0.0.1:6379/0
ExecStart=/opt/exchange-web/.venv/bin/python backend/scripts/start_rq_worker.py email
Restart=always
RestartSec=5
User=exchange

[Install]
WantedBy=multi-user.target
```

Release worker:

```ini
[Unit]
Description=Exchange RQ worker release
After=network.target redis.service

[Service]
WorkingDirectory=/opt/exchange-web
Environment=REDIS_URL=redis://127.0.0.1:6379/0
ExecStart=/opt/exchange-web/.venv/bin/python backend/scripts/start_rq_worker.py release
Restart=always
RestartSec=5
User=exchange

[Install]
WantedBy=multi-user.target
```

Maintenance worker:

```ini
[Unit]
Description=Exchange RQ worker maintenance
After=network.target redis.service

[Service]
WorkingDirectory=/opt/exchange-web
Environment=REDIS_URL=redis://127.0.0.1:6379/0
ExecStart=/opt/exchange-web/.venv/bin/python backend/scripts/start_rq_worker.py maintenance
Restart=always
RestartSec=5
User=exchange

[Install]
WantedBy=multi-user.target
```

Withdraw fee maintenance scheduler:

```ini
[Unit]
Description=Exchange withdraw fee maintenance scheduler
After=network.target redis.service

[Service]
WorkingDirectory=/opt/exchange-web
Environment=REDIS_URL=redis://127.0.0.1:6379/0
ExecStart=/opt/exchange-web/.venv/bin/python backend/scripts/start_withdraw_fee_maintenance_scheduler.py
Restart=always
RestartSec=5
User=exchange

[Install]
WantedBy=multi-user.target
```

## Queues Not To Start

Do not start workers for names that are not in `QUEUE_NAMES`, including:

- `withdraw_watcher`
- `dealer_loop`
- `liquidation`
- `tp_sl`
- `contract_limit_scanner`
- `trading`

Those flows are not RQ queues in this project. Run them only through their existing application paths.

## Restart Notes

- Stop workers gracefully when possible so the current job can finish.
- RQ retries are defined per enqueue helper; restarting a worker should not change retry policy.
- Keep payout workers limited until duplicate-payout safeguards and database locks are observed in production.
- Collection and transaction confirmation workers may be split further if chain latency grows.
- Email workers can be scaled horizontally without coupling them to payout workers.
