# Seed Runbook

This runbook classifies seed scripts for production use. Run seeds only after Alembic migrations have completed.

## Migration First

From the repository root:

```powershell
.venv\Scripts\alembic.exe upgrade head
```

Or:

```powershell
.venv\Scripts\python.exe -m alembic upgrade head
```

Current Alembic head should include dividend V1 tables:

- `20260510_000022`

Keep `ENABLE_DB_AUTO_CREATE_ALL=false` in production.

## Recommended Production Seed Order

Run from repository root unless noted otherwise.

1. VIP levels:

```powershell
.venv\Scripts\python.exe backend\scripts\seed_vip_levels.py
```

2. Market categories:

```powershell
.venv\Scripts\python.exe backend\scripts\seed_market_categories.py
```

3. API-selection trading pairs:

```powershell
.venv\Scripts\python.exe backend\scripts\seed_api_selection_trading_pairs.py
```

4. Market sub-categories:

```powershell
.venv\Scripts\python.exe backend\scripts\seed_market_sub_categories.py
```

5. Contract stock symbols:

```powershell
.venv\Scripts\python.exe backend\scripts\seed_contract_stock_symbols.py
```

6. TradFi CFD symbols:

```powershell
.venv\Scripts\python.exe backend\scripts\seed_contract_tradfi_cfd_symbols.py
```

## Safe To Re-Run With Review

These scripts appear intended to upsert or update configured reference data, but should still be reviewed before repeated production runs:

- `seed_vip_levels.py`
- `seed_market_categories.py`
- `seed_market_sub_categories.py`
- `seed_api_selection_trading_pairs.py`
- `seed_contract_stock_symbols.py`
- `seed_contract_tradfi_cfd_symbols.py`

Before re-running, check:

- target environment;
- database backup or rollback plan;
- whether symbols/categories were manually adjusted in admin;
- whether the script overwrites fields operators may have changed.

## Dev/Test Only

Do not run in production unless explicitly approved for a controlled test account:

- `seed_dividend_test_records.py`
- files named `test_*.py`
- audit scripts that only print diagnostics should not be treated as seed scripts.

## Manual SQL Status

`backend/scripts/dividend_v1_schema.sql` is retained as historical/manual reference. Production should prefer Alembic head after `20260510_000022_add_dividend_v1_tables.py`.

## Post-Seed Checks

- Admin VIP pages show expected VIP/SVIP levels.
- Market category filters show expected category/sub-category labels.
- Contract symbol admin pages show seeded CFD symbols.
- No user balances changed as part of seed execution.
- No chain transaction was sent.
