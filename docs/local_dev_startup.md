# Local Development Startup

This guide starts the local development stack without changing business logic. RQ workers are separate processes from FastAPI; do not run them inside the uvicorn process.

## Required Processes

Start these local services for the public cpolar registration flow:

- Redis
- FastAPI backend
- Next.js web app
- cpolar frontend tunnel
- cpolar backend tunnel
- RQ workers

## Backend And RQ Workers

From the repository root, run:

```powershell
.\backend\scripts\start_dev_all.ps1
```

If local execution policy blocks the script:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\backend\scripts\start_dev_all.ps1
```

The script opens separate PowerShell windows for:

- FastAPI on `127.0.0.1:8000`
- RQ worker for `collection gas tx_confirm withdraw`
- RQ worker for `email`
- RQ worker for `payout`
- RQ worker for `release`
- RQ worker for `maintenance`
- Withdraw fee maintenance scheduler
- Collection auto scheduler

Withdraw fee maintenance is RQ-backed and does not run inside the FastAPI process. The scheduler process enqueues one deduplicated job every 10 minutes; the `maintenance` worker executes it.

Collection auto scheduler is the heartbeat owner for `/admin/collections/auto-settings`. It scans enabled collection networks by rule, creates collection tasks when candidates meet the configured minimum amount, and enqueues existing collection/gas workers. It does not bypass collection send guard, whitelist, limits, or tx confirmation protections.

After `start_dev_all.ps1` starts successfully, `/admin/collections/auto-settings` should show the automatic scan scheduler heartbeat without manually running `start_collection_auto_scheduler.py`.

FastAPI starts as a single uvicorn process by default:

```powershell
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --access-log
```

This keeps the development console request log visible:

```text
INFO: 127.0.0.1:xxxxx - "GET /docs HTTP/1.1" 200 OK
```

If you specifically need hot reload debugging, start FastAPI manually and add `--reload` yourself:

```powershell
cd backend
..\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --access-log --reload
```

The RQ windows reuse:

```powershell
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py
```

To enqueue one withdraw fee maintenance job for the `maintenance` worker:

```powershell
.venv\Scripts\python.exe backend\scripts\enqueue_withdraw_fee_maintenance.py
```

To run one scheduler tick without keeping the scheduler process alive:

```powershell
.venv\Scripts\python.exe backend\scripts\start_withdraw_fee_maintenance_scheduler.py --once
```

To run one automatic collection scheduler tick without keeping the scheduler process alive:

```powershell
.venv\Scripts\python.exe backend\scripts\start_collection_auto_scheduler.py --once
```

To manually run one withdraw fee maintenance pass directly without RQ:

```powershell
.venv\Scripts\python.exe backend\scripts\run_withdraw_fee_maintenance_once.py
```

To use a different backend port:

```powershell
.\backend\scripts\start_dev_all.ps1 -ApiPort 8001
```

## Redis

Redis must be running before starting FastAPI or workers. The default local backend config expects:

```text
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=0
```

Verify Redis from the repository root:

```powershell
.venv\Scripts\python.exe -c "import sys; sys.path.insert(0, 'backend'); from app.core.rq import get_redis_connection; print(get_redis_connection().ping())"
```

## Next.js

In a separate terminal:

```powershell
cd web
npm run dev
```

For the public cpolar frontend flow, make sure the web environment points to the public backend API:

```text
NEXT_PUBLIC_API_BASE_URL=https://moralis-api.cpolar.top
```

Restart Next.js after changing this value because it is bundled into the client build.

## cpolar Tunnels

Run the frontend tunnel so the public web URL maps to the local Next.js app:

```text
https://moralis-hook.cpolar.top -> localhost:3000
```

Run the backend tunnel so the public API URL maps to local FastAPI:

```text
https://moralis-api.cpolar.top -> localhost:8000
```

## Registration Email Flow Check

The registration code path is:

```text
POST /auth/otp/send
```

Expected request target from the public frontend:

```text
https://moralis-api.cpolar.top/auth/otp/send
```

Expected API response after enqueue:

```json
{"ok":true,"data":{"message":"otp sent"},"error":null}
```

The API response only means the OTP was written and the email job was queued. The `email` RQ worker must be running for Alibaba Cloud DirectMail to send the actual email.

Check the email queue:

```powershell
.venv\Scripts\python.exe -c "import sys; sys.path.insert(0, 'backend'); from app.core.rq import get_queue, get_redis_connection; from rq.registry import FailedJobRegistry; from rq import Worker; q=get_queue('email'); conn=get_redis_connection(); print({'email_queue_len': q.count, 'failed': FailedJobRegistry('email', connection=conn).count, 'active_workers': len(Worker.all(connection=conn))})"
```

If old queued verification jobs exist before starting the worker, clear only the queued `email` jobs first to avoid sending historical codes.
