# Core Archive Post-Commit Verification - 2026-06-19

## 1. Summary

Conclusion: WARN

No technical release blocker was found. The only warning is operational: this local database already contains the pilot copy-only archive data for `orders / 2026-03` in `archive_orders`. Production first execution must still start from `--dry-run`; do not assume the local pilot batch exists or should be reused in production.

This verification pass was read-only except for creating this report. It did not run copy-only, did not run hot-table migrate-out, did not execute `DELETE`, `UPDATE`, or `TRUNCATE`, did not run cleanup, did not restart services, did not restore the mobile stash, and did not push.

Before this report was generated, `git status --short --branch` showed a clean worktree:

```text
## main...origin/main [ahead 10]
```

After report generation, this report file is the only expected new uncommitted file.

## 2. Git

Command: `git status --short --branch`

Result:

```text
## main...origin/main [ahead 10]
```

Command: `git log --oneline -8`

Result:

```text
2b7ea38 feat: add core ledger archive infrastructure
51cdc54 docs: add core ledger archive design
db619ee docs: confirm geo access formal blocking
68fb8d5 docs: add post-commit release verification
db3e698 chore: update locale dictionaries
7e1fa8f chore: update env examples
b6fd3d6 docs: add release readiness audits
8c21688 feat: add db lifecycle governance
```

Command: `git stash list -3`

Result:

```text
stash@{0}: On main: wip: mobile home experience deferred
```

Status:

- `main` is ahead of `origin/main` by 10 commits.
- Worktree was clean before this report was generated.
- `stash@{0}` remains the deferred mobile home stash.

## 3. Alembic

Commands:

```text
..\.venv\Scripts\python.exe -m alembic current
..\.venv\Scripts\python.exe -m alembic heads
```

Result:

```text
20260619_000109 (head)
20260619_000109 (head)
```

Status:

- DB current revision is `20260619_000109`.
- There is a single Alembic head.

## 4. Backend Static Checks

Python compile:

```text
{'checked': 437, 'error_count': 0, 'errors': []}
```

Key imports:

```text
OK app.db.models.core_archive
OK app.routers.admin_pages
```

Jinja parse:

```text
{'checked': 104, 'error_count': 0, 'errors': []}
```

Status: PASS.

## 5. Admin Page

Route check used direct route/template construction without starting a service.

Result:

```text
{
  'status_code': 200,
  'has_title': True,
  'has_safety': True,
  'body_len': 21788
}
```

Status:

- `/admin/system/core-archives` returns `200`.
- Page includes `Core Ledger Archives`.
- Page includes copy-only safety wording.

## 6. Archive Table State

Read-only DB state:

```text
{
  'tables_exist': {
    'core_archive_batches': True,
    'archive_orders': True,
    'archive_trades': True
  },
  'orders_count': 140955,
  'archive_orders_count': 16,
  'archive_orders_trial_count': 16,
  'batch': {
    'batch_id': 'core_archive_orders_202603',
    'source_table': 'orders',
    'archive_table': 'archive_orders',
    'archive_month': '2026-03',
    'status': 'VERIFIED',
    'dry_run': 0,
    'source_count': 16,
    'copied_count': 16,
    'verified_count': 16,
    'deleted_count': 0
  }
}
```

Status:

- `core_archive_batches` exists.
- `archive_orders` exists.
- `archive_trades` exists.
- Hot `orders` row count remains `140955`.
- `archive_orders` contains the 16-row local pilot copy-only batch.
- `core_archive_orders_202603` is `VERIFIED`.
- `deleted_count=0`.

## 7. Script Safety

Only dry-run was executed in this verification pass:

```text
..\.venv\Scripts\python.exe scripts\run_core_archive.py --table orders --month 2026-03 --dry-run
```

Dry-run result:

```text
{
  "mode": "DRY_RUN",
  "dry_run": true,
  "source_table": "orders",
  "archive_table": "archive_orders",
  "archive_month": "2026-03",
  "source_count": 16,
  "min_id": 1,
  "max_id": 23,
  "deleted_count": 0
}
```

Static safety scan:

- `run_core_archive.py` contains no `DELETE` or `TRUNCATE` statement.
- The only `INSERT` path is `INSERT IGNORE INTO {spec.archive_table}` for copy-only archive tables.
- Batch row field updates exist for copy/verify metadata.
- `FORBIDDEN_STATUSES = {"MIGRATING_OUT", "COMPLETED"}` is present.
- CLI help states copy-only never deletes hot rows.

Status: PASS.

## 8. Final Result

PASS:

- Git state is as expected.
- Alembic is at single head `20260619_000109`.
- Python compile passed.
- Key imports passed.
- Jinja parsing passed.
- `/admin/system/core-archives` returns `200`.
- Archive infrastructure tables exist.
- Hot `orders` row count remains `140955`.
- Trial archive batch is `VERIFIED`.
- `deleted_count=0`.
- Dry-run works.
- No copy-only, migrate-out, cleanup, service restart, or push was performed in this verification pass.

WARN:

- Local DB contains 16 rows of pilot copy-only data in `archive_orders` for batch `core_archive_orders_202603`. Production first run must start from `--dry-run` and should not assume this local pilot state.

BLOCKER:

- None found.
