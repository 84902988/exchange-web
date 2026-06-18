# 上线前内部审计证据

审计日期：2026-06-16  
审计范围：Git 与敏感信息、后端静态检查、前端构建检查、Jinja/后台模板、后台页面与查询策略、RBAC、数据库迁移与 seed、RQ/Worker/Scheduler/Loop、资金安全保护。  
审计边界：本报告为内部审计证据文件，不是提交给甲方的正式报告。

## 一、执行边界

本轮按要求未执行以下动作：

- 未启动浏览器。
- 未启动本地 uvicorn / dev server。
- 未做 TestClient / httpx 冒烟。
- 未连接外部生产服务。
- 未执行真实链上发送、提现、归集、补 Gas、分红发放、BD/邀请发放等真实资金动作。
- 未修改数据库数据。
- 未提交 git commit。

本轮仅创建/更新审计证据文件：`docs/release/release_audit_evidence_20260616.md`。

## 二、Git 与敏感信息

### 2.1 Git 状态

执行命令：

```text
git status --short
git diff --stat
git diff --name-status
git diff --cached --name-status
```

结果摘要：

- 当前分支：`cx/end-of-day-code-update-20260615`
- 工作区存在未提交变更。
- 已修改文件：47 个。
- diff 摘要：`47 files changed, 3206 insertions(+), 625 deletions(-)`。
- 暂存区：未发现 staged diff。
- 未跟踪新增文件覆盖 Alembic revision、后台服务、脚本、后台模板、前端法务页面等路径。

主要未跟踪新增项：

- `backend/alembic/versions/20260615_000095_backfill_stock_token_locks_notice_i18n.py`
- `backend/alembic/versions/20260616_000096_add_collection_gas_cost_records.py`
- `backend/alembic/versions/20260616_000097_init_collection_gas_topup_config.py`
- `backend/alembic/versions/20260616_000098_add_trade_id_to_contract_logs.py`
- `backend/alembic/versions/20260616_000099_add_about_page_sections_to_site_settings.py`
- `backend/alembic/versions/20260616_000100_add_legal_pages_to_site_settings.py`
- `backend/alembic/versions/20260616_000101_add_market_data_provider_config.py`
- `backend/alembic/versions/20260616_000102_add_spot_market_data_providers.py`
- `backend/app/db/models/market_data_provider.py`
- `backend/app/jobs/contract_accounting_reconciliation_job.py`
- `backend/app/jobs/contract_accounting_reconciliation_scheduler.py`
- `backend/templates/admin/collection_gas_costs.html`
- `backend/templates/admin/market_providers.html`
- `backend/templates/admin/site_about_page.html`
- `backend/templates/admin/site_legal_pages.html`
- `web/app/privacy/`
- `web/app/risk/`
- `web/app/terms/`
- `web/components/legal/`

审计判断：

- 当前工作区未冻结，存在较大范围变更，正式上线前应完成代码审阅、测试、提交和 tag/版本固化。
- 本轮未回退、未提交、未改业务代码。

### 2.2 环境样例与敏感文件

执行检查：

```text
Test-Path .env
Test-Path .env.example
Test-Path backend/.env
Test-Path backend/.env.example
Test-Path web/.env
Test-Path web/.env.example
git ls-files | Select-String -Pattern '(^|/)(\.env|\.env\..*|.*\.pem|.*\.key|.*id_rsa.*)$'
```

结果摘要：

- `.env.example` 存在并已跟踪。
- `backend/.env.example` 存在并已跟踪。
- `web/.env.example` 存在并已跟踪。
- `backend/.env` 本地存在，但未显示为已跟踪文件。
- `.env` 不存在。
- `web/.env` 不存在。
- `.gitignore` 包含 `.env`、`.env.*`、密钥文件、证书文件、私钥文件、`.next/`、`.next.*/`、`node_modules/` 等忽略规则。

敏感字面量扫描：

- 64 位十六进制扫描命中 `TRANSFER_TOPIC = 0xddf252ad...`，属于 ERC20 Transfer event topic，不是私钥。
- 未发现 `.env`、私钥文件、token 文件、热钱包私钥文件进入版本库。
- `.env.example` 中敏感字段为 `change-me` 或空值，例如 `JWT_SECRET=change-me-long-random-string`、`HOT_WALLET_PRIVATE_KEY=`、`COLLECTION_GAS_HOT_PRIVATE_KEY=`。

审计判断：

- 未发现真实私钥、真实 token、真实数据库连接串进入版本库的直接证据。
- `backend/.env` 本地存在，应在正式交付前确认不会被打包、复制或误提交。

## 三、后端静态检查

### 3.1 Python py_compile

执行范围：

- `backend/app/**/*.py`
- `backend/scripts/**/*.py`
- `backend/alembic/**/*.py`
- `alembic/**/*.py`，如存在

执行结果：

```text
PY_FILES=413
PY_COMPILE_FAILURES=0
```

审计判断：

- 后端 Python 文件未发现语法级编译错误。
- 未启动 API。

## 四、前端构建检查

### 4.1 Locale JSON parse

执行结果：

```text
OK web/config/locales/en.json
OK web/config/locales/ja.json
OK web/config/locales/zh-TW.json
OK web/config/locales/zh.json
LOCALE_JSON_OK=4 FAIL=0
```

审计判断：

- JSON 语法全部通过。
- 但多语言文案存在真实 `????` 文案，详见风险清单 R-004。

### 4.2 npm run build

PowerShell 下直接执行 `npm run build` 被执行策略阻止：

```text
npm.ps1 cannot be loaded because running scripts is disabled on this system.
```

改用 Windows 可执行入口：

```text
npm.cmd run build
```

执行结果：

- Next.js 16.0.10 build 成功。
- 生成 101 个静态页面。
- 未启动 dev server。

Build warning：

- `baseline-browser-mapping` 数据超过两个月，建议更新。
- Next.js 检测到多个 lockfile，并选择 `D:\exchange-web\package-lock.json` 作为 workspace root；另有 `D:\exchange-web\web\package-lock.json`。
- `caniuse-lite` browsers data 约 6 个月未更新。

审计判断：

- 构建通过。
- 多 lockfile 和浏览器数据过期属于非阻塞但需清理的发布卫生问题。

### 4.3 Lint

直接执行：

```text
npm.cmd run lint
```

结果：

- 失败。
- 主要原因之一是 ESLint 扫描到历史构建目录 `web/.next.codex-backup-20260611-0343`，产生大量生成产物错误。

定向源码 lint：

```text
.\node_modules\.bin\eslint.cmd app components config lib proxy.ts next.config.ts eslint.config.mjs
```

结果：

```text
76 problems (43 errors, 33 warnings)
```

主要错误类型：

- `@typescript-eslint/no-explicit-any`
- `react-hooks/set-state-in-effect`
- `@typescript-eslint/no-require-imports`
- `@next/next/no-html-link-for-pages`

代表性位置：

- `web/app/committee/page.tsx:10`
- `web/app/lending/page.tsx:16`
- `web/components/trading/Chart.tsx:5`
- `web/components/trading/Chart.tsx:314`
- `web/components/trading/TradingForm.tsx:99`
- `web/components/ui/UnderDevelopment.tsx:19`
- `web/lib/api/core/http.ts:9`

审计判断：

- 构建通过，但源码 lint 未通过。
- 若上线流水线将 lint 作为 gate，则需上线前处理。

## 五、Jinja / 后台模板检查

### 5.1 后台模板 parse

系统 Python 缺少 `jinja2`，使用项目 `.venv` 执行解析。

执行结果：

```text
JINJA_ADMIN_TEMPLATES=101
JINJA_PARSE_FAILURES=0
```

审计判断：

- 后台 admin 模板 Jinja parse 通过。

### 5.2 乱码、占位、错误文案扫描

扫描范围：

- `backend/templates/admin`
- `backend/app/routers`
- `backend/app/services`
- `web/app`
- `web/components`
- `web/config`

排除：

- `web/.next/**`
- `web/.next.codex-backup-*/**`
- `node_modules/**`
- `backend/templates/admin/_archive/**`
- `backend/tmp/**`

重点命中：

- `web/config/locales/zh.json` 存在 20 行 `???` 文案。
- `web/config/locales/zh-TW.json` 存在 20 行 `???` 文案。
- `web/config/locales/ja.json` 存在 25 行 `???` 文案。
- `web/components/trading/TradingPage.tsx:89` 使用 `mockAssetData`。
- `web/components/trading/TradingPage.tsx:135` 初始化 `assetData` 为 `mockAssetData`。
- `backend/app/routers/kyc.py:449`、`backend/app/routers/kyc.py:483` 存在 TODO：后续接入真实管理员 ID。
- `backend/app/services/admin_queries.py:22654-22658` 仍将 VIP / Dealer 风控写操作绑定到 stub。

审计判断：

- 模板语法通过，但仍存在真实占位/模拟数据/stub 风险。

## 六、后台页面与查询策略静态复核

### 6.1 后台核心页面覆盖

侧边栏权限与页面入口覆盖了以下核心模块：

- 用户管理：`backend/app/routers/admin_pages.py`、`backend/templates/admin/partials/sidebar.html`
- 资产查询：`/admin/assets`
- 充值记录：`/admin/deposit-records`
- 提现记录 / 出金审核：`/admin/withdraw-records`、`/admin/withdraw-reviews`
- 现货订单 / 成交：`/admin/orders`、`/admin/trades`
- 合约账户 / 持仓 / 订单 / 成交：`/admin/contract-accounts`、`/admin/contract-positions`、`/admin/contract-orders`、`/admin/contract-trades`
- 交易对配置：`/admin/pairs`
- 资产 / 链 / 币种网络配置：`/admin/asset-configs`
- 平台账户 / 调账：`/admin/platform/accounts`、`/admin/platform/adjust`
- Dealer 风控：`/admin/platform/dealer-risk`
- VIP / 分红 / BD / 邀请：`/admin/vip-*`、`/admin/dividend-*`、`/admin/bd/*`、`/admin/invite/*`
- 归集 / Gas / Job Logs：`/admin/collections/*`、`/admin/system/rq`、`/admin/*/job-logs`
- White-Label / Banner / 公告：`/admin/site-settings`、`/admin/home-banners`、`/admin/announcements`
- 管理员 / 角色 / RBAC：`/admin/admin-users`、`/admin/admin-roles`

### 6.2 假数据 / stub / 旧占位

明确风险：

- Dealer 风控保存、启停、状态切换函数仍绑定 `_ok_stub`，页面可返回成功但不保证落库。
- VIP 费率等级启停、规则更新函数仍绑定 `_ok_stub`。
- `web/components/trading/TradingPage.tsx` 仍有 `mockAssetData`。

### 6.3 大表查询策略

静态证据：

- `backend/app/routers/admin_pages.py:3875` 定义 balance logs 大表提示：默认最近 7 天，普通查询最大 30 天。
- `backend/app/routers/admin_pages.py:3915` `_balance_log_date_range` 默认返回最近 7 天。
- `backend/app/routers/admin_pages.py:3945` `_balance_log_has_precise_condition` 用于判断精准条件。
- `backend/app/routers/admin_pages.py:3949-3963` 定义 deposit、withdraw、orders、trades、contract orders、contract trades 的大表提示。
- `backend/app/routers/admin_pages.py:3365-3382` deposit records 对超过 30 天且无精准条件的查询进行阻断。
- `backend/app/routers/admin_pages.py:3506-3524` withdraw records 对超过 30 天且无精准条件的查询进行阻断。
- `backend/app/services/admin_queries.py` 相关查询函数均存在分页、时间条件或 `limit` 控制：
  - `admin_query_balance_logs`
  - `admin_query_unified_balance_logs`
  - `admin_query_orders`
  - `admin_query_trades`
  - `admin_query_deposit_records`
  - `admin_query_withdraw_records`
  - `list_admin_contract_orders`
  - `list_admin_contract_trades`
  - `admin_query_bd_commission_job_logs`
  - `admin_query_dividend_job_logs`

需关注：

- `withdraw_records_page` 对 `status=FAILED_GROUP` 且无显式日期时存在 `skip_default_date_filter` 分支，应确认该异常查询是否可控、是否会扫过大表。
- collection/job logs 通过 `_collection_task_date_range` 默认最近 7 天，并有超过 30 天的提示；需结合页面查询入口确认是否所有 job log 页面都强制执行同一策略。

## 七、RBAC 权限检查

### 7.1 `admin_pages.py` POST 统计

静态统计：

```text
ADMIN_PAGES_POST_HANDLERS=119
ADMIN_PAGES_POST_MISSING_ANY_PERMISSION=0
ADMIN_PAGES_POST_MANUAL_RBAC_CONTEXT=1
ADMIN_PAGES_POST_USING_GET_PERMISSION_HELPER=1
```

说明：

- `/admin/login` 作为登录入口不纳入高风险 POST 校验。
- `/uploads/image` 使用手动 RBAC 上下文校验，允许 `site_content.manage` 或 `trading_pairs.manage`。
- `/collections/auto-settings/{chain_key}/update` 使用 `require_admin_permission` 而非 `require_admin_post_permission`，仍有权限校验，但建议统一 POST helper。

### 7.2 `activity_admin.py` POST 统计

静态统计：

```text
backend/app/admin/activity_admin.py:POST_HANDLERS=8
```

8 个 POST 均仅见 `require_admin(request)` 登录态校验，未见 RBAC 权限点校验：

- `backend/app/admin/activity_admin.py:199` `/activities/new`
- `backend/app/admin/activity_admin.py:340` `/activities/{activity_id}/edit`
- `backend/app/admin/activity_admin.py:460` `/activities/{activity_id}/toggle-status`
- `backend/app/admin/activity_admin.py:482` `/activities/{activity_id}/delete`
- `backend/app/admin/activity_admin.py:557` `/activity-banners/new`
- `backend/app/admin/activity_admin.py:649` `/activity-banners/{banner_id}/edit`
- `backend/app/admin/activity_admin.py:721` `/activity-banners/{banner_id}/toggle-enabled`
- `backend/app/admin/activity_admin.py:743` `/activity-banners/{banner_id}/delete`

审计判断：

- CMS / Banner / 活动发布类 POST 属于后台高风险内容发布操作，应接入 `site_content.manage` 或独立活动管理权限。

## 八、数据库迁移与 seed 静态检查

### 8.1 Alembic revision

执行结果：

```text
ALEMBIC_FILES=101
ALEMBIC_REVISIONS_PARSED=101
ALEMBIC_SYNTAX_FAILURES=0
ALEMBIC_DUPLICATE_REVISIONS=0
ALEMBIC_MISSING_DOWN_REVISIONS=0
ALEMBIC_HEAD_COUNT=1
ALEMBIC_HEADS=20260616_000102
```

审计判断：

- Alembic revision 语法通过。
- 未发现重复 revision。
- 未发现明显断链。
- 当前为单 head。

### 8.2 Seed 脚本/迁移覆盖

静态发现：

- VIP 等级：`backend/scripts/seed_vip_levels.py`，`backend/alembic/versions/20260420_000002_seed_vip_levels.py`
- RBAC 权限 / 管理员角色：`backend/scripts/seed_admin_rbac.py`，`backend/alembic/versions/20260529_000058_add_admin_rbac_tables.py`
- 交易对：`backend/scripts/seed_api_selection_trading_pairs.py`，`backend/alembic/versions/20260505_000018_add_trading_pair_data_source.py`
- 资产 / 链配置：`backend/scripts/seed_chain_usdt_asset_configs.py`
- site_settings / banner / announcement：`backend/alembic/versions/20260510_000023_add_white_label_home_tables.py`、`backend/scripts/seed_about_page_content.py`、`backend/scripts/seed_legal_pages_content.py`

审计判断：

- 必要 seed / migration 文件存在。
- 本轮未实际连接数据库执行 seed，未验证目标环境 seed 状态。

## 九、RQ / Worker / Scheduler / Loop 静态检查

### 9.1 systemd 模板

发现模板：

- `deploy/systemd/exchange-api.service`
- `deploy/systemd/exchange-rq-withdraw.service`
- `deploy/systemd/exchange-rq-tx-confirm.service`
- `deploy/systemd/exchange-rq-gas.service`
- `deploy/systemd/exchange-rq-release.service`
- `deploy/systemd/exchange-rq-payout.service`
- `deploy/systemd/exchange-rq-email.service`
- `deploy/systemd/exchange-rq-maintenance.service`
- `deploy/systemd/exchange-rq-collection.service`
- `deploy/systemd/exchange-withdraw-fee-scheduler.service`
- `deploy/systemd/exchange-collection-auto-scheduler.service`
- `deploy/systemd/exchange-dealer-loop.service`
- `deploy/systemd/exchange-liquidation-scanner.service`
- `deploy/systemd/exchange-tp-sl-scanner.service`

### 9.2 启动脚本

发现脚本：

- `backend/scripts/start_rq_worker.py`
- `backend/scripts/start_collection_auto_scheduler.py`
- `backend/scripts/start_withdraw_fee_scheduler.py`
- `backend/scripts/start_dealer_loop.py`
- `backend/scripts/start_liquidation_scanner.py`
- `backend/scripts/start_tp_sl_scanner.py`
- `backend/scripts/start_contract_accounting_reconciliation_scheduler.py`

### 9.3 API 内嵌 loop 默认值

静态证据：

- `backend/app/main.py:322` `_embed_background_loops_in_api()` 读取 `EMBED_BACKGROUND_LOOPS_IN_API`。
- `backend/app/main.py:323` 默认值为 `False`。
- `backend/app/main.py:439-445` 默认不在 API startup 中嵌入 dealer loop、TP/SL job、liquidation scanner。
- `backend/scripts/start_dealer_loop.py`、`backend/scripts/start_liquidation_scanner.py`、`backend/scripts/start_tp_sl_scanner.py` 均使用 `start_heartbeat_thread`。
- `backend/app/services/service_heartbeat.py` 提供 heartbeat 写入、读取、存活判断。

审计判断：

- API、RQ worker、scheduler、dealer loop、liquidation scanner、TP/SL scanner 有独立职责入口。
- 默认配置避免 API 重复启动后台 loop。
- 新增 `contract_accounting_reconciliation_scheduler` 有启动脚本，但未在 systemd 模板列表中看到对应 service，需要补齐部署模板或明确暂不上线。

## 十、资金安全保护静态检查

### 10.1 Withdraw

静态证据：

- `backend/app/services/withdraw_sender.py:539-547` 检查已有 `tx_hash`，防止重复提交。
- `backend/app/services/withdraw_sender.py:560-567` 限制可发送状态。
- `backend/app/services/withdraw_sender.py:592-595` 使用状态条件更新为 `SENDING`。
- `backend/app/services/withdraw_sender.py:725-726` 真实发送后写入 tx_hash 并标记 `SENT`。
- `backend/app/routers/asset_withdraw.py:1504-1519` 创建提现时检查 review threshold 和 daily count。
- `backend/app/routers/asset_withdraw.py:1800-1807` confirm 时状态从 `VERIFYING` 到 `FROZEN` 有状态条件。
- `backend/app/routers/admin_pages.py:7500`、`backend/app/routers/admin_pages.py:7535` 提现审核 approve/reject POST 使用 `withdraw_reviews.manage`。

审计判断：

- 提现发送路径存在状态保护、tx_hash 防重复、审核权限保护。
- 本轮未执行真实提现发送。

### 10.2 Collection / Gas

静态证据：

- `backend/app/services/collection_send_helper.py` 引入 `validate_collection_send_allowed`。
- `backend/app/tasks/collection_tasks.py` 对 collection/gas 任务状态做发送前校验。
- `backend/app/services/admin_queries.py:22077-22079` 查询成功态时排除 `DRYRUN_` / `DRYGAS_`。
- `backend/app/services/admin_queries.py:22142-22149` collection/gas 成功计数要求真实 `0x` tx_hash 且排除 dry-run 前缀。
- `backend/app/services/admin_queries.py:22174-22178` 统计 dry-run、真实 gas sent/confirmed。
- `backend/app/routers/admin_pages.py:7168` collection real-send POST 使用 `collection_tasks.manage`。
- `backend/app/routers/admin_pages.py:7374` gas real-send POST 使用 `gas_tasks.manage`。

审计判断：

- 归集/补 Gas 路径存在权限保护、状态保护、dry-run 与真实 tx_hash 区分。
- 本轮未执行真实归集或补 Gas。

### 10.3 Platform Adjust

静态证据：

- `backend/app/routers/admin_pages.py:11028` `/platform/adjust` POST。
- 该 POST 使用 `platform_adjust.manage`。
- 模板 `backend/templates/admin/platform_adjust.html` 包含 `CONFIRM` 确认文本输入。

审计判断：

- 平台调账存在权限与确认文本保护。
- 本轮未执行调账。

### 10.4 Dividend / BD / Invite payout

静态证据：

- 分红相关 POST 使用 `dividends.distribute`。
- BD 佣金相关 POST 使用 `bd_commissions.manage`。
- 邀请佣金相关 POST 使用 `invite_commissions.manage`。
- `backend/app/tasks/user_invite_commission_tasks.py` 对 `PAID`、非 `PENDING` 状态做跳过处理。
- `backend/app/tasks/bd_commission_tasks.py`、`backend/app/tasks/dividend_tasks.py` 存在 RQ payout 任务路径。

审计判断：

- 分红、BD、邀请佣金路径存在权限与状态保护。
- 本轮未执行真实发放。

### 10.5 Stock lock release

静态证据：

- `backend/app/routers/admin_pages.py:10764` `/stock-token-locks/release`
- `backend/app/routers/admin_pages.py:10855` `/stock-token-locks/{lock_item_id}/force-release`
- 相关 POST 使用 `stock_locks.manage`。
- `backend/app/tasks/stock_token_release_tasks.py` 存在 RQ release 任务。

审计判断：

- 股票锁仓释放路径存在权限保护与任务路径。
- 本轮未执行释放。

## 十一、风险分级清单

### P0：阻塞上线，必须修复

#### R-001

- 等级：P0
- 模块：Dealer 风控 / VIP 费率管理
- 文件路径：`backend/app/services/admin_queries.py:22654-22658`，`backend/app/routers/admin_pages.py:12731-12817`
- 问题描述：`admin_toggle_vip_fee_level_enabled`、`admin_update_vip_fee_level_rule`、`admin_save_dealer_risk_limit`、`admin_toggle_dealer_risk_enabled`、`admin_toggle_dealer_risk_status` 仍绑定 `_ok_stub`。后台 Dealer 风控 POST 会返回成功提示，但写操作可能不落库。
- 影响：上线后风控配置可能无法生效，管理员误以为已配置风控；VIP 费率规则也可能出现保存成功但实际无效。
- 建议处理方式：实现真实 service/query 写入逻辑，补齐成功/失败分支和审计日志；上线前用只读或测试库验证保存后可查询。
- 是否建议立即修复：是。

#### R-002

- 等级：P0
- 模块：CMS / Activity / Banner RBAC
- 文件路径：`backend/app/admin/activity_admin.py:199`、`:340`、`:460`、`:482`、`:557`、`:649`、`:721`、`:743`
- 问题描述：活动和活动 Banner 的 8 个 POST 仅做 `require_admin(request)` 登录态校验，未接 `require_admin_post_permission` 或等价 RBAC 权限点。
- 影响：任意已登录后台管理员可能创建、修改、启停或删除活动/Banner，绕过角色权限边界。
- 建议处理方式：接入 `site_content.manage` 或新增 `activities.manage` 权限；同步 seed RBAC 权限并更新侧边栏/页面显示条件。
- 是否建议立即修复：是。

### P1：上线前建议修，不阻塞核心链路

#### R-003

- 等级：P1
- 模块：前端 lint / 质量门禁
- 文件路径：`web/app/committee/page.tsx`、`web/app/lending/page.tsx`、`web/components/trading/Chart.tsx`、`web/components/trading/TradingForm.tsx`、`web/components/ui/UnderDevelopment.tsx`、`web/lib/api/core/http.ts` 等
- 问题描述：定向源码 lint 失败，结果为 `76 problems (43 errors, 33 warnings)`。
- 影响：如果 CI/CD 将 lint 作为上线门禁，则无法通过；即使构建通过，也存在类型松散、React effect 写法和 Next 规则问题。
- 建议处理方式：清理源码 lint error；同时将 `.next.codex-backup-*` 从 lint 范围排除，避免生成产物污染。
- 是否建议立即修复：是。

#### R-004

- 等级：P1
- 模块：多语言文案
- 文件路径：`web/config/locales/zh.json`、`web/config/locales/zh-TW.json`、`web/config/locales/ja.json`
- 问题描述：locale JSON 语法通过，但存在真实 `????` 文案。统计：`zh.json` 20 行，`zh-TW.json` 20 行，`ja.json` 25 行。
- 影响：上线后中文、繁中、日文界面会出现问号占位，影响正式交付观感和用户理解。
- 建议处理方式：恢复/重填对应 key 的正式文案，并增加文案异常扫描。
- 是否建议立即修复：是。

#### R-005

- 等级：P1
- 模块：交易页面前端数据
- 文件路径：`web/components/trading/TradingPage.tsx:89`、`web/components/trading/TradingPage.tsx:135`
- 问题描述：页面仍定义并使用 `mockAssetData`。
- 影响：若该页面仍可访问，可能展示模拟资产数据，影响用户对资产/交易页面的可信度。
- 建议处理方式：确认该页面是否仍在线上路由中；若保留，改为真实 API 数据、登录态兜底或明确隐藏。
- 是否建议立即修复：是。

#### R-006

- 等级：P1
- 模块：KYC 后台审核归因
- 文件路径：`backend/app/routers/kyc.py:449`、`backend/app/routers/kyc.py:483`
- 问题描述：KYC approve/reject 仍有 TODO：后续接入真实管理员 ID。
- 影响：审核操作可能缺少真实管理员归因，影响审计追踪。
- 建议处理方式：接入后台管理员身份，写入审核人 ID、IP、request_id 等审计字段。
- 是否建议立即修复：是。

### P2：上线后优化

#### R-007

- 等级：P2
- 模块：前端构建卫生
- 文件路径：`web/package-lock.json`、根目录 `package-lock.json`、Next config
- 问题描述：Next build 检测到多个 lockfile，并推断 workspace root 为 `D:\exchange-web\package-lock.json`；同时 baseline-browser-mapping 与 browserslist 数据过期。
- 影响：当前不阻塞 build，但可能导致依赖解析根目录不稳定、浏览器兼容数据陈旧。
- 建议处理方式：确认 monorepo/root lockfile 策略；设置 `turbopack.root` 或清理多余 lockfile；更新 browserslist 数据。
- 是否建议立即修复：否。

#### R-008

- 等级：P2
- 模块：后台查询策略
- 文件路径：`backend/app/routers/admin_pages.py:3506-3524`
- 问题描述：`withdraw_records_page` 对 `status=FAILED_GROUP` 且无显式日期时存在跳过默认日期过滤的分支。
- 影响：在失败分组较大时可能形成大表查询压力。
- 建议处理方式：确认该分支的业务必要性；如需保留，应增加 limit、索引、后台异步导出或精准条件要求。
- 是否建议立即修复：否。

#### R-009

- 等级：P2
- 模块：部署模板
- 文件路径：`backend/scripts/start_contract_accounting_reconciliation_scheduler.py`
- 问题描述：存在合约对账 scheduler 启动脚本，但 systemd 模板列表中未见对应 service。
- 影响：如果该 scheduler 属于上线职责，部署时可能遗漏；如果暂不上线，应在部署清单明确排除。
- 建议处理方式：补齐 systemd 模板或在上线 checklist 中标记暂不启用。
- 是否建议立即修复：否。

#### R-010

- 等级：P2
- 模块：发布流程
- 文件路径：工作区整体
- 问题描述：当前工作区有大量未提交修改和新增文件。
- 影响：不利于最终发布审计、回滚和版本定位。
- 建议处理方式：完成修复后进行代码审阅、测试、commit、tag，并生成正式发布变更清单。
- 是否建议立即修复：否。

## 十二、总体结论

总体结论：暂不建议上线。

原因：

- 存在 P0：Dealer 风控 / VIP 写操作仍绑定 stub，且活动/Banner POST 缺少 RBAC 权限点。
- 前端源码 lint 未通过。
- 多语言文案存在 `????`，正式交付观感风险明确。

## 十三、风险数量

- P0 数量：2
- P1 数量：4
- P2 数量：4

## 十四、未执行检查项及原因

- 未启动浏览器：用户要求不启动浏览器。
- 未启动本地 uvicorn / dev server：用户要求不启动服务。
- 未执行 TestClient / httpx 冒烟：用户要求不做。
- 未连接外部生产服务：用户要求不连接。
- 未执行真实链上发送、提现、归集、补 Gas、分红发放、BD/邀请发放：资金安全边界要求。
- 未改数据库数据、未跑生产 seed：用户要求不改数据库数据。
- 未提交 git commit：用户要求不提交。

## 十五、后续建议

1. 优先清理 P0：实现 Dealer/VIP 真实写入逻辑；为 Activity/Banner POST 接入 RBAC。
2. 清理 P1：修复 lint error、locale `????` 文案、`mockAssetData`、KYC 审核人归因。
3. P0 清零后，再执行一次同范围只读审计，确认 P0=0。
4. 使用测试库或 staging 环境补做数据库迁移、seed、后台页面权限、资金动作 dry-run 验证。
5. 最终确认后，再生成给甲方的正式报告。
