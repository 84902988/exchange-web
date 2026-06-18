# Release Commit Plan - 2026-06-19

本计划只整理当前工作区提交顺序和发布前确认项。未执行 `git add`，未执行 commit，未删除文件，未重启服务，未执行数据库写操作，未执行真实 cleanup，未修改交易、资金、订单、提现、归集、合约、分红、BD、邀请核心逻辑。

## 1. 当前 Git 状态摘要

已执行：

```powershell
git status --short --untracked-files=all
git diff --name-only
git diff --cached --name-only
```

结果摘要：

- 工作区存在 modified / deleted / untracked 文件。
- 暂存区为空，`git diff --cached --name-only` 无输出。
- `backend/tmp/`、`output/`、`data/geoip/` 当前未出现在 `git status` 中，已由 `.gitignore` 排除。

## 2. 当前剩余 BLOCKER

发布流程 BLOCKER：

- 工作区仍有大量未提交文件，不能直接整体提交或直接打上线包。
- 需要人工确认 env example、locale JSON、mobile 首页改动是否纳入本次发布。

配置确认 BLOCKER：

- 当前本地 DB 曾用于测试 `restricted_countries=["CN", "US"]`；生产确认名单为 `restricted_countries=["CN"]`，`US` 不作为生产限制国家。
- 生产是否正式拦截仍由 `enabled` / `monitor_mode` 控制；未确认前建议生产保持 `enabled=false` 或 `enabled=true + monitor_mode=true`。

## 3. 当前所有改动文件分组

### 3.1 release hygiene

- `.gitignore`

### 3.2 geo access

后端：

- `backend/app/core/config.py`
- `backend/app/db/models/__init__.py`
- `backend/app/db/models/geo_access.py`
- `backend/app/middleware/geo_restriction.py`
- `backend/app/routers/admin_pages.py`
- `backend/app/routers/geo_access.py`
- `backend/app/services/admin_queries.py`
- `backend/app/services/geo_access_service.py`
- `backend/requirements.txt`

迁移：

- `backend/alembic/versions/20260618_000103_add_geo_access_control.py`
- `backend/alembic/versions/20260618_000104_extend_geo_access_log_rollups.py`
- `backend/alembic/versions/20260618_000105_add_geo_access_log_bucket_index.py`

后台模板：

- `backend/templates/admin/geo_access.html`
- `backend/templates/admin/partials/sidebar.html`

前端页面层：

- `web/proxy.ts`
- `web/app/layout.tsx`
- `web/app/restricted/page.tsx`
- `web/components/layout/AppChrome.tsx`
- `web/lib/server/geoAccessProxy.ts`

文档：

- `docs/geo_access_control_v1.md`
- `docs/release/geo_access_production_confirmation_20260619.md`

注意：`backend/app/routers/admin_pages.py`、`backend/app/services/admin_queries.py`、`backend/templates/admin/partials/sidebar.html` 同时包含 DB Lifecycle 后台入口或展示改动；若严格按主题提交，建议使用 hunk 级 staging。

### 3.3 db lifecycle

后端：

- `backend/app/core/config.py`
- `backend/app/db/models/__init__.py`
- `backend/app/db/models/db_lifecycle_cleanup_log.py`
- `backend/app/jobs/db_lifecycle_cleanup_job.py`
- `backend/app/main.py`
- `backend/app/routers/admin_pages.py`
- `backend/app/services/admin_queries.py`
- `backend/app/services/stock_token_lock_service.py`

迁移：

- `backend/alembic/versions/20260619_000106_add_db_lifecycle_cleanup_logs.py`
- `backend/alembic/versions/20260619_000107_add_db_lifecycle_skip_fields.py`
- `backend/alembic/versions/20260619_000108_add_db_lifecycle_operation_mode.py`

脚本：

- `backend/scripts/audit_db_tables.py`
- `backend/scripts/enqueue_db_lifecycle_cleanup.py`
- `backend/scripts/run_db_lifecycle_cleanup.py`
- `backend/scripts/start_db_lifecycle_cleanup_scheduler.py`

后台模板：

- `backend/templates/admin/db_lifecycle.html`
- `backend/templates/admin/bd_commission_job_logs.html`
- `backend/templates/admin/dividend_job_logs.html`
- `backend/templates/admin/partials/sidebar.html`
- `backend/templates/admin/stock_token_release_logs.html`

文档：

- `docs/core_financial_tables_lifecycle_policy_v1.md`
- `docs/db_lifecycle_policy_v1.md`
- `docs/db_table_lifecycle_audit_20260619.md`

注意：`backend/app/core/config.py`、`backend/app/db/models/__init__.py`、`backend/app/routers/admin_pages.py`、`backend/app/services/admin_queries.py` 与 Geo Access 共享改动，提交时需要人工确认 hunk 分配。

### 3.4 release docs

- `docs/release/release_readiness_audit_20260619.md`
- `docs/release/release_blockers_fix_20260619.md`
- `docs/release/release_blockers_fix_v2_20260619.md`
- `docs/release/geo_access_production_confirmation_20260619.md`
- `docs/release/release_commit_plan_20260619.md`

### 3.5 env examples

- `.env.example`
- `backend/.env.example`
- `web/.env.example`

### 3.6 locales

- `web/config/locales/en.json`
- `web/config/locales/ja.json`
- `web/config/locales/zh-TW.json`
- `web/config/locales/zh.json`

### 3.7 mobile

- `mobile/src/components/home/InfoFeed.tsx`，当前为删除
- `mobile/src/components/home/HomeNewsFeed.tsx`
- `mobile/src/components/home/QuickEntryRow.tsx`
- `mobile/src/components/home/TabbedMarketList.tsx`
- `mobile/src/screens/home/HomeScreen.tsx`

### 3.8 不应提交

当前已被 `.gitignore` 排除，不应提交：

- `.env`
- `.env.*`，除了 `.env.example`
- `backend/.env`
- `web/.env.local`
- GeoIP DB：`*.mmdb`
- GeoIP 配置：`GeoIP.conf`
- `data/geoip/`
- `backend/data/geoip/`
- `backend/tmp/`
- `output/`
- build 产物：`.next/`、`out/`、`build/`、`coverage/`
- keystore / private key：`*.pem`、`*.key`、`*.p12`、`*.pfx`、`*.jks`、`id_rsa*`、`id_ed25519*`

## 4. 建议提交顺序

### 4.1 Commit 1

建议 message：

```text
chore: update release hygiene ignores
```

文件清单：

- `.gitignore`

提交前建议验证：

```powershell
git check-ignore data/geoip/GeoIP.conf
git check-ignore data/geoip/GeoLite2-Country.mmdb
git check-ignore backend/tmp/site_settings_id1_stock_token_notice_i18n_backup_20260616.md
git check-ignore output/pdf/trading-rules-ops-confirmation-v1.pdf
git diff --check
```

### 4.2 Commit 2

建议 message：

```text
feat: add geo access control
```

文件清单：

- `backend/alembic/versions/20260618_000103_add_geo_access_control.py`
- `backend/alembic/versions/20260618_000104_extend_geo_access_log_rollups.py`
- `backend/alembic/versions/20260618_000105_add_geo_access_log_bucket_index.py`
- `backend/app/db/models/geo_access.py`
- `backend/app/middleware/geo_restriction.py`
- `backend/app/routers/geo_access.py`
- `backend/app/services/geo_access_service.py`
- `backend/templates/admin/geo_access.html`
- `web/proxy.ts`
- `web/app/layout.tsx`
- `web/app/restricted/page.tsx`
- `web/components/layout/AppChrome.tsx`
- `web/lib/server/geoAccessProxy.ts`
- `docs/geo_access_control_v1.md`

共享文件需按 hunk 或人工确认纳入：

- `backend/app/core/config.py`
- `backend/app/db/models/__init__.py`
- `backend/app/routers/admin_pages.py`
- `backend/app/services/admin_queries.py`
- `backend/templates/admin/partials/sidebar.html`
- `backend/requirements.txt`

提交前建议验证：

```powershell
git diff --check
cd backend
..\.venv\Scripts\python.exe -m compileall app scripts
alembic current
alembic heads
cd ..\web
npm.cmd run build
npm.cmd run lint -- proxy.ts app/restricted/page.tsx components/layout/AppChrome.tsx
```

### 4.3 Commit 3

建议 message：

```text
feat: add db lifecycle governance
```

文件清单：

- `backend/alembic/versions/20260619_000106_add_db_lifecycle_cleanup_logs.py`
- `backend/alembic/versions/20260619_000107_add_db_lifecycle_skip_fields.py`
- `backend/alembic/versions/20260619_000108_add_db_lifecycle_operation_mode.py`
- `backend/app/db/models/db_lifecycle_cleanup_log.py`
- `backend/app/jobs/db_lifecycle_cleanup_job.py`
- `backend/app/main.py`
- `backend/app/services/stock_token_lock_service.py`
- `backend/scripts/audit_db_tables.py`
- `backend/scripts/enqueue_db_lifecycle_cleanup.py`
- `backend/scripts/run_db_lifecycle_cleanup.py`
- `backend/scripts/start_db_lifecycle_cleanup_scheduler.py`
- `backend/templates/admin/db_lifecycle.html`
- `backend/templates/admin/bd_commission_job_logs.html`
- `backend/templates/admin/dividend_job_logs.html`
- `backend/templates/admin/stock_token_release_logs.html`
- `docs/core_financial_tables_lifecycle_policy_v1.md`
- `docs/db_lifecycle_policy_v1.md`
- `docs/db_table_lifecycle_audit_20260619.md`

共享文件需按 hunk 或人工确认纳入：

- `backend/app/core/config.py`
- `backend/app/db/models/__init__.py`
- `backend/app/routers/admin_pages.py`
- `backend/app/services/admin_queries.py`
- `backend/templates/admin/partials/sidebar.html`

提交前建议验证：

```powershell
git diff --check
cd backend
..\.venv\Scripts\python.exe -m compileall app scripts
alembic current
alembic heads
```

建议额外做 dry-run 验证，不执行真实删除：

```powershell
cd backend
..\.venv\Scripts\python.exe scripts\run_db_lifecycle_cleanup.py --dry-run
```

### 4.4 Commit 4

建议 message：

```text
docs: add release readiness audits
```

文件清单：

- `docs/release/release_readiness_audit_20260619.md`
- `docs/release/release_blockers_fix_20260619.md`
- `docs/release/release_blockers_fix_v2_20260619.md`
- `docs/release/geo_access_production_confirmation_20260619.md`
- `docs/release/release_commit_plan_20260619.md`

提交前建议验证：

```powershell
git diff --check
```

### 4.5 待确认后再决定

建议 message：

```text
chore: update env examples
```

候选文件：

- `.env.example`
- `backend/.env.example`
- `web/.env.example`

提交前确认：

- 是否仅包含模板字段，不包含真实密钥。
- 是否覆盖 Geo Access、DB Lifecycle、RQ、Moralis、RPC、Hot Wallet、SMTP / DirectMail、ITICK 等生产必填项。

建议 message：

```text
chore: update locale dictionaries
```

候选文件：

- `web/config/locales/en.json`
- `web/config/locales/ja.json`
- `web/config/locales/zh-TW.json`
- `web/config/locales/zh.json`

提交前建议验证：

```powershell
cd web
npm.cmd run build
```

建议 message：

```text
feat: refine mobile home experience
```

候选文件：

- `mobile/src/components/home/InfoFeed.tsx`
- `mobile/src/components/home/HomeNewsFeed.tsx`
- `mobile/src/components/home/QuickEntryRow.tsx`
- `mobile/src/components/home/TabbedMarketList.tsx`
- `mobile/src/screens/home/HomeScreen.tsx`

提交前建议验证：

```powershell
cd mobile
npm.cmd run lint
```

## 5. 待人工确认项

- env example 是否纳入本次发布。
- locale JSON 是否纳入本次发布。
- mobile 首页改动是否纳入本次发布。
- Geo Access 是否作为生产正式拦截配置。
- Geo Access 生产名单已确认为 `CN` only。
- `US` 仅为测试项，不进入生产限制名单。
- 生产是否保持 `monitor_mode=true` 先观察。
- 是否确认 GeoIP DB 授权、部署路径和更新责任方。

## 6. 提交前总体验证建议

建议在最终分组提交前至少执行：

```powershell
git diff --check
```

后端：

```powershell
cd backend
..\.venv\Scripts\python.exe -m compileall app scripts
alembic current
alembic heads
```

Jinja：

```powershell
cd backend
@'
from pathlib import Path
from jinja2 import Environment, FileSystemLoader
env = Environment(loader=FileSystemLoader("templates"))
for path in Path("templates").rglob("*.html"):
    env.get_template(str(path.relative_to("templates")).replace("\\", "/"))
print("jinja parse ok")
'@ | ..\.venv\Scripts\python.exe -
```

前端：

```powershell
cd web
npm.cmd run build
npm.cmd run lint -- proxy.ts app/restricted/page.tsx components/layout/AppChrome.tsx
```

移动端，如纳入 mobile 改动：

```powershell
cd mobile
npm.cmd run lint
```

## 7. 结论

当前可以进入提交前人工确认阶段，但不建议直接 `git add .`。建议先确认 env / locale / mobile 是否纳入，再按提交顺序使用路径级或 hunk 级 staging。
