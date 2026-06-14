# Prelaunch Technical Checklist Phase 1

Scope: read-only technical closeout for launch preparation. This checklist does not change services, trading, funds, matching, dealer logic, dividend payout logic, or chain-send behavior.

## Completed

- RQ queues are locked to:
  - `collection`
  - `gas`
  - `tx_confirm`
  - `email`
  - `release`
  - `payout`
- Generic RQ worker script exists:
  - `backend/scripts/start_rq_worker.py`
  - Supports queue arguments.
  - Defaults to all configured queues when no queue is passed.
  - Rejects unknown queues.
- Legacy RQ worker script remains intact:
  - `backend/scripts/start_collection_worker.py`
- RQ runbook exists:
  - `docs/rq_worker_runbook.md`
- RQ migration boundary is documented:
  - `docs/rq_migration_status.md`
- Funds collection real-send guard defaults safe:
  - `COLLECTION_ENABLE_REAL_SEND` defaults false when unset.
  - `COLLECTION_REAL_SEND_CONFIRM` must equal `I_UNDERSTAND_COLLECTION_REAL_SEND`.
  - Allowed chains, allowed targets, single limits, and daily limits are required before real send can pass.
- Collection and gas RQ tasks default to dry-run unless explicitly called with `allow_real_send=True`.
- Admin collection real-send paths are single-task guarded actions.
- No batch real-send endpoint was found for collection/gas.
- Alembic chain is linear in the current tree:
  - migration files: 21
  - current head: `20260509_000021`
- Seed scripts exist for current known data domains:
  - VIP levels
  - market categories and sub-categories
  - API selection trading pairs
  - stock contract symbols
  - TradFi CFD symbols
  - dividend test data
- RQ worker verification:
  - `start_rq_worker.py --help` works.
  - `start_rq_worker.py unknown_queue` fails fast.

## Must Fix Before Launch

- Create sanitized environment examples:
  - Missing root `.env.example`.
  - Missing backend `.env.example`.
  - Missing web `.env.example`.
  - Current repo only has `backend/.env` and `web/.env.local`; do not use real secret files as deployment templates.
- Normalize documented environment names:
  - `backend/app/core/config.py` defines `ITICK_API_KEY`.
  - Runtime code reads `ITICK_API_TOKEN`.
  - Production documentation should choose one canonical name and list all ITICK base URL overrides actually used by `itick_market_service.py`.
- Document all startup modes in one place:
  - Backend API: uvicorn command, working directory, env file expectations.
  - Development backend default: `uvicorn app.main:app --access-log` single process.
  - Hot reload is opt-in only: add `--reload` manually when debugging reload behavior.
  - Frontend: `npm run build` / `npm run start`.
  - RQ workers: queue split and process count.
  - In-process daemon threads started by FastAPI startup.
- Lock production defaults for independent daemon threads:
  - `ENABLE_WITHDRAW_WATCHER` defaults enabled in `main.py`.
  - `ENABLE_CONTRACT_TP_SL_JOB` defaults enabled.
  - `ENABLE_CONTRACT_LIMIT_ORDER_JOB` defaults enabled.
  - `ENABLE_STOCK_DEALER_TRADE_JOB` defaults disabled in its job module.
  - Auto match worker, dealer order loop, dividend job, BD commission job, and stock-token release job are started by app startup without a clearly documented production process-owner plan.
- Decide single-instance ownership for daemon threads:
  - Withdraw watcher
  - Auto match worker
  - Dealer order loop
  - Contract TP/SL job
  - Contract limit order job
  - Dividend job
  - BD commission job
  - Stock-token release job
  - Stock dealer trade job
- Move dividend schema into Alembic or explicitly document the manual SQL migration order:
  - `backend/scripts/dividend_v1_schema.sql` creates `dividend_pools`, `dividend_pool_items`, and `user_dividend_records`.
  - No Alembic revision was found for those tables.
- Remove or gate implicit production schema creation:
  - `backend/app/db/session.py` calls `Base.metadata.create_all(bind=engine)` at import time.
  - This is convenient for development but risky for controlled production migrations.
- Review boot logs for sensitive token leakage:
  - `main.py` logs ITICK token existence plus prefix/suffix.
  - Prefer logging existence and length only for production.
- Produce a production seed runbook:
  - Exact order.
  - Idempotency expectations.
  - Which scripts are dev/test only.
  - Which scripts are safe after launch.

## Can Defer

- Add an operator runbook for non-RQ daemon threads, separate from RQ worker runbooks.
- Add process supervision examples for backend API and frontend web, similar to the RQ systemd examples.
- Add RQ failed-job monitoring and alerting.
- Add Redis persistence and backup checks to deployment documentation.
- Add external API health checks:
  - Binance USDM
  - ITICK quote/depth/kline endpoints
  - Moralis API and Streams webhook
  - RPC endpoints per supported chain
- Add startup validation for optional but operationally important env vars:
  - collection real-send allowlists and limits
  - RPC URLs
  - ITICK API base URLs
  - Binance fallback URLs
  - watcher/job enable switches
- Add a smoke-test script that verifies Redis, DB, RQ queue visibility, and web/backend reachability without sending transactions.
- Decide whether `backend/scripts/dividend_v1_schema.sql` should remain as manual SQL after an Alembic migration is added.

## Configuration Findings

- `backend/app/core/config.py` requires DB credentials, JWT secret, and Aliyun DirectMail credentials.
- `main.py` additionally fails fast on:
  - `JWT_SECRET`
  - `SECURITY_PEPPER`
  - `DB_HOST`
  - `DB_USER`
  - `DB_PASSWORD`
  - `DB_NAME`
  - `MORALIS_WEBHOOK_SECRET`
- Redis settings are present in `settings` and RQ can derive `redis_url`.
- Cookie settings have defaults but should be explicitly documented for HTTPS production:
  - `COOKIE_SECURE`
  - `COOKIE_SAMESITE`
  - `COOKIE_DOMAIN`
- The actual backend env file includes many operational keys, but no sanitized example exists.
- The web env file exposes only public frontend keys:
  - `NEXT_PUBLIC_API_BASE_URL`
  - `NEXT_PUBLIC_APP_NAME`
  - `NEXT_PUBLIC_ENV`

## Startup Findings

- Backend API development startup is documented in `docs/local_dev_startup.md`.
- Development default is single-process uvicorn with access logs enabled:
  - `uvicorn app.main:app --access-log`
- Hot reload debugging is opt-in:
  - add `--reload` manually when needed.
- Frontend scripts are clear in `web/package.json`.
- RQ startup is clear in `docs/rq_worker_runbook.md`.
- Collection operator docs exist and clearly state dry-run and single-task real-send rules.
- Independent daemons are currently app-startup threads rather than separately documented worker processes.

## RQ Worker Findings

- Configured queues are exactly:
  - `collection`
  - `gas`
  - `tx_confirm`
  - `email`
  - `release`
  - `payout`
- `start_rq_worker.py` supports:
  - all queues by default
  - selected queues as arguments
  - fast failure on unknown queues
- Unknown queue names such as `trading`, `liquidation`, and `withdraw_watcher` are not valid RQ queues.

## Funds Send Safety Findings

- Collection real-send is guarded by:
  - feature flag
  - explicit confirmation text
  - allowed chain list
  - allowed target address list
  - single-send limits
  - daily-send limits
- RQ collection/gas processing defaults to dry-run because `allow_real_send` defaults false.
- Admin real-send endpoints call single-task processing with `allow_real_send=True` only after guard checks.
- No batch real-send endpoint was found.

## External API Findings

- Binance market service uses explicit request timeout.
- Binance USDM contract service has primary and fallback base URLs and short per-request timeouts.
- ITICK service has request timeouts and some stale-cache/cooldown fallback behavior.
- Moralis API calls use explicit timeout in the service.
- Obvious risks to close before launch:
  - canonicalize ITICK env names;
  - document fallback behavior per market type;
  - verify production proxy settings;
  - avoid relying on synthetic/stable fallback prices for trading-critical paths without an operator-visible status.

## Alembic And Seed Findings

- Alembic is configured at `alembic.ini` with `script_location = backend/alembic`.
- Alembic env imports app settings and model metadata.
- The revision chain appears linear with one head.
- Seed scripts exist but need a production order and safety classification.
- Dividend V1 schema is currently an SQL script rather than an Alembic migration.

## Current Phase Conclusion

The RQ task bus and collection real-send safety boundary are in good shape for a technical closeout. The main launch blockers are operational hygiene items: sanitized env examples, unified startup/daemon ownership documentation, dividend schema migration strategy, production seed order, and disabling or explicitly owning default-on daemon threads in production.
