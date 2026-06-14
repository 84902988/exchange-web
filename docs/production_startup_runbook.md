# Production Startup Runbook

This runbook defines production process ownership. It is intentionally operational: it does not change trading, matching, funds, dealer, or dividend payout logic.

## Environment Files

Use sanitized examples as templates:

- root: `.env.example`
- backend: `backend/.env.example`
- web: `web/.env.example`

Never deploy real secrets from local `.env` files. Fill production secrets through the deployment platform, a secret manager, or a private host-local env file.

Canonical market-data token:

- Use `ITICK_API_TOKEN`.
- `ITICK_API_KEY` is treated only as a legacy alias.

Production database schema:

- Run Alembic migrations explicitly.
- Keep `ENABLE_DB_AUTO_CREATE_ALL=false`.

## Backend API

Example local production-style command:

```powershell
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --access-log
```

Run it from `backend/`, or set the working directory to `backend/`.

Development startup uses this single-process uvicorn form by default. If you need hot reload debugging, add `--reload` manually for that session:

```powershell
.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --access-log --reload
```

When the backend is behind Nginx, forward the original client IP headers so login throttling uses the real client address:

```nginx
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

## Login Security Regression

IP source behavior:

- Local development: when `X-Forwarded-For` is absent, login throttling falls back to `request.client.host`. This keeps `localhost`, `127.0.0.1`, and direct local testing working.
- cpolar: if cpolar forwards `X-Forwarded-For`, the backend uses the first IP in that header. If it does not, the backend falls back to `request.client.host`. Login, register, and captcha flows should continue to work during cpolar testing.
- Nginx production: the proxy must pass the original IP headers shown above. Without them, IP-based login throttling may see the Nginx/backend peer address instead of the real client.

Redis TTL expectations:

- `login_fail:email:*` keys must have TTL.
- `login_fail:ip:*` keys must have TTL.
- `login_lock:email:*` keys must have TTL.
- `login_lock:ip:*` keys must have TTL.
- `captcha:*` keys must have TTL.

Manual TTL check:

```powershell
.venv\Scripts\python.exe backend\scripts\check_login_security_redis.py
```

Run this after a few intentional failed login attempts and one captcha refresh. The script is read-only and reports matching keys that are missing TTL.

Regression checklist:

1. Nonexistent email fails 3 times -> captcha is required.
2. Nonexistent email fails 5 times -> temporary lock message is shown.
3. Existing email with wrong password fails 3 times -> captcha is required.
4. Existing email with wrong password fails 5 times -> temporary lock message is shown.
5. Same IP with different emails failing repeatedly -> IP dimension triggers captcha/lock.
6. Wrong captcha cannot be reused; a refreshed captcha is required.
7. Correct login clears the current email/IP failure counters and lock keys.
8. Disabled account with correct password still shows `账户已被停用，请联系平台运营人员`.
9. Login security Redis keys listed above all have TTL.
10. Local cpolar login, register, and captcha flows still work normally.

Linux/systemd style:

```ini
[Unit]
Description=Exchange backend API
After=network.target mysql.service redis.service

[Service]
WorkingDirectory=/opt/exchange-web/backend
EnvironmentFile=/opt/exchange-web/backend/.env
ExecStart=/opt/exchange-web/.venv/bin/python -m uvicorn app.main:app --host 0.0.0.0 --port 8000
Restart=always
RestartSec=5
User=exchange

[Install]
WantedBy=multi-user.target
```

## Web

Build:

```powershell
cd web
npm run build
```

Start:

```powershell
cd web
npm run start
```

Linux/systemd style:

```ini
[Unit]
Description=Exchange web
After=network.target

[Service]
WorkingDirectory=/opt/exchange-web/web
EnvironmentFile=/opt/exchange-web/web/.env.local
ExecStart=/usr/bin/npm run start
Restart=always
RestartSec=5
User=exchange

[Install]
WantedBy=multi-user.target
```

## RQ Workers

Use `backend/scripts/start_rq_worker.py`.

Recommended split:

```powershell
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py collection gas tx_confirm
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py email
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py payout
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py release
.venv\Scripts\python.exe backend\scripts\start_rq_worker.py maintenance
```

Payout workers should start with conservative concurrency: one process until lock behavior and balance logs are verified under production load.

Withdraw fee maintenance is queued, not started by the API process. Run the scheduler as a separate process; it enqueues one deduplicated `maintenance` job every 10 minutes:

```powershell
.venv\Scripts\python.exe backend\scripts\start_withdraw_fee_maintenance_scheduler.py
```

## Single-Instance Daemon Ownership

These jobs must have exactly one owner process in production:

- Withdraw watcher
- Auto match worker
- Dealer order loop
- Contract TP/SL job
- Contract limit order job
- Dividend job
- BD commission job
- Stock-token release job
- Stock dealer trade job

The current API startup can start several of these in-process. For production, choose one of these patterns:

- A single backend API instance owns all in-process daemons while other API replicas disable them.
- A dedicated daemon-owner backend process owns them, and public API replicas disable them.

Use env flags where available:

```text
ENABLE_WITHDRAW_WATCHER=0
ENABLE_CONTRACT_TP_SL_JOB=0
ENABLE_CONTRACT_LIMIT_ORDER_JOB=0
ENABLE_STOCK_DEALER_TRADE_JOB=0
```

The auto match worker, dealer order loop, dividend job, BD commission job, and stock-token release job currently do not all have symmetric env gates. Treat that as a production ownership item before running multiple backend replicas.

## Real-Send Safety

Collection/gas real send must remain disabled by default:

```text
COLLECTION_ENABLE_REAL_SEND=false
COLLECTION_REAL_SEND_CONFIRM=
```

Only enable real send on a controlled operator instance after setting:

- `COLLECTION_REAL_SEND_CONFIRM=I_UNDERSTAND_COLLECTION_REAL_SEND`
- allowed chains
- allowed target addresses
- single-send limits
- daily-send limits

There is no approved batch real-send startup mode.

## Startup Order

1. MySQL.
2. Redis.
3. Alembic migrations.
4. Required seed scripts.
5. Backend API or daemon-owner backend process.
6. RQ workers.
7. Web.
8. Smoke checks.

## Smoke Checks

- Backend health/import starts without missing env errors.
- Web can reach backend API base URL.
- Redis worker `--help` works.
- Unknown RQ queue fails fast.
- Admin collection pages show real-send disabled unless explicitly enabled.
- No chain transaction is sent during smoke checks.
