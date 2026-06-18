# Release BLOCKER Fix V2 - 2026-06-19

本轮目标是继续处理剩余上线阻断项：工作区发布卫生与 Geo Access 运营确认单。未修改交易、资金、订单、提现、归集、合约、分红、BD、邀请核心逻辑；未执行数据库写操作；未执行真实 cleanup；未重启服务；未自动 commit；未删除文件。

## 1. 已解决 BLOCKER

### 1.1 GeoIP 文件误入库风险

`.gitignore` 已覆盖：

```gitignore
*.mmdb
GeoIP.conf
data/geoip/
backend/data/geoip/
```

验证：

```text
.gitignore:58:data/geoip/    data/geoip/GeoIP.conf
.gitignore:58:data/geoip/    data/geoip/GeoLite2-Country.mmdb
```

`git status --short --untracked-files=all` 中不再显示 `data/geoip/`。

### 1.2 本地 tmp / output 产物误提交风险

`.gitignore` 已补充：

```gitignore
backend/tmp/
output/
```

验证：

```text
.gitignore:77:backend/tmp/    backend/tmp/site_settings_id1_stock_token_notice_i18n_backup_20260616.md
.gitignore:78:output/         output/pdf/trading-rules-ops-confirmation-v1.pdf
```

`git status --short --untracked-files=all` 中不再显示 `backend/tmp/` 或 `output/`。

### 1.3 Geo Access 生产确认单

已新增：

- `docs/release/geo_access_production_confirmation_20260619.md`

该文档明确当前本地 DB 配置、生产上线前运营确认项、安全默认和责任边界。

## 2. 仍剩 BLOCKER

当前仍有一个发布流程 BLOCKER：

- 工作区仍有大量未提交文件。上线前需要人工确认提交范围并分组提交。

配置层 BLOCKER：

- 当前本地 DB 曾用于测试 `restricted_countries=["CN", "US"]`；生产确认名单为 `restricted_countries=["CN"]`，`US` 不作为生产限制国家。是否正式拦截仍由 `enabled` / `monitor_mode` 控制，并必须由运营确认。

## 3. 当前工作区发布卫生分组

来源：`git status --short --untracked-files=all`。

### A. 必须提交：代码

发布卫生：

- `.gitignore`

Geo Access 后端：

- `backend/app/core/config.py`
- `backend/app/db/models/__init__.py`
- `backend/app/middleware/geo_restriction.py`
- `backend/app/routers/admin_pages.py`
- `backend/app/routers/geo_access.py`
- `backend/app/services/admin_queries.py`
- `backend/app/services/geo_access_service.py`
- `backend/app/db/models/geo_access.py`
- `backend/requirements.txt`

Geo Access 前端页面层：

- `web/proxy.ts`
- `web/app/layout.tsx`
- `web/app/restricted/page.tsx`
- `web/components/layout/AppChrome.tsx`
- `web/lib/server/geoAccessProxy.ts`

DB Lifecycle：

- `backend/app/main.py`
- `backend/app/db/models/db_lifecycle_cleanup_log.py`
- `backend/app/jobs/db_lifecycle_cleanup_job.py`
- `backend/scripts/audit_db_tables.py`
- `backend/scripts/enqueue_db_lifecycle_cleanup.py`
- `backend/scripts/run_db_lifecycle_cleanup.py`
- `backend/scripts/start_db_lifecycle_cleanup_scheduler.py`

非核心业务的运营日志降噪：

- `backend/app/services/stock_token_lock_service.py`

### B. 必须提交：Alembic 迁移

- `backend/alembic/versions/20260618_000103_add_geo_access_control.py`
- `backend/alembic/versions/20260618_000104_extend_geo_access_log_rollups.py`
- `backend/alembic/versions/20260618_000105_add_geo_access_log_bucket_index.py`
- `backend/alembic/versions/20260619_000106_add_db_lifecycle_cleanup_logs.py`
- `backend/alembic/versions/20260619_000107_add_db_lifecycle_skip_fields.py`
- `backend/alembic/versions/20260619_000108_add_db_lifecycle_operation_mode.py`

### C. 必须提交：后台模板 / 前端页面

后台模板：

- `backend/templates/admin/bd_commission_job_logs.html`
- `backend/templates/admin/db_lifecycle.html`
- `backend/templates/admin/dividend_job_logs.html`
- `backend/templates/admin/geo_access.html`
- `backend/templates/admin/partials/sidebar.html`
- `backend/templates/admin/stock_token_release_logs.html`

前端页面：

- `web/app/restricted/page.tsx`
- `web/components/layout/AppChrome.tsx`
- `web/lib/server/geoAccessProxy.ts`
- `web/proxy.ts`

### D. 必须提交：文档

- `docs/core_financial_tables_lifecycle_policy_v1.md`
- `docs/db_lifecycle_policy_v1.md`
- `docs/db_table_lifecycle_audit_20260619.md`
- `docs/geo_access_control_v1.md`
- `docs/release/geo_access_production_confirmation_20260619.md`
- `docs/release/release_blockers_fix_20260619.md`
- `docs/release/release_blockers_fix_v2_20260619.md`
- `docs/release/release_readiness_audit_20260619.md`

### E. 待人工确认：env example / locale / mobile 改动

Env example：

- `.env.example`
- `backend/.env.example`
- `web/.env.example`

Locale：

- `web/config/locales/en.json`
- `web/config/locales/ja.json`
- `web/config/locales/zh-TW.json`
- `web/config/locales/zh.json`

Mobile：

- `mobile/src/components/home/InfoFeed.tsx`，当前为删除
- `mobile/src/components/home/HomeNewsFeed.tsx`
- `mobile/src/components/home/QuickEntryRow.tsx`
- `mobile/src/components/home/TabbedMarketList.tsx`
- `mobile/src/screens/home/HomeScreen.tsx`

### F. 必须排除：tmp / output / 本地生成物 / GeoIP 文件

以下路径已经被 `.gitignore` 覆盖，不应提交：

- `data/geoip/`
- `backend/data/geoip/`
- `*.mmdb`
- `GeoIP.conf`
- `backend/tmp/`
- `output/`

当前状态：

- `data/geoip/` 未出现在 `git status`。
- `backend/tmp/` 未出现在 `git status`。
- `output/` 未出现在 `git status`。

## 4. 提交分组建议

只输出建议，不执行 commit。

### 4.1 `feat: add geo access control`

建议包含：

- Geo Access 后端代码
- Geo Access Alembic 迁移
- Geo Access 后台页面
- `/restricted` 页面
- 前端 proxy / middleware / AppChrome 相关
- Geo Access 文档

### 4.2 `feat: add db lifecycle governance`

建议包含：

- DB Lifecycle cleanup job
- cleanup logs model / migration
- 核心表保护常量与护栏
- DB Lifecycle 后台页
- DB Lifecycle scripts
- DB Lifecycle 文档

### 4.3 `docs: add release readiness audit`

建议包含：

- `docs/release/release_readiness_audit_20260619.md`
- `docs/release/release_blockers_fix_20260619.md`
- `docs/release/release_blockers_fix_v2_20260619.md`
- `docs/release/geo_access_production_confirmation_20260619.md`

### 4.4 `chore: update release hygiene ignores`

建议包含：

- `.gitignore`

### 4.5 `feat: refine mobile home experience`

仅在人工确认移动端首页改动纳入本次发布后提交，建议包含：

- `mobile/src/components/home/InfoFeed.tsx`
- `mobile/src/components/home/HomeNewsFeed.tsx`
- `mobile/src/components/home/QuickEntryRow.tsx`
- `mobile/src/components/home/TabbedMarketList.tsx`
- `mobile/src/screens/home/HomeScreen.tsx`

## 5. 不应提交文件

不应提交：

- 本地 GeoIP DB 文件。
- GeoIP 配置文件。
- `backend/tmp/` 下备份文件。
- `output/` 下生成 PDF。
- 任何真实 `.env`。
- 任何 keystore / private key / secret。

## 6. 下一步是否可以提交

当前状态：**暂不建议直接提交全部工作区**。

可以进入提交前准备，但需要先完成：

1. 人工确认 Env example 是否全部纳入。
2. 人工确认 locale JSON 是否全部纳入。
3. 人工确认 mobile 首页改动是否纳入。
4. 确认提交时不 stage `backend/tmp/`、`output/`、`data/geoip/`。
5. 确认 Geo Access 生产策略由运营签核。

完成以上确认后，可以按第 4 节分组提交。

## 7. 验证

已执行：

- `git status --short --untracked-files=all`
- `git check-ignore -v data/geoip/GeoIP.conf`
- `git check-ignore -v data/geoip/GeoLite2-Country.mmdb`
- `git check-ignore -v backend/tmp/site_settings_id1_stock_token_notice_i18n_backup_20260616.md`
- `git check-ignore -v output/pdf/trading-rules-ops-confirmation-v1.pdf`
- 只读查询 `geo_access_settings`

未执行：

- 未执行数据库写操作。
- 未执行真实 cleanup。
- 未重启服务。
- 未自动 commit。
- 未删除文件。
