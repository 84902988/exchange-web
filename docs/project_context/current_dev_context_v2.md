# Current Development Context V2

更新时间：2026-06-24
用途：给后续 ChatGPT / Codex 开发续上下文使用。本文只记录当前真实状态、关键决策、开发边界和下一步入口，不作为运营交付报告。

## 一、项目当前总阶段

项目是一个交易所系统，当前已完成 Web 前台、FastAPI 后端、后台 Admin、资金/交易/合约/链上任务/RQ/systemd 运行边界，以及 React Native 移动端 V1 壳层和登录态接入。最近主线提交已经把 release hygiene、Geo Access、DB Lifecycle、核心账务归档基础设施、移动端工程纳入 `main`。

当前阶段应定义为：上线前收口 + 交付前稳定 + 后续开发准备。代码层最近复检没有新的技术 BLOCKER，但仍有部署侧和人工验证侧 WARN：生产环境变量/密钥、Cloudflare 与 GeoIP 部署、systemd 唯一 owner、真实 Redis/staging 行为、合约行情视觉、VIP/Dealer 保存回显、移动端 deferred stash 等。

当前 Git 状态（本次整理时）：

- 分支：`main...origin/main`，未显示 ahead/behind。
- 最近提交：`1e70432 chore: tighten public release ignore rules`、`1ad229b docs: add final pre-push verification`、`06617a7 docs: add core archive post-commit verification`、`2b7ea38 feat: add core ledger archive infrastructure`。
- 未跟踪：`docs/ops/admin_configuration_guide_ops_v1.md`。
- Stash：`stash@{0}: On main: wip: mobile home experience deferred`。

## 二、技术架构与运行环境

后端：

- FastAPI + SQLAlchemy + Alembic + Jinja Admin，入口为 `backend/app/main.py`。
- 配置入口为 `backend/app/core/config.py`，从 `backend/.env` 读取数据库、Redis、JWT、Cookie、Geo Access、DB Lifecycle、iTick、Binance、DirectMail、链上等配置。
- 数据库连接由 DB 分项配置生成 MySQL `mysql+pymysql` URL，迁移由 Alembic 管理。
- Redis 用于 RQ、缓存、验证码/登录安全等，`settings.redis_url` 和 `REDIS_URL` 均可作为入口。
- 全局响应有 trace id 和统一错误 payload；Geo Access middleware 运行在业务路由之前。

Web：

- Next.js 16 + React 19 + TypeScript，目录为 `web/`。
- API client 在 `web/lib/api`，页面在 `web/app`，交易组件在 `web/components/spot`、`web/components/contract`。
- `web/proxy.ts` 和 `/restricted` 承担 Geo Access 前端页层限制。
- 已知非阻塞卫生项：根目录和 `web` 均有 lockfile，Next 会提示 workspace root 推断；Browserslist / caniuse-lite 数据过旧。

Mobile：

- React Native 0.86 + React 19，目录为 `mobile/`。
- 使用 React Navigation，固定 5 个主 Tab：`Home / Markets / Trade / Contract / Assets`，UI 文案为中文：`首页 / 行情 / 交易 / 合约 / 资产`。
- 登录态复用现有后端 API，`mobile/src/store/authStore.tsx` 使用 AsyncStorage 持久化 `access_token`、`refresh_token`、`userInfo`。
- 目前移动端当前工作树没有 tracked 改动，但存在一个未恢复的 mobile home stash。

RQ / 常驻服务：

- 当前 RQ 队列：`collection`、`gas`、`tx_confirm`、`withdraw`、`email`、`release`、`payout`、`maintenance`。
- 高频交易/风控 loop 不迁入当前 RQ：现货内盘撮合、Dealer loop、强平、TP/SL、合约限价扫描、withdraw watcher 保留既有路径。
- 现货内盘撮合已从 API startup 拆为独立 worker：`backend/scripts/start_spot_match_worker.py`，生产建议由 `exchange-spot-match-worker.service` 作为唯一 owner。
- API 默认不再内嵌启动现货撮合；兼容旧模式可设置 `ENABLE_SPOT_AUTO_MATCH_IN_API=1`，但不能与独立 `exchange-spot-match-worker.service` 同时启用。
- `deploy/systemd/` 已有 API、各 RQ worker、collection scheduler、spot match worker、contract accounting reconciliation scheduler、contract limit order scanner、dealer loop、liquidation scanner、TP/SL scanner、withdraw fee scheduler 等 service 模板。
- 上线必须避免 FastAPI startup 和独立 systemd service 双启动同一 loop/scanner。

行情源 / WebSocket：

- 后端包含 `market.py`、`itick_market.py`、`contract_market.py`、`market_external.py`、`market_rwa.py` 等路由。
- iTick 用于股票/黄金等外部行情，Binance USDM 默认生产 URL 为 `https://fapi.binance.com`，fallback 默认空。
- Redis 公共行情缓存已接入核心 ticker/contract ticker 路径，但真实 Redis 并发 lock、provider_version 隔离仍应在 staging 验证。
- WebSocket 私有通道存在 `spot_ws_private.py`、`contract_ws_private.py` 及对应 service。

链上服务：

- 链能力由 `backend/app/core/chain_capabilities.py` 控制，充值/提现 options 不只看 DB 开关，还看代码能力白名单。
- 当前代码白名单中 `bsc`、`polygon`、`avaxc`、`ethereum`、`optimism` 使用 READY EVM capability。注意：`docs/chain_capabilities_v1.md` 仍写 `avaxc/ethereum/optimism` 为 CONFIG_ONLY，已与当前代码不一致，后续必须复核并更新文档或确认代码是否应回退。
- 归集、补 Gas、tx_confirm、热钱包监控、提现发送均有独立 service/guard。

## 三、核心模块当前状态

### 用户 / 登录 / KYC

- 用户登录由 JWT 路由和 `/me` 路由承载，Web 与 Mobile 均复用同一 token-first contract。
- Cookie/JWT 配置已集中在 `config.py`，线上 `COOKIE_SECURE`、`COOKIE_SAMESITE`、CORS、JWT 密钥必须由生产 env 确认。
- KYC 路由与后台页面已纳入 Admin 恢复和 release 复检；旧的 KYC 审核人归因 P1 已在后续复检中标为已修复。

### 资产 / 充值 / 提现 / 划转

- 资产、充值、提现、站内划转页面和接口已存在：`asset.py`、`asset_withdraw.py`、`withdraw_send.py`、`account_transfer.py`、`user_transfer.py`。
- 用户端充值/提现 options 受 asset、chain、asset_chain、deposit/withdraw 开关和 chain capability 共同限制。
- 提现真实链上发送由 worker、watcher、guard、风险与手续费 service 共同控制；不要绕过 guard 或直接改数据库状态。
- 核心资金表受 DB Lifecycle 保护，禁止清理，只允许后续按归档设计处理。

### 现货交易

- 现货订单、成交、撮合、盘口和交易页已完成基础闭环，核心入口包括 `order.py`、`match.py`、`spot.py`、`matching.py`、`order_service.py`。
- Web 现货组件在 `web/components/spot`，包括 `SpotPage`、`SpotChart`、`SpotOrderBook`、`SpotTradingForm` 等。
- 现货内盘撮合运行边界已独立化：生产默认由 `exchange-spot-match-worker.service` 持续扫描并撮合 `MATCHING` 限价单；API 默认不再内嵌启动撮合线程。
- 如需回退旧模式，可设置 `ENABLE_SPOT_AUTO_MATCH_IN_API=1`，但必须关闭独立现货撮合 worker，确保 API 和独立 worker 不重复 owner。
- Reference Overlay V1 已收口：IRON/GOLD 自动同步，Stock 类 overlay 仍为手动。

### 合约交易

- 合约账户、订单、持仓、成交、强平、TP/SL、限价扫描、资金流水与 reconciliation 已有服务和 systemd 模板。
- Web 合约页入口为 `web/app/contract/page.tsx` 和 `web/components/contract/*`。
- 合约行情展示、股票/CFD 报价与 K 线口径已代码层收口；视觉表现仍需用户在 staging/页面手工确认。
- 合约核心撮合、强平、结算、保证金流水、Dealer 相关逻辑属于收口区，不建议大改。

### 行情系统 / Markets / 股票详情 / iTick / Binance

- Markets 和股票详情页存在：`web/app/markets/page.tsx`、`web/app/markets/stocks/[symbol]/page.tsx`。
- 外部行情服务包括 iTick、Binance、RWA reference、market cache、market kline cache。
- Binance USDM 生产默认已改为 `fapi.binance.com`，testnet 只应作为显式 dev/fallback，不应成为生产默认。
- 真实 Binance 在当前地区可能返回 451，验证时应更多依赖配置、mock fallback、staging 真实环境。

### VIP / 手续费 / RCB 抵扣

- VIP 等级、用户 VIP、费率偏好、手续费 service 与后台页面已恢复真实查询。
- VIP/Dealer 写入逻辑的旧 `_ok_stub` P0 已代码层修复；真实保存回显仍建议在测试库或 staging 做人工操作验证。
- RCB lock/抵扣相关页面与记录存在于 Web 资产和用户中心。

### 分红系统

- 分红配置、分红池、分红统计、分红 job logs 已在后台恢复。
- RQ 中存在 dividend single-record wrapper placeholder，但当前真实分红池分发路径保持原有语义，不在当前 RQ 里重写余额变化。
- 分红记录、池、明细属于核心保护表，不参与 DB Lifecycle 清理。

### BD / 邀请系统

- BD 申请、账户、团队、佣金、job logs、普通邀请关系、邀请佣金均有 service、task 和后台页面。
- RQ `payout` 队列覆盖离散单条 BD/邀请佣金 payout job；初期 payout worker 并发应保守。
- BD/邀请发放记录属于核心保护表，不能纳入清理 allowlist。

### 股票锁仓

- 股票锁仓配置、用户锁仓、释放日志、释放任务已存在。
- `release` RQ 队列处理股票锁仓释放任务。
- `stock_token_release_logs` 已有 no-op 写放大治理方向：保留真实释放/失败记录，纯 no-op 用 debug 或后续聚合摘要。

### 后台 Admin / RBAC / 审计 / UX

- Admin V1 恢复完成：82 个后台 GET 页面通过，无 INTERNAL_ERROR、traceback、明显乱码、旧占位页。
- Admin 已恢复用户/资产/现货/合约/资金/VIP/分红/BD/邀请/配置/平台/Dealer/White-Label/股票锁仓/归集/Gas 等真实查询。
- RBAC P0 高风险 POST 权限审计已形成文档；后续增加后台写操作必须复用权限点、二次确认和审计边界。
- 后台仍不是完整实时监控系统，Worker dashboard、WebSocket 运维监控、更细粒度风控看板属于后续 V2。

### White-Label / Banner / 公告

- White-Label Home V1 已完成：站点配置、首页 Banner、公告、图片上传、Header/Footer 动态化、Admin IA V1。
- 前台消费 `/site/config`、`/home/banners`、`/announcements/latest`。
- 当前不做多租户隔离、媒体库、图片删除/CDN/裁剪、主题配置、法律条款正文 CMS、前台导航菜单配置。

### Geo Access Control

- Geo Access V1 已接入：Cloudflare `CF-IPCountry` 优先、本地 `.mmdb` fallback、UNKNOWN fallback、后台配置、日志、前端 restricted 页面。
- 生产决策文档确认：`enabled=true`、`monitor_mode=false`、`restricted_countries=["CN"]`、`block_unknown=false`、`admin_exempt=true`、trust `CF-IPCountry=true`。
- `US` 仅为测试项，不进入生产限制名单。
- 生产部署仍需确认 Cloudflare header 转发、GeoIP DB 文件路径、授权和更新责任。

### 资金归集 / Gas / tx_confirm

- 资金归集 + 补 Gas V1 代码闭环已完成：候选扫描、批次/任务表、dry-run、单条真实发送入口、tx confirm watcher、guard、限额、白名单。
- 默认真实发送必须关闭：`COLLECTION_ENABLE_REAL_SEND=false`。
- 首次真实验收只能单链、单地址、单小额、单任务、人工确认，完成后立即关闭真实发送。
- 禁止批量真实发送、绕过后台单条入口、直接改库标记 SENT/CONFIRMED、放宽 guard。

### RQ Worker / 常驻服务 / systemd

- RQ 已作为低频任务总线用于 collection/gas/tx_confirm/withdraw/email/release/payout/maintenance。
- systemd 模板已覆盖主 API、worker、scheduler、scanner/loop，并新增独立 `exchange-spot-match-worker.service` 承担现货内盘撮合。
- 生产建议保持 `ENABLE_SPOT_AUTO_MATCH_IN_API=0`，由 `exchange-spot-match-worker.service` 作为现货撮合唯一 owner。
- 上线侧必须确认每个 loop 的唯一 owner；多 API 副本上线前尤其要避免内嵌 startup loop 和独立 service 重复执行。

### 移动端 React Native

- `mobile` 已纳入主仓库，不是 submodule。
- V1 已有导航壳、登录/注册、token 持久化、首页组件、行情/交易/合约/资产占位工作台。
- 固定 5 Tab 和 lucide icon-first UI 是当前产品边界。
- 后续移动端开发应继续限制在 `mobile/`，复用后端现有 API，不创建独立 mobile backend。
- 当前仍有 `stash@{0}` 的 mobile home deferred 内容，恢复前应先让用户确认是否纳入。

## 四、当前已冻结不建议大改的部分

以下模块已进入收口/保护态，除非有明确缺陷和最小修复范围，不建议大改：

- 现货撮合、订单状态机、成交与资金结算。
- 合约订单、保证金、仓位、强平、TP/SL、合约会计 reconciliation。
- 手续费、VIP 费率、RCB 抵扣和资金流水写入语义。
- 分红池分发、BD/邀请佣金发放语义。
- Dealer 风控、Dealer loop、股票 dealer 深度/价格/成交服务。
- 资金归集 guard、Gas guard、tx_confirm 状态推进。
- 提现审核、提现发送、提现风控、withdraw watcher。
- Admin RBAC 权限模型和高风险 POST 拦截策略。
- DB Lifecycle 对核心账务表的禁止清理策略。
- Geo Access 生产名单和 formal blocking 决策，除非运营/合规重新确认。

## 五、当前仍未完成 / 后置事项

### P0

当前代码层无新的 P0 BLOCKER。若进入真实上线/交付，以下是部署前必须确认项：

- 生产 `.env`、JWT/Cookie/CORS、数据库、Redis、SMTP/DirectMail、Moralis、RPC、热钱包、iTick、Geo Access、RQ 等配置必须由运维确认，且真实密钥不得入 Git。
- systemd 中 API、RQ、scheduler、scanner、loop 必须确认唯一 owner，避免重复启动。
- GeoIP DB 文件、授权、更新责任、Cloudflare `CF-IPCountry` / `CF-Connecting-IP` 转发必须在生产环境确认。
- 任何真实链上资金动作、归集、补 Gas、提现、payout 必须先小额人工验收。

### P1

- 修正或复核 `docs/chain_capabilities_v1.md` 与当前 `chain_capabilities.py` 的差异，尤其 `avaxc/ethereum/optimism` 当前代码为 READY，而旧文档仍称 CONFIG_ONLY。
- 处理或明确 `stash@{0}: wip: mobile home experience deferred` 是否恢复、丢弃或转为后续分支。
- 在 staging 验证 VIP/Dealer 风控真实保存回显。
- 在 staging 验证 Redis 行情缓存并发 miss、lock busy、loader error、provider_version 隔离。
- 在 staging/页面手工确认合约行情图表价格线、hover OHLC、股票/CFD 多标的视觉表现。
- 清理或解释多 lockfile 导致的 Next workspace root warning；更新 Browserslist/caniuse-lite。

### P2

- 大表后台从 offset pagination 逐步迁移 keyset pagination。
- 核心账务归档 V2：月度 archive 表、manifest、COUNT/checksum/SUM 校验、冷数据导出、回滚流程。
- Worker/RQ/Archive/DB Lifecycle 运维看板增强。
- White-Label 增加媒体库、图片删除、主题色、多语言 Banner、配置审计、导入导出。
- Reference Overlay 的 STOCK 自动同步：`BON-2USDT`、`CREG-2USDT`、`IMAA-2USDT`。
- 新链上线验收标准化，尤其 avaxc/ethereum/optimism 当前代码能力状态需要配套真实链路验收和文档同步。

## 六、关键开发约束

- 不要随意启动本地 dev server、浏览器、uvicorn、Next、worker、RQ、systemd 或其他长时间进程。
- 不要随意杀 `python.exe` / `node.exe`。
- 不要关闭 PyCharm。
- 端口冲突必须先查 PID 和命令行，再由用户确认后处理。
- Codex 主要做代码修改和轻量验证；用户负责页面手工验证。
- 浏览器、移动端、真实链上、真实 DB 写操作、真实发送、生产服务重启，都必须先得到明确授权。
- 中文文件必须使用 UTF-8，避免 PowerShell 默认编码造成乱码。
- 敏感配置和密钥不得入 Git；报告中只写字段名和存在性，不打印真实值。
- Windows 环境优先用 `npm.cmd`；后端优先使用仓库 `.venv`。
- 只读审计、Git-only、mobile-only、filter-only 等范围要求必须严格遵守。

## 七、数据源清理建议

建议让 ChatGPT 项目数据源优先包含：

- `docs/project_context/current_dev_context_v2.md`。
- 当前仍有效的阶段锁定和边界文档：`docs/admin_recovery_phase_lock_v1.md`、`docs/reference_overlay_phase_lock_v1_7.md`、`docs/geo_access_control_v1.md`、`docs/core_financial_tables_lifecycle_policy_v1.md`、`docs/db_lifecycle_policy_v1.md`、`docs/chain_capabilities_v1.md`（需标记待复核）、`docs/rq_migration_status.md`、`docs/rq_worker_runbook.md`、`docs/linux_services.md`、`docs/collection_go_live_checklist.md`、`docs/collection_operator_runbook.md`、`docs/white_label_home_v1_status.md`。
- 最新 release 最终态文档：`docs/release/release_final_pre_push_verification_20260619.md`、`docs/release/core_archive_post_commit_verification_20260619.md`、`docs/release/geo_access_formal_blocking_signoff_20260619.md`、`docs/release/geo_access_production_confirmation_20260619.md`。

可以被本文覆盖、不建议继续放入 ChatGPT 数据源的旧过程文档：

- `docs/release/release_readiness_audit_20260619.md`：早期 BLOCKER 状态已被后续 fix/final verification 覆盖。
- `docs/release/release_blockers_fix_20260619.md`、`docs/release/release_blockers_fix_v2_20260619.md`：过程型修复记录，可归档。
- `docs/release/release_commit_plan_20260619.md`：提交计划已过期，当前主线已提交/推送到 `origin/main`。
- `docs/release/release_post_commit_verification_20260619.md`：可由 final pre-push 和 core archive post-commit 文档覆盖。
- `docs/release/release_audit_evidence_20260616.md`、`docs/release/release_audit_p0_recheck_20260616.md`、`docs/release/release_audit_final_recheck_20260616.md`：旧阶段审计证据，适合归档，不再作为当前状态源。
- `docs/release/上线前代码检测与系统稳定性检查报告_20260616.md` 和 PDF：偏交付/运营报告，不适合作为后续开发主数据源。

建议保留但不放入 ChatGPT 主数据源、按需检索：

- `docs/ops/admin_configuration_guide_ops_v1.md`：未跟踪的运营版后台配置说明，面向运营，不是开发续上下文。
- `docs/launch_validation_checklist.md`、`docs/production_startup_runbook.md`、`docs/local_dev_startup.md`：运行手册类文档，后续启动/部署时按需读取。
- `docs/db_table_lifecycle_audit_20260619.md`、`docs/core_ledger_archive_design_v1.md`：证据和设计较长，适合归档或按主题检索，不建议常驻主数据源。

## 八、下一阶段推荐开发入口

1. 链能力状态复核与文档同步：先核对 `chain_capabilities.py`、asset options、withdraw sender、collection guard、avaxc/ethereum/optimism 真实验收状态，再决定修文档还是修能力白名单。
2. Staging 验证收口：按 P1 列表验证 VIP/Dealer 保存、Redis 行情缓存并发、合约行情视觉、Geo Access Cloudflare/GeoIP。
3. 移动端继续开发：处理 `stash@{0}`，在 `mobile/` 内补齐 Home/Markets/Trade/Contract/Assets 的真实 API 接入和登录后工作台体验。
4. 运维面板增强：RQ 失败任务、maintenance、archive、DB Lifecycle、service heartbeat 和 systemd owner 状态可视化。
5. 核心账务归档 V2：基于已完成的 archive infrastructure，推进 manifest、校验、只读预览、生产 dry-run 流程，不做热表删除。
