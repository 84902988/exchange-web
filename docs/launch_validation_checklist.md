# STEP 26 Launch Validation Checklist

Scope: production-style launch validation only. This document is a runbook and checklist; it does not change trading, matching, Dealer, funds, dividend, BD, release, or chain-send logic.

Hard boundaries:

- Do not execute real chain sends while following the read-only sections.
- Do not run real migrations from this checklist.
- Do not enable collection/gas real-send flags during smoke validation.
- Do not start extra daemon owners to "test" concurrency.
- Treat all commands as read-only unless a section explicitly marks a later small-amount live-chain step.

Related docs:

- `docs/production_startup_runbook.md`
- `docs/rq_worker_runbook.md`
- `docs/prelaunch_technical_checklist_phase1.md`
- `docs/collection_operator_runbook.md`
- `docs/collection_go_live_checklist.md`

## 1. Smoke Test

Goal: prove the deployed services are reachable and wired together without placing orders, moving funds, sending chain transactions, or mutating schema.

Preconditions:

- Production secrets are already provisioned through the deployment platform or host-local env files.
- MySQL, Redis, backend, web, and RQ workers are already started by the approved production startup path.
- Alembic migrations, if needed, have already been completed by the separate migration procedure.
- Collection real-send remains disabled unless a later controlled live-chain acceptance window is active.

Backend API checks:

```bash
curl -fsS https://<api-domain>/health
curl -fsS https://<api-domain>/
```

Expected:

- `/health` returns `{"ok":true}` or equivalent success JSON.
- `/` returns service status JSON for `exchange-api`.
- Response includes a trace header such as `X-Trace-Id`.
- No startup logs show missing required env vars.
- No startup logs show schema auto-create running in production.

Web checks:

```bash
curl -fsSI https://<web-domain>/
curl -fsS https://<web-domain>/ | head
```

Expected:

- HTTP status is 200 or the expected application redirect.
- Static assets load from the expected web host.
- Browser network tab shows API calls going to the production API base URL, not localhost.
- No browser console errors for missing `NEXT_PUBLIC_API_BASE_URL`.

Read-only API surface checks:

```bash
curl -fsS https://<api-domain>/market/spot/symbols
curl -fsS "https://<api-domain>/market/ticker?symbol=MFCUSDT"
```

Expected:

- Public market endpoints return JSON or a documented empty state.
- Failures are structured JSON with `ok=false`, `error`, and `trace_id`.
- No order, withdrawal, payout, collection, dividend, BD payout, or stock-token release action is triggered.

Safety checks:

- Confirm `COLLECTION_ENABLE_REAL_SEND=false` in the production env snapshot.
- Confirm `COLLECTION_REAL_SEND_CONFIRM` is empty outside an approved live-chain window.
- Confirm smoke testing does not call admin real-send endpoints.
- Confirm smoke testing does not call withdrawal-send endpoints.

## 2. Daemon Single-Instance Validation

Goal: prove each in-process daemon has exactly one production owner.

Daemons that must have one owner only:

- Withdraw watcher
- Auto match worker
- Dealer order loop
- Contract TP/SL job
- Contract limit order job
- Dividend job
- BD commission job
- Stock-token release job
- Stock dealer trade job

Allowed ownership models:

- One backend API instance owns all in-process daemons; other API replicas are disabled or absent.
- One dedicated daemon-owner backend process owns all in-process daemons; public API replicas do not own them.

Read-only process inventory:

```bash
systemctl status exchange-backend
systemctl status exchange-daemon-owner
ps -ef | grep -E "uvicorn|gunicorn|app.main" | grep -v grep
```

Expected:

- Exactly one process is designated as daemon owner.
- If multiple API replicas exist, only the designated owner has daemon startup enabled.
- If the current code path cannot disable every daemon symmetrically, production must use a single backend process as the owner until gates are added.

Env flag verification for gates that exist:

```bash
grep -E "ENABLE_WITHDRAW_WATCHER|ENABLE_CONTRACT_TP_SL_JOB|ENABLE_CONTRACT_LIMIT_ORDER_JOB|ENABLE_STOCK_DEALER_TRADE_JOB" /opt/exchange-web/backend/.env
```

Expected for non-owner API processes:

```text
ENABLE_WITHDRAW_WATCHER=0
ENABLE_CONTRACT_TP_SL_JOB=0
ENABLE_CONTRACT_LIMIT_ORDER_JOB=0
ENABLE_STOCK_DEALER_TRADE_JOB=0
```

Log evidence:

```bash
journalctl -u exchange-backend -n 300 --no-pager
journalctl -u exchange-daemon-owner -n 300 --no-pager
```

Expected:

- One startup sequence contains the daemon start logs.
- Other API replicas, if present, do not show duplicate daemon start logs.
- There are no repeated `started` lines from restart loops.
- There are no overlapping dividend, BD payout, stock-token release, or Dealer loop owners.

Manual sign-off:

- Record the hostname, service name, process id, and startup time of the daemon owner.
- Record how non-owner API replicas are prevented from starting daemons.
- Record the rollback owner if the daemon-owner host is replaced.

## 3. RQ Worker Validation

Goal: prove RQ workers are running only the configured queues and can observe Redis without processing unintended job types.

Configured queues:

- `collection`
- `gas`
- `tx_confirm`
- `email`
- `release`
- `payout`

Worker command help:

```bash
cd /opt/exchange-web
.venv/bin/python backend/scripts/start_rq_worker.py --help
```

Expected:

- The script prints usage and exits successfully.
- No worker is started by the help command.

Unknown queue guard:

```bash
cd /opt/exchange-web
.venv/bin/python backend/scripts/start_rq_worker.py unknown_queue
```

Expected:

- The command fails fast.
- The error names the unsupported queue.
- No worker remains running for `unknown_queue`.

Read-only worker inventory:

```bash
systemctl status exchange-rq-collection
systemctl status exchange-rq-email
systemctl status exchange-rq-payout
systemctl status exchange-rq-release
ps -ef | grep start_rq_worker.py | grep -v grep
```

Expected:

- Collection worker uses `collection gas tx_confirm`.
- Email worker uses `email`.
- Payout worker uses `payout`.
- Release worker uses `release`.
- No worker is started for `withdraw_watcher`, `dealer_loop`, `liquidation`, `tp_sl`, `contract_limit_scanner`, or `trading`.

Redis/RQ visibility:

```bash
rq info -u "$REDIS_URL"
rq workers -u "$REDIS_URL"
```

Expected:

- Only the six configured queue names appear.
- Worker names map to the intended service split.
- Failed job count is reviewed and triaged before launch.
- Payout worker concurrency is conservative, normally one process at first.

Log checks:

```bash
journalctl -u exchange-rq-collection -n 200 --no-pager
journalctl -u exchange-rq-payout -n 200 --no-pager
```

Expected:

- No import errors.
- No Redis connection errors.
- No repeated crash/restart loop.
- No unexpected chain-send activity during validation.

## 4. HTTPS, Cookie, And WebSocket Validation

Goal: prove browser-facing transport settings work in production without weakening auth or breaking realtime paths.

HTTPS checks:

```bash
curl -fsSI https://<web-domain>/
curl -fsSI https://<api-domain>/health
```

Expected:

- TLS certificate is valid for the production hostnames.
- HTTP to HTTPS redirect exists if public HTTP is exposed.
- Reverse proxy preserves `Host`, `X-Forwarded-Proto`, and WebSocket upgrade headers.

Cookie env checklist:

```text
COOKIE_SECURE=true
COOKIE_SAMESITE=lax
COOKIE_PATH=/
COOKIE_DOMAIN=<empty for same host, or approved parent domain>
ACCESS_TOKEN_COOKIE_NAME=access_token
REFRESH_TOKEN_COOKIE_NAME=refresh_token
```

Expected:

- Production HTTPS uses `COOKIE_SECURE=true`.
- `COOKIE_SAMESITE=none` is used only when cross-site browser flow truly requires it, and only with HTTPS.
- `COOKIE_DOMAIN` matches the deployment topology; do not set a broad parent domain unless needed.
- Browser devtools show `HttpOnly` auth cookies after a controlled login test.

Strict read-only alternative:

- If no login mutation is allowed in this phase, validate only the env values and response headers.
- Defer actual Set-Cookie verification to an approved controlled account window.

Private WebSocket path:

```text
wss://<api-domain>/ws/private?symbol=MFCUSDT
```

Public market WebSocket path:

```text
wss://<api-domain>/market/ws/spot?symbol=MFCUSDT
```

Expected:

- Public market WebSocket connects and receives or accepts heartbeat messages.
- Private WebSocket rejects unauthenticated clients with a policy close instead of leaking data.
- Authenticated private WebSocket works only when the browser sends the expected auth cookie.
- WebSocket stays on `wss://` in production; no browser mixed-content warning appears.
- Load balancer or reverse proxy supports `Upgrade: websocket` and long-lived connections.

Suggested proxy checks:

```bash
curl -fsSI https://<api-domain>/health
```

Expected response headers to review:

- `set-cookie` appears only on auth endpoints, not on public health checks.
- `access-control-allow-origin` is not a wildcard when credentials are used.
- `access-control-allow-credentials` matches the intended browser credential flow.

## 5. Redis Persistence Check

Goal: confirm Redis is suitable for RQ, refresh-token whitelist, and operational state before launch.

Read-only Redis checks:

```bash
redis-cli -u "$REDIS_URL" PING
redis-cli -u "$REDIS_URL" INFO persistence
redis-cli -u "$REDIS_URL" INFO replication
redis-cli -u "$REDIS_URL" CONFIG GET save
redis-cli -u "$REDIS_URL" CONFIG GET appendonly
redis-cli -u "$REDIS_URL" CONFIG GET appendfsync
redis-cli -u "$REDIS_URL" CONFIG GET dir
redis-cli -u "$REDIS_URL" CONFIG GET dbfilename
redis-cli -u "$REDIS_URL" LASTSAVE
```

Expected:

- `PING` returns `PONG`.
- Persistence is intentionally enabled through RDB, AOF, or a documented managed Redis backup policy.
- `rdb_last_bgsave_status` is `ok` when RDB is used.
- `aof_last_write_status` is `ok` when AOF is used.
- `loading:0`.
- `master_link_status:up` if this instance is a replica.
- `LASTSAVE` timestamp is recent enough for the selected backup policy.

Keyspace and queue visibility:

```bash
redis-cli -u "$REDIS_URL" INFO keyspace
rq info -u "$REDIS_URL"
```

Expected:

- Redis DB index matches `REDIS_DB` or `REDIS_URL`.
- Queue names match the configured RQ queues.
- No unexpected production validation keys are created by this checklist.

Do not run during read-only validation:

- `FLUSHDB`
- `FLUSHALL`
- `CONFIG SET`
- `BGSAVE`
- `BGREWRITEAOF`
- Manual key deletion

## 6. Production Env Checklist

Goal: confirm required production env is explicit, sanitized, and not relying on development defaults.

Required backend env:

- `APP_ENV=production`
- `APP_NAME=exchange-api`
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `ENABLE_DB_AUTO_CREATE_ALL=false`
- `JWT_SECRET`
- `SECURITY_PEPPER`
- `MORALIS_WEBHOOK_SECRET`
- `ALIYUN_ACCESS_KEY_ID`
- `ALIYUN_ACCESS_KEY_SECRET`
- `REDIS_HOST`, `REDIS_PORT`, `REDIS_DB`, and optional `REDIS_PASSWORD`
- Or a complete `REDIS_URL`

Cookie/auth env:

- `COOKIE_SECURE=true`
- `COOKIE_SAMESITE=lax` or a documented `none` plus HTTPS requirement
- `COOKIE_PATH=/`
- `COOKIE_DOMAIN` reviewed for the deployed domains
- `ACCESS_TOKEN_COOKIE_NAME=access_token`
- `REFRESH_TOKEN_COOKIE_NAME=refresh_token`

Market data env:

- `ITICK_API_TOKEN` is the canonical token.
- `ITICK_API_KEY` is legacy alias only.
- `ITICK_BASE_URL` or documented API base overrides are set as needed.
- `BINANCE_USDM_BASE_URL` points to the intended production or testnet source.
- `BINANCE_USDM_FALLBACK_BASE_URLS` is reviewed.
- Proxy settings are explicit: `PROXY_ENABLED`, `PROXY_URL`, `BINANCE_USDM_USE_ENV_PROXY`.

Daemon ownership env:

- Exactly one owner process is approved for in-process daemons.
- Non-owner API processes set available gates to `0`.
- Any daemon without a symmetric env gate is covered by process topology, usually a single daemon-owner process.

Collection/gas real-send env:

- Default launch smoke value:

```text
COLLECTION_ENABLE_REAL_SEND=false
COLLECTION_REAL_SEND_CONFIRM=
```

- Live-chain acceptance window only:

```text
COLLECTION_ENABLE_REAL_SEND=true
COLLECTION_REAL_SEND_CONFIRM=I_UNDERSTAND_COLLECTION_REAL_SEND
```

- Live-chain acceptance must also define allowed chains, allowed target addresses, single-send limits, and daily-send limits.

Frontend env:

- `NEXT_PUBLIC_API_BASE_URL=https://<api-domain>`
- `NEXT_PUBLIC_APP_NAME`
- `NEXT_PUBLIC_ENV=production`
- `NEXT_PUBLIC_VERSION`

Schema and seed guardrails:

- Do not run Alembic from this checklist.
- Do not run seed scripts from this checklist.
- Confirm separately that migrations and production-safe seeds were completed in the approved order.
- Confirm dividend schema handling is documented before dividend launch.

Secrets hygiene:

- Do not copy local `.env` files into tickets, chat, logs, or screenshots.
- Use sanitized examples only: root `.env.example`, `backend/.env.example`, and `web/.env.example`.
- Boot logs may show token existence and length only; full secrets must not appear.

## 7. Small-Amount Live-Chain Acceptance Checklist

This section is a checklist only. Do not execute these steps during read-only launch validation.

Use this only in a separately approved maintenance window with named operator, reviewer, amount limits, and rollback plan.

Preparation:

- Select one chain and one token for the first acceptance run.
- Select one approved source wallet and one approved target wallet.
- Set the maximum single-send limit to the smallest meaningful test amount.
- Set the daily limit to the planned test total plus a small buffer.
- Confirm the hot wallet has only the required gas for the test window.
- Confirm RPC URL, chain id, explorer URL, and token contract address.
- Confirm collection/gas allowlists include only the selected chain and target address.
- Confirm no batch real-send endpoint or script will be used.

Pre-flight sign-off:

- Operator confirms exact chain, token, amount, source, and target.
- Reviewer confirms limits and allowlists.
- Reviewer confirms current balances on source, target, and hot wallet.
- Reviewer confirms `COLLECTION_ENABLE_REAL_SEND=true` only for the controlled operator instance.
- Reviewer confirms `COLLECTION_REAL_SEND_CONFIRM=I_UNDERSTAND_COLLECTION_REAL_SEND`.
- Reviewer confirms RQ workers and daemon ownership are stable before the test.

Execution outline:

1. Trigger exactly one approved single-task collection or gas action from the operator surface.
2. Capture the created task id, trace id, and transaction hash if a transaction is produced.
3. Wait for the documented confirmation count.
4. Verify explorer status.
5. Verify database task status.
6. Verify source, target, and hot-wallet balances.
7. Verify no second transaction was produced for the same task.

Post-flight:

- Immediately set `COLLECTION_ENABLE_REAL_SEND=false`.
- Clear `COLLECTION_REAL_SEND_CONFIRM`.
- Remove temporary allowlist entries if they were only for acceptance.
- Record final balances, tx hash, operator, reviewer, and timestamps.
- Review logs for duplicate submission, retry, or unexpected queue activity.
- Keep the amount limit low until several controlled runs are reviewed.

Abort criteria:

- Any unexpected second transaction.
- Any chain mismatch.
- Any target address mismatch.
- Any amount above the approved limit.
- Redis/RQ instability during execution.
- Daemon owner restart during execution.
- Missing or ambiguous task id, trace id, or tx hash.
