# Production process topology

Production uses systemd as the only process supervisor. Do not run
`backend/scripts/start_dev_all.ps1`, ad-hoc `uvicorn`, or duplicate scheduler/scanner commands on the server.
Do not run the production Next.js frontend through PM2; `exchange-web.service`
is its only process owner and its port must not have a second listener.

The Windows development process group intentionally excludes the withdraw-fee
and collection-auto schedulers. Linux production owns both funds-automation
schedulers as dedicated single-instance systemd services.

## Ownership model

- `exchange-web.service` owns the production Next.js frontend on port `3000`.
- `exchange-api.service` owns HTTP/WebSocket API traffic.
- Each RQ queue has an isolated worker unit so slow or failing work does not block other queues.
- `exchange-withdraw-tx-watcher.service` is the only owner that confirms submitted withdrawals as successful or failed.
- `exchange-dividend-auto-scheduler.service` is the only owner that automatically calculates and pays a due dividend batch.
- Matching, scheduling, liquidation, TP/SL, contract limit orders, and accounting reconciliation each have one dedicated unit.
- `exchange-dividend-eligibility-snapshot.timer` owns the immutable daily eligibility snapshot only; it never calculates or pays dividends.
- `exchange-geoip-update.timer` checks daily for an authorized GeoLite2 Country update, validates it, and atomically replaces the local database without restarting the API.
- `exchange-backend.target` groups all 19 services for enable/start/stop and status operations. A member failure does not restart unrelated members.
- The API has no embedded withdrawal-confirmation or automatic-dividend owner, so `.env` cannot accidentally create duplicate processes for either workflow.

Every service uses unbuffered Python output, journald, bounded restart bursts, a 30-second stop timeout, process-tree cleanup, and baseline filesystem/process hardening. Database pools are role-bounded: the API may use `10 + 10` connections, while each single-process worker/scheduler/scanner uses `2 + 1`. The complete 19-service topology therefore has a maximum configured SQLAlchemy budget of 74 connections, leaving headroom under the database server limit for migrations, administration, and rolling overlap. CPU and memory limits are intentionally not hard-coded: size them from measured Alibaba Cloud production load instead of copying development assumptions.

## Install and verify

The templates assume `/opt/exchange-web`, `/opt/exchange-web/.venv`,
`exchange:exchange` for backend services, `www:www` for the frontend, and
`redis.service`. Adjust all templates consistently if the host differs.

```bash
cd /opt/exchange-web
/opt/exchange-web/.venv/bin/python backend/scripts/validate_service_topology.py

sudo install -o root -g root -m 0644 deploy/systemd/*.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/systemd/*.timer /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/systemd/*.target /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/exchange-*.service /etc/systemd/system/exchange-*.timer /etc/systemd/system/exchange-backend.target
sudo systemctl enable --now exchange-backend.target
sudo systemctl enable --now exchange-dividend-eligibility-snapshot.timer
sudo systemctl enable --now exchange-geoip-update.timer
sudo systemctl enable --now exchange-web.service
```

Keep `/opt/exchange-web/backend/.env` readable by `exchange` but not world-readable. Run database migrations and dependency checks before starting or restarting the target members.
Keep `/opt/exchange-web/web/.env.production` readable by `www` but not
world-readable. Follow `deploy/systemd/FRONTEND_RELEASE.md` for frontend
build, permission, restart, listener-ownership, and browser verification.

GeoLite2 data and credentials are not included in the repository. Each user or deployer must obtain its own authorization, install the official `geoipupdate` utility, keep `/etc/GeoIP.conf` root-owned with mode `0600`, and comply with the applicable update and attribution requirements. After installing the unit files, verify the first update before relying on country filtering:

```bash
sudo systemctl start exchange-geoip-update.service
sudo systemctl status exchange-geoip-update.service --no-pager
sudo systemctl list-timers exchange-geoip-update.timer --no-pager
sudo -u exchange test -r /opt/exchange-web/data/geoip/GeoLite2-Country.mmdb
```

Automatic dividend payout is owned only by `exchange-dividend-auto-scheduler.service`, which reads the run time configured in the operations console. It has no environment enable switch and is never embedded in the API. The eligibility timer independently retries at `00:01`, `00:04`, `00:07`, `00:10`, and `00:13 UTC` within the bounded snapshot window. Snapshot creation is idempotent and writes no balance or payout records; the automatic scheduler fails closed if that immutable snapshot is missing.

## Operational checks

```bash
systemctl status exchange-backend.target
systemctl status exchange-web.service
systemctl --failed --type=service
systemctl list-dependencies exchange-backend.target
curl --fail --silent http://127.0.0.1:8000/health
journalctl -u exchange-api.service -n 200 --no-pager
journalctl -u exchange-web.service -n 200 --no-pager
journalctl -u exchange-contract-accounting-reconciliation-scheduler.service -n 200 --no-pager
```

Because every member declares `PartOf=exchange-backend.target`, stopping or restarting the target propagates to the complete group. Do not use a full target restart for routine rolling deployments; restart changed service units explicitly and verify each one before moving to the next risk domain. Keep funds-moving workers (`withdraw`, `payout`, `collection`, `gas`, `tx_confirm`) as separate rollout gates.

If a queue needs more throughput, add an intentionally named additional worker unit for that queue and verify its jobs are safe for concurrent consumption. Do not duplicate scheduler/scanner units for throughput; those roles remain single-owner unless their implementation is redesigned for sharding.
