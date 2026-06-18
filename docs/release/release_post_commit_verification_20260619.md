# Release Post-Commit Verification - 2026-06-19

## 1. Summary

Conclusion: WARN

No technical release blocker was found in this post-commit verification pass. The remaining release risk is operational sign-off: Geo Access production enforcement is confirmed as CN only, but whether production runs disabled, monitor mode, or formal blocking still requires operations/compliance approval.

This pass did not modify business logic, did not run database writes, did not run real cleanup, did not restart services, and did not restore the deferred mobile stash.

Note: before this report was generated, `git status --short --branch` showed a clean worktree on `main...origin/main [ahead 6]`. After this report is generated, this report file is the only expected new uncommitted file.

## 2. Git Status

Command: `git status --short --branch`

Result:

```text
## main...origin/main [ahead 6]
```

Command: `git log --oneline -8`

Result:

```text
db3e698 chore: update locale dictionaries
7e1fa8f chore: update env examples
b6fd3d6 docs: add release readiness audits
8c21688 feat: add db lifecycle governance
65859c3 feat: add geo access control
004ad27 chore: update release hygiene ignores
8b299a8 feat: polish mobile home and tab navigation
4dc6160 feat: add mobile auth api integration
```

Command: `git stash list -3`

Result:

```text
stash@{0}: On main: wip: mobile home experience deferred
```

Status:

- Release mainline 6 commits are present.
- Worktree was clean before report generation.
- `stash@{0}` is the deferred mobile home stash.

## 3. Non-Repository Files

Command:

```text
git check-ignore data/geoip/GeoIP.conf data/geoip/GeoLite2-Country.mmdb backend/tmp/site_settings_id1_stock_token_notice_i18n_backup_20260616.md output/pdf/trading-rules-ops-confirmation-v1.pdf
```

Result:

```text
data/geoip/GeoIP.conf
data/geoip/GeoLite2-Country.mmdb
backend/tmp/site_settings_id1_stock_token_notice_i18n_backup_20260616.md
output/pdf/trading-rules-ops-confirmation-v1.pdf
```

Command: `git ls-files .env backend/.env web/.env.local`

Result: no output.

Status:

- GeoIP local files are ignored.
- `backend/tmp` and `output` examples are ignored.
- Real `.env` files are not tracked.

## 4. Alembic

Commands:

```text
..\.venv\Scripts\python.exe -m alembic current
..\.venv\Scripts\python.exe -m alembic heads
```

Result:

```text
20260619_000108 (head)
---
20260619_000108 (head)
```

Status:

- Single Alembic head.
- Current DB revision is at head.

## 5. Backend Static Checks

Python compile:

```text
{'checked': 434, 'errors': [], 'error_count': 0}
```

Jinja template parse:

```text
{'checked': 103, 'errors': [], 'error_count': 0}
```

Key import check:

```text
OK app.main
OK app.routers.admin_pages
OK app.routers.geo_access
OK app.services.geo_access_service
OK app.jobs.db_lifecycle_cleanup_job
OK app.services.admin_queries
OK app.core.rq
OK app.core.config
```

Status: PASS.

## 6. Frontend Checks

Command: `npm.cmd run build`

Result: PASS. Next.js production build completed successfully.

Warnings observed:

- `baseline-browser-mapping` data is over two months old.
- Browserslist data is old.
- Next.js detected multiple lockfiles and inferred workspace root from `D:\exchange-web\package-lock.json`.

These are warnings, not build failures.

Command:

```text
npm.cmd run lint -- proxy.ts app/restricted/page.tsx components/layout/AppChrome.tsx
```

Result: PASS.

Locale and restricted-page probe:

```json
{
  "locale_key_counts": {
    "en.json": 12,
    "ja.json": 12,
    "zh-TW.json": 12,
    "zh.json": 12
  },
  "restricted_english_title": true,
  "restricted_has_chinese": false,
  "restricted_imports_header_footer": false,
  "appchrome_bypass_restricted": true
}
```

Status:

- `/restricted` remains English-only.
- `/restricted` does not import Header/Footer/Nav/Login/Register.
- `AppChrome` bypasses the normal shell for `/restricted`.
- Proxy middleware is included in the build output as `ƒ Proxy (Middleware)`.

## 7. Mobile

Mobile stash was not restored.

Command: `git status --short -- mobile`

Result: no output.

Status:

- Current mobile worktree has no unstaged tracked changes.
- Mobile lint was skipped because the mobile home work is intentionally deferred in `stash@{0}` and not part of this release verification pass.

## 8. DB Lifecycle Safety

Runtime configuration probe:

```text
{
  'enabled': False,
  'dry_run': True,
  'allow_execute': False,
  'can_execute_now': False,
  'real_delete_logs': 0,
  'protected_count': 18
}
```

Cleanup allowlist target probe:

```text
{
  'cleanup_targets': [
    'user_otps',
    'user_sessions',
    'geo_access_logs',
    'dividend_job_logs',
    'bd_commission_job_logs',
    'stock_token_release_logs'
  ],
  'protected_in_targets': []
}
```

Protected table probe using `record_results=False`:

```text
{
  'table_name': 'balance_logs',
  'matched_count': 0,
  'deleted_count': 0,
  'retention_days': 90,
  'dry_run': True,
  'status': 'SKIPPED',
  'skipped': True,
  'reason': 'PROTECTED_CORE_TABLE',
  'operation_mode': 'DRY_RUN',
  'risk_level': 'SAFE_DRY_RUN',
  'error': 'protected core table cannot be cleaned'
}
```

Status:

- Cleanup scheduler default is disabled.
- Cleanup execution defaults to dry-run.
- Real execution is not allowed by current config.
- `can_execute_now=false`.
- No `REAL_DELETE` / `EXECUTE` cleanup logs exist.
- Core financial tables remain protected.

## 9. Geo Access

Local DB state:

```text
enabled=true
monitor_mode=false
block_unknown=false
admin_exempt=true
restricted_countries=["CN"]
```

Production confirmation document status:

- Final production restricted countries are `["CN"]`.
- `US` is documented as a test item only and must not enter the production restricted list.
- `block_unknown=false`.
- `admin_exempt=true`.
- `trust CF-IPCountry=true`.
- Formal production blocking is still controlled by `enabled` and `monitor_mode` and requires operations sign-off.

Status: WARN until operations signs off on production enablement mode.

## 10. Final Result

PASS:

- Git release commits are present.
- Deferred mobile work is stashed.
- GeoIP and local output files are ignored.
- Real env files are not tracked.
- Alembic has a single head and DB is at head.
- Python compile passed.
- Key backend imports passed.
- Jinja templates parsed.
- Frontend build passed.
- Targeted frontend lint passed.
- Locale JSON parsed.
- `/restricted` remains independent and English-only.
- DB Lifecycle cleanup remains disabled, dry-run, and protected against core-table cleanup.
- No real cleanup delete logs were found.
- Geo Access production list is CN only.

WARN:

- Operations must still sign off on whether production Geo Access runs disabled, monitor-only, or formal blocking.
- Frontend build warnings about stale browser data and multiple lockfiles remain non-blocking but should be cleaned up in a later release hygiene pass.

BLOCKER:

- None found in this verification pass.
