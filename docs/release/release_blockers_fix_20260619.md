# Release BLOCKER Fix V1 - 2026-06-19

本轮只处理发布卫生和上线阻断项。未修改交易、资金、订单、提现、归集、合约、分红、BD、邀请核心逻辑；未执行数据库写操作；未执行真实 cleanup；未重启服务；未关闭 PyCharm；未 kill 进程。

## 1. 本轮处理的 BLOCKER

### 1.1 GeoIP 文件误入库风险

已更新根目录 `.gitignore`，新增忽略规则：

```gitignore
*.mmdb
GeoIP.conf
data/geoip/
backend/data/geoip/
```

处理原则：

- 不删除运营本地 GeoIP 文件。
- 不移动本地 GeoIP 文件。
- 仅确保 GeoIP 数据库与配置文件不会进入 Git。

验证结果：

```powershell
git check-ignore -v data/geoip/GeoIP.conf
```

结果：

```text
.gitignore:58:data/geoip/    data/geoip/GeoIP.conf
```

```powershell
git check-ignore -v data/geoip/GeoLite2-Country.mmdb
```

结果：

```text
.gitignore:58:data/geoip/    data/geoip/GeoLite2-Country.mmdb
```

`git status --short --untracked-files=all` 中已不再显示 `data/geoip/GeoIP.conf` 或 `data/geoip/GeoLite2-Country.mmdb`。

## 2. 当前工作区文件分组

以下分组来自只读 `git status --short --untracked-files=all`，本轮未自动 commit。

### 2.1 应提交代码

发布卫生：

- `.gitignore`

Geo Access / DB Lifecycle 后端代码：

- `backend/app/core/config.py`
- `backend/app/db/models/__init__.py`
- `backend/app/main.py`
- `backend/app/middleware/geo_restriction.py`
- `backend/app/routers/admin_pages.py`
- `backend/app/routers/geo_access.py`
- `backend/app/services/admin_queries.py`
- `backend/app/services/geo_access_service.py`
- `backend/app/db/models/db_lifecycle_cleanup_log.py`
- `backend/app/db/models/geo_access.py`
- `backend/app/jobs/db_lifecycle_cleanup_job.py`
- `backend/scripts/audit_db_tables.py`
- `backend/scripts/enqueue_db_lifecycle_cleanup.py`
- `backend/scripts/run_db_lifecycle_cleanup.py`
- `backend/scripts/start_db_lifecycle_cleanup_scheduler.py`
- `backend/requirements.txt`

前端 Geo Access 页面层：

- `web/proxy.ts`
- `web/app/layout.tsx`
- `web/app/restricted/page.tsx`
- `web/components/layout/AppChrome.tsx`
- `web/lib/server/geoAccessProxy.ts`

非核心业务的运营/展示代码：

- `backend/app/services/stock_token_lock_service.py`

### 2.2 应提交迁移

- `backend/alembic/versions/20260618_000103_add_geo_access_control.py`
- `backend/alembic/versions/20260618_000104_extend_geo_access_log_rollups.py`
- `backend/alembic/versions/20260618_000105_add_geo_access_log_bucket_index.py`
- `backend/alembic/versions/20260619_000106_add_db_lifecycle_cleanup_logs.py`
- `backend/alembic/versions/20260619_000107_add_db_lifecycle_skip_fields.py`
- `backend/alembic/versions/20260619_000108_add_db_lifecycle_operation_mode.py`

### 2.3 应提交模板

- `backend/templates/admin/bd_commission_job_logs.html`
- `backend/templates/admin/db_lifecycle.html`
- `backend/templates/admin/dividend_job_logs.html`
- `backend/templates/admin/geo_access.html`
- `backend/templates/admin/partials/sidebar.html`
- `backend/templates/admin/stock_token_release_logs.html`

### 2.4 应提交文档

- `docs/core_financial_tables_lifecycle_policy_v1.md`
- `docs/db_lifecycle_policy_v1.md`
- `docs/db_table_lifecycle_audit_20260619.md`
- `docs/geo_access_control_v1.md`
- `docs/release/release_readiness_audit_20260619.md`
- `docs/release/release_blockers_fix_20260619.md`

### 2.5 不应提交文件

以下文件属于本地备份、输出或临时产物，建议不要进入上线提交：

- `backend/tmp/site_settings_id1_stock_token_notice_i18n_backup_20260616.md`
- `output/pdf/trading-rules-ops-confirmation-v1.pdf`
- `data/geoip/GeoIP.conf`，已被 `.gitignore` 忽略
- `data/geoip/GeoLite2-Country.mmdb`，已被 `.gitignore` 忽略

### 2.6 待人工确认文件

以下改动可能属于前序需求成果，但上线前建议由负责人确认是否纳入本次发布：

- `.env.example`
- `backend/.env.example`
- `web/.env.example`
- `web/config/locales/en.json`
- `web/config/locales/ja.json`
- `web/config/locales/zh-TW.json`
- `web/config/locales/zh.json`
- `mobile/src/components/home/InfoFeed.tsx`，当前为删除
- `mobile/src/components/home/HomeNewsFeed.tsx`
- `mobile/src/components/home/QuickEntryRow.tsx`
- `mobile/src/components/home/TabbedMarketList.tsx`
- `mobile/src/screens/home/HomeScreen.tsx`

## 3. Geo Access 生产配置确认清单

本轮只读确认了当前本地 DB 状态，未修改 DB。

当前 `geo_access_settings`：

```text
enabled=true
monitor_mode=false
block_unknown=false
admin_exempt=true
restricted_countries=["CN"]
updated_at=2026-06-18 16:55:11
```

说明：早前本地 DB 曾包含 `["CN", "US"]`，其中 `US` 仅用于测试，不进入生产限制名单。生产确认名单为 `["CN"]`。

运营上线前必须确认：

- 是否正式启用地区限制。
- 是否从 monitor mode 切换到 block mode。
- `restricted_countries` 最终国家/地区名单。
- 是否拦截未识别地区 `UNKNOWN`。
- 是否后台 `/admin` 豁免。
- 是否信任 Cloudflare `CF-IPCountry`。
- GeoIP DB 部署路径，例如 `GEOIP_DB_PATH`。

若运营未确认，生产建议保持：

- `enabled=false`，或
- `enabled=true` 且 `monitor_mode=true`。

## 4. 仍待处理项

BLOCKER：

- 当前工作区仍存在大量未提交文件，尚不能直接打上线包。
- 当前本地 DB 曾用于测试 CN / US；生产确认名单为 CN only，US 不作为生产限制国家。是否正式拦截仍必须由运营确认。

P0：

- staging 前排除 `backend/tmp/` 与 `output/` 本地产物。
- 上线前确认 `.env.example` / `backend/.env.example` / `web/.env.example` 是否需要补齐且不包含真实密钥。
- 确认移动端首页相关改动是否纳入本次发布。

PASS：

- GeoIP 本地文件误入库风险已通过 `.gitignore` 收口。
- `data/geoip/GeoIP.conf` 与 `data/geoip/GeoLite2-Country.mmdb` 已通过 `git check-ignore` 验证。

## 5. 验证结果

已执行：

- `git status --short --branch`
- `git status --short --untracked-files=all`
- `git check-ignore -v data/geoip/GeoIP.conf`
- `git check-ignore -v data/geoip/GeoLite2-Country.mmdb`
- 只读查询 `geo_access_settings`

未执行：

- 未执行数据库写操作。
- 未执行真实 cleanup。
- 未删除本地 GeoIP 文件。
- 未重启服务。
- 未自动 commit。
