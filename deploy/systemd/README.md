# Production backend process topology

Production uses systemd as the only process supervisor. Do not run
`backend/scripts/start_dev_all.ps1`, ad-hoc `uvicorn`, or duplicate scheduler/scanner commands on the server.

## Ownership model

- `exchange-api.service` owns HTTP/WebSocket API traffic.
- Each RQ queue has an isolated worker unit so slow or failing work does not block other queues.
- Matching, scheduling, liquidation, TP/SL, contract limit orders, and accounting reconciliation each have one dedicated unit.
- `exchange-backend.target` groups all 17 services for enable/start/stop and status operations. A member failure does not restart unrelated members.
- The API unit overrides the three embedded-owner flags to `0`; `.env` cannot accidentally start the same loop in API and a dedicated unit.

Every service uses unbuffered Python output, journald, bounded restart bursts, a 30-second stop timeout, process-tree cleanup, and baseline filesystem/process hardening. Resource limits are intentionally not hard-coded: size CPU and memory limits from measured production load instead of copying development assumptions.

## Install and verify

The templates assume `/opt/exchange-web`, `/opt/exchange-web/.venv`, the runtime user `exchange:exchange`, and `redis.service`. Adjust all templates consistently if the host differs.

```bash
cd /opt/exchange-web
/opt/exchange-web/.venv/bin/python backend/scripts/validate_service_topology.py

sudo install -o root -g root -m 0644 deploy/systemd/*.service /etc/systemd/system/
sudo install -o root -g root -m 0644 deploy/systemd/*.target /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/exchange-*.service /etc/systemd/system/exchange-backend.target
sudo systemctl enable --now exchange-backend.target
```

Keep `/opt/exchange-web/backend/.env` readable by `exchange` but not world-readable. Run database migrations and dependency checks before starting or restarting the target members.

## Operational checks

```bash
systemctl status exchange-backend.target
systemctl --failed --type=service
systemctl list-dependencies exchange-backend.target
curl --fail --silent http://127.0.0.1:8000/health
journalctl -u exchange-api.service -n 200 --no-pager
journalctl -u exchange-contract-accounting-reconciliation-scheduler.service -n 200 --no-pager
```

Because every member declares `PartOf=exchange-backend.target`, stopping or restarting the target propagates to the complete group. Do not use a full target restart for routine rolling deployments; restart changed service units explicitly and verify each one before moving to the next risk domain. Keep funds-moving workers (`withdraw`, `payout`, `collection`, `gas`, `tx_confirm`) as separate rollout gates.

If a queue needs more throughput, add an intentionally named additional worker unit for that queue and verify its jobs are safe for concurrent consumption. Do not duplicate scheduler/scanner units for throughput; those roles remain single-owner unless their implementation is redesigned for sharding.
