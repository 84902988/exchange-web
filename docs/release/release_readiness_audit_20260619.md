# Release Readiness Audit V1 - 2026-06-19

本报告为上线前只读审计结果。审计过程中未执行真实 `DELETE` / `TRUNCATE` / `UPDATE`，未执行 DB Lifecycle cleanup 真实删除，未重启后端，未关闭 PyCharm，未 kill `python.exe`，未启动浏览器做人工 UI 验证。

## 1. 总结结论

结论：**BLOCKER**

阻断原因是发布卫生与运营配置层面的上线阻断，不是交易、资金、订单、提现、归集、合约、分红、BD、邀请核心逻辑阻断：

- 当前工作区存在大量未提交修改和未跟踪文件，尚不能直接打上线包。
- `data/geoip/GeoIP.conf` 与 `data/geoip/GeoLite2-Country.mmdb` 当前是未跟踪且未被 `.gitignore` 覆盖的文件，存在误入库风险。
- 审计时本地 DB 中 Geo Access 曾处于 `enabled=true`、`monitor_mode=false`、`restricted_countries=["CN","US"]`，这是测试/诊断配置；后续运营确认生产名单为 `["CN"]`，`US` 不进入生产限制名单。

需要运营确认项：

- 生产 `.env` 中数据库、Redis、JWT、Cookie、CORS、Cloudflare、GeoIP、Moralis、RPC、热钱包、SMTP / DirectMail、ITICK、RQ / maintenance 配置。
- Geo Access 限制国家/地区名单、是否正式拦截、后台豁免策略。
- DB Lifecycle cleanup 是否仅 dry-run；真实删除开关上线前应保持关闭。
- systemd 中 API、RQ、scheduler、scanner、loop 的归属，避免 FastAPI startup 与独立 service 双启动。

## 2. Git 状态

- 当前分支：`main`
- 当前 commit：`8b299a87a83eeaaa042009f440c395bf42ce6413`
- 当前工作区：有未提交文件。
- 基线：存在 `exchange-baseline-202606`。
- 相对 `exchange-baseline-202606` 的改动范围：后端迁移、Geo Access、DB Lifecycle、后台页面、systemd 服务、前端 `/restricted` 与 proxy/middleware、移动端、合约与采集相关模块均有改动。

不应入库文件风险：

- `data/geoip/GeoIP.conf`
- `data/geoip/GeoLite2-Country.mmdb`

上述文件当前未被 Git 跟踪，但也未被 `.gitignore` 命中。上线前应明确从工作区移出或加入忽略规则，避免 GeoIP 配置、商业/授权数据库误入库。

## 3. 敏感信息扫描

已检查路径类别：

- `.env`
- `backend/.env`
- `web/.env.local`
- `.env.example`
- `backend/.env.example`
- `web/.env.example`
- keystore / private key / JWT / hot wallet / Moralis / SMTP / DirectMail / ITICK 字段名

结论：

- 实际 `.env` 类文件未发现被 Git 跟踪；`backend/.env`、`web/.env.local` 为 ignored。
- Git 跟踪的主要为模板文件：`.env.example`、`backend/.env.example`、`web/.env.example`。
- 代码与模板中存在 `JWT_SECRET`、`HOT_WALLET_PRIVATE_KEY`、`MORALIS_API_KEY`、`MORALIS_WEBHOOK_SECRET`、`ITICK_API_TOKEN`、SMTP / DirectMail 等字段名引用；本次审计未在报告中输出任何密钥值。
- `mobile/android/app/debug.keystore` 为 ignored；未发现移动端构建产物误提交。

上线前建议：

- 生产环境所有密钥必须由运营重新确认并妥善注入。
- 若历史环境中曾共享过真实密钥，建议上线前轮换 JWT、Moralis、热钱包、SMTP / DirectMail、ITICK 相关凭据。

## 4. 环境变量模板审计

已对比：

- `backend/app/core/config.py`
- `.env.example`
- `backend/.env.example`
- `web/.env.example`
- `deploy/systemd/*.service`

已覆盖的关键配置：

- 数据库：`DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`
- Redis：模板中有 `REDIS_URL` 注释示例，实际配置需上线确认
- JWT / Cookie / CORS：`JWT_SECRET`、Cookie 安全配置、CORS origins
- Geo Access：`GEO_ACCESS_ENABLED`、`GEO_ACCESS_MONITOR_MODE`、`GEOIP_DB_PATH`、`GEO_ACCESS_TRUST_CF_HEADER`
- DB Lifecycle：`DB_LIFECYCLE_CLEANUP_ENABLED`、`DB_LIFECYCLE_CLEANUP_DRY_RUN`、`DB_LIFECYCLE_CLEANUP_ALLOW_EXECUTE`、`DB_LIFECYCLE_CLEANUP_EXECUTE_CONFIRM`
- Moralis / RPC / Hot Wallet / SMTP / DirectMail / ITICK：后端模板中存在对应字段

模板缺口或需确认项：

- `DATABASE_URL` 未作为模板字段直接出现，当前更偏向由 DB 分项配置生成。
- `GEO_ACCESS_BLOCK_UNKNOWN`、`GEO_ACCESS_ADMIN_EXEMPT`、`GEO_ACCESS_RESTRICTED_COUNTRIES` 未完整出现在后端模板中。
- 旧字段 `GEO_RESTRICTION_ENABLED`、`GEO_RESTRICTED_COUNTRIES`、`GEO_RESTRICTION_HEADER` 仍在配置类中，需要确认是否保留兼容或后续清理。
- `JWT_SESSION_REFRESH_TOKEN_EXPIRE_SECONDS`、登录锁定/验证码参数、部分 contract fee、ITICK 细项、商品/RWA 手动价格配置未全部体现在模板中。

生产危险默认值：

- DB Lifecycle 真实删除默认未开启，这是安全默认。
- Geo Access 模板默认不强拦截、monitor mode 默认开启，是安全默认。
- 当前本地 DB 配置不是安全默认，已进入正式拦截：需运营确认。

## 5. Alembic / 数据库迁移审计

只读检查结果：

- `alembic current`：`20260619_000108 (head)`
- `alembic heads`：`20260619_000108 (head)`
- 当前 DB 是否在 head：是
- 是否存在多 head：否
- 迁移文件数量：107
- duplicate revision：未发现
- migration import errors：未发现

最近迁移包含：

- `20260618_000103_add_geo_access_control.py`
- `20260618_000104_extend_geo_access_log_rollups.py`
- `20260618_000105_add_geo_access_log_bucket_index.py`
- `20260619_000106_add_db_lifecycle_cleanup_logs.py`
- `20260619_000107_add_db_lifecycle_skip_fields.py`
- `20260619_000108_add_db_lifecycle_operation_mode.py`

结论：迁移链路当前无阻断。

## 6. 后端静态检查

执行结果：

- Python AST / compile 检查：通过，检查 434 个 Python 文件。
- 关键模块 import 检查：通过。
- Jinja 模板解析：通过，检查 103 个模板。

关键 import 覆盖：

- `app.main`
- `app.routers.admin_pages`
- `app.routers.geo_access`
- `app.services.geo_access_service`
- `app.jobs.db_lifecycle_cleanup_job`
- `app.services.admin_queries`
- `app.core.rq`
- `app.core.config`

备注：首次使用普通 `utf-8` 解析时遇到 BOM 类误报，已使用 `utf-8-sig` 重新解析确认通过。

## 7. 前端检查

执行结果：

- `npm.cmd run build`：通过。
- targeted lint：`proxy.ts`、`app/restricted/page.tsx`、`components/layout/AppChrome.tsx` 通过。
- locale JSON parse：通过。
- 多语言缺 key 检查：`en.json`、`ja.json`、`zh-TW.json`、`zh.json` 均为 2453 个 key，缺失数为 0。

`/restricted` 检查：

- `/restricted` 页面存在，标题为英文单语 `Service unavailable in your region`。
- 未发现中文文案。
- `AppChrome` 存在 `pathname === "/restricted"` 旁路逻辑，restricted 页面不包普通前台 Header/Footer。
- `web/proxy.ts` matcher 排除了 `restricted` / `region-restricted`，避免死循环。
- Next build 输出中 Proxy / Middleware 已注册。

前端非阻断告警：

- `baseline-browser-mapping` 数据过旧。
- browserslist / caniuse-lite 数据过旧。
- Next 检测到多个 lockfile，并推断 workspace root 为 `D:\exchange-web\package-lock.json`，同时发现 `web\package-lock.json`。建议上线前确认根目录 lockfile 是否必要。

## 8. 移动端检查

轻量检查结果：

- `mobile/package-lock.json` 存在。
- `mobile` 下 `npm.cmd run lint`：通过。
- 未发现 `mobile` 下 `.apk`、`.aab`、`node_modules`、`Pods`、`DerivedData`、构建输出目录被 Git 跟踪。
- 未运行模拟器，未执行 Android Studio / emulator 操作。

结论：移动端轻量状态无阻断。

## 9. RQ / 常驻服务审计

systemd service 模板覆盖：

- API：`exchange-api.service`
- RQ：collection、email、gas、maintenance、payout、release、tx_confirm、withdraw
- Scheduler / Loop / Scanner：collection auto scheduler、contract reconciliation scheduler、contract limit order scanner、dealer loop、liquidation scanner、tp-sl scanner、withdraw fee scheduler

RQ 队列一致性：

- `backend/app/core/rq.py` 中存在 `maintenance` 队列。
- systemd 中存在 `exchange-rq-maintenance.service`。

DB Lifecycle cleanup：

- 默认 `DB_LIFECYCLE_CLEANUP_ENABLED=false`。
- 默认 `DB_LIFECYCLE_CLEANUP_DRY_RUN=true`。
- 默认 `DB_LIFECYCLE_CLEANUP_ALLOW_EXECUTE=false`。
- 当前未发现 systemd 中直接启用 DB Lifecycle cleanup scheduler 的服务模板。若生产需要定时 dry-run 观测，应补充明确的 scheduler 归属；若不需要自动投递，则保持手动入口即可。

双启动风险：

- 项目同时存在 FastAPI startup 控制与独立 service 控制的后台任务能力。上线前必须通过 env 明确生产 owner，避免 API 进程和 systemd 独立 service 同时启动同一 scanner / scheduler / loop。

## 10. DB Lifecycle 安全审计

核心保护表：

- `balance_logs`
- `orders`
- `trades`
- `contract_orders`
- `contract_trades`
- `contract_margin_logs`
- `deposits`
- `withdraw_logs`
- `user_balances`
- `platform_adjust_logs`
- `bd_commission_records`
- `user_invite_commission_records`
- `user_dividend_records`
- `dividend_pools`
- `dividend_pool_items`
- 以及相关核心保护扩展表

审计结果：

- protected core table 数量：18。
- cleanup allowlist 不包含核心保护表。
- `--execute` 必须提供确认文本。
- `allow_execute` 默认 false。
- `can_execute_now` 默认 false。
- 最近 `db_lifecycle_cleanup_logs` 中 `REAL_DELETE` 记录数：0。
- 文档已记录偏差：`user_otps` 22、`user_sessions` 555、核心表无变化、已补 allow_execute 护栏。

结论：DB Lifecycle 当前安全护栏有效。上线前应继续保持真实删除关闭。

## 11. Geo Access 审计

代码与默认配置：

- 默认不强拦截。
- 默认 monitor mode 为安全默认。
- GeoIP DB 文件不应入库。
- `/restricted` 已为英文单语。
- `/admin/geo-access` 当前代码路径已排除访问日志写入。
- `geo_access_logs` 已支持 5 分钟 bucket 聚合、`hit_count`、`first_seen_at`、`last_seen_at`、`last_path` 与 90 天保留策略。

当前 DB 运行配置：

- `enabled=true`
- `monitor_mode=false`
- `block_unknown=false`
- `admin_exempt=true`
- `restricted_countries=["CN","US"]`

风险：

- 审计时本地运行配置曾用于正式拦截 CN / US 测试；后续运营确认生产名单为 CN only，US 不作为生产限制国家。是否正式拦截仍由 `enabled` / `monitor_mode` 控制。
- `geo_access_logs` 当前总量约 511。
- 历史上存在 `/admin/geo-access` 自身访问日志约 58 条。当前代码已排除，历史污染可通过保留策略自然过期，或后续在明确授权下用 dry-run 审核后清理。
- `.mmdb` / `GeoIP.conf` 当前未被 `.gitignore` 命中，是发布卫生 P0。

## 12. 后台大表查询策略

已观察到默认时间范围/收敛策略的页面：

- 资金流水 `balance_logs`
- 现货订单 `orders`
- 现货成交 `trades`
- 合约订单 `contract_orders`
- 合约成交 `contract_trades`
- 充值记录 `deposits`
- 提现记录 `withdraw_logs`
- audit logs
- dividend job logs
- bd commission job logs
- stock token release logs
- geo access logs

策略现状：

- 大表页面已有最近 7 天默认范围、快捷范围、超过 30 天需要精准条件或自动收窄的逻辑。
- Geo Access logs 默认最近 24 小时，limit 控制在 100/200 范围内。
- 暂未做 keyset pagination，仍存在 offset 分页的 V2 优化空间。

仍有风险：

- 若未来新增后台大表页面，应强制复用同一套默认时间范围与精确条件策略。
- 大表索引建议仍应按审计文档分批评估，不建议在上线窗口临时加索引。

## 13. 上线阻断项清单

BLOCKER：

- 当前工作区未提交修改较多，不能直接打上线包。
- `data/geoip/GeoIP.conf`、`data/geoip/GeoLite2-Country.mmdb` 未跟踪但未忽略，必须处理误入库风险。
- 审计时 DB Geo Access 曾包含 CN / US 测试配置；后续运营确认生产限制名单为 CN only，US 不作为生产限制国家。

P0：

- 确认生产 `.env` 全量配置与密钥轮换策略。
- 确认 systemd 后台任务唯一 owner，避免 FastAPI startup 与独立 service 双启动。
- 确认 DB Lifecycle 生产保持 `enabled=false` 或 dry-run，`allow_execute=false`。
- 确认 GeoIP DB 文件来源、授权、部署路径与 Cloudflare Header 信任边界。

P1：

- 补齐后端 `.env.example` 中 Geo Access 细项、ITICK 细项、登录安全参数等模板字段。
- 明确 DB Lifecycle cleanup scheduler 是否需要 systemd 服务或仅保留手动入口。
- 清理或解释根目录与 web 目录多 lockfile 导致的 Next workspace root 告警。
- 更新 browserslist / caniuse-lite 数据。

P2：

- 大表后台查询改造 keyset pagination。
- 核心账务表归档 V2：月度 archive 表、manifest、count/checksum/sum 校验。
- Geo Access 历史调试日志按授权策略清理。
- Worker dashboard 与 maintenance 任务可视化增强。

## 14. 最终建议

建议执行顺序：

1. 先处理 BLOCKER：工作区发布卫生、GeoIP 文件忽略/移出、Geo Access 生产配置确认。
2. 再处理 P0：生产密钥与 env、systemd 任务归属、DB Lifecycle 安全开关、GeoIP/Cloudflare 信任边界。
3. 然后处理 P1：模板字段补齐、scheduler 归属、Next lockfile 告警、前端浏览器数据更新。
4. 最后安排 P2：keyset pagination、核心账务归档 V2、长期运维面板。

本轮验证中未发现 Alembic、Python compile、关键 import、Jinja parse、Web build、targeted lint、移动端 lint 的阻断失败。
