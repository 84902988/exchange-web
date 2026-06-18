# 上线前最终总复检内部证据报告

生成日期：2026-06-16  
报告性质：内部审计证据，不作为甲方正式报告  
复检范围：代码层静态复检、基础构建检查、迁移与 seed 静态检查、Worker/Loop 静态检查、资金安全保护静态检查  
执行限制：未启动浏览器、未启动 uvicorn/dev server、未执行 TestClient/httpx、未连接外部生产服务、未执行真实资金动作、未修改数据库、未提交 git commit。

## 1. 总体结论

上线前代码层最终复检通过。当前未发现代码层 P0 / P1 阻塞项；VIP / Dealer 风控真实保存回显需在测试库或 staging 环境完成操作验证；Redis 公共行情缓存已接入核心 ticker 接口，但真实 Redis 并发 lock 与 provider_version 联动仍建议在 staging 验证；股票盘前/盘后报价与 K线口径已完成代码层收口，价格线视觉表现建议在 staging 人工确认；P2 为上线后优化或部署确认项。

当前风险计数：

| 等级 | 数量 | 说明 |
| --- | ---: | --- |
| P0 | 0 | 代码层静态复检未发现阻塞上线项 |
| P1 | 0 | 本轮复检范围内 P1 已清零 |
| P2 | 4 | 上线后优化或部署确认项，见第 10 节 |

是否建议进入甲方正式报告生成阶段：建议进入正式报告准备阶段；正式对外报告建议补齐 staging 操作证据后生成，尤其是 VIP / Dealer 真实保存回显、Redis 并发 lock 行为、合约行情视觉表现人工确认。

## 2. Git 与敏感信息

### 2.1 工作区状态

执行命令：

```powershell
git status --short
```

结果摘要：

- 当前工作区存在多处已修改与未跟踪文件，均为前序 P0/P1 修复、Redis 公共行情缓存、合约行情展示、后台审计与页面修复相关变更。
- 代表性修改文件包括：
  - `backend/app/services/admin_queries.py`
  - `backend/app/routers/admin_pages.py`
  - `backend/app/admin/activity_admin.py`
  - `backend/app/routers/market.py`
  - `backend/app/routers/contract_market.py`
  - `backend/app/services/market_cache.py`
  - `backend/app/services/market_cache_metrics.py`
  - `backend/app/services/contract_market_service.py`
  - `backend/app/services/market.py`
  - `backend/app/routers/kyc.py`
  - `web/app/markets/page.tsx`
  - `web/components/markets/MarketsTable.tsx`
  - `web/app/contract/page.tsx`
  - `web/components/contract/ContractFuturesChart.tsx`
  - `web/components/contract/hooks/useContractMarketState.ts`
  - `web/lib/contractMarketCache.ts`
  - `web/lib/realtime/contractMarketRealtime.ts`
  - `web/lib/api/modules/contract.ts`
  - `web/components/trading/TradingPage.tsx`
  - `web/config/locales/zh.json`
  - `web/config/locales/zh-TW.json`
  - `web/config/locales/ja.json`
- 本轮新增/更新内部证据文件：
  - `docs/release/release_audit_final_recheck_20260616.md`

### 2.2 env 示例文件

执行命令：

```powershell
Test-Path .env.example
Test-Path backend\.env.example
Test-Path web\.env.example
```

结果：

- `.env.example`：存在
- `backend/.env.example`：存在
- `web/.env.example`：存在

### 2.3 敏感信息静态扫描

执行命令：

```powershell
git ls-files .env backend/.env web/.env backend/*.pem web/*.pem *.pem
git ls-files | rg -n "(^|/)(\.env|.*\.env$)|id_rsa|private.?key|wallet|keystore|mnemonic|seed\.json|secret"
git diff -- . | rg -n "BEGIN .*PRIVATE KEY|0x[a-fA-F0-9]{64}|mnemonic|HOT_WALLET_PRIVATE|PRIVATE_KEY=|DATABASE_URL=|SECRET_KEY=|api_secret|api_key"
```

结果：

- 未发现 `.env`、私钥文件、pem 私钥、真实 token、真实 secret、真实数据库连接串或热钱包私钥进入版本库。
- `git ls-files` 命中项主要为 `.env.example`、代码文件、热钱包功能模板或脚本文件名，不包含可直接使用的真实密钥。
- 本地存在的 `backend/.env` 未进入 git 跟踪。

## 3. P0 复检结果

### 3.1 VIP / Dealer 风控 `_ok_stub` 复检

检查目标函数：

- `admin_toggle_vip_fee_level_enabled`
- `admin_update_vip_fee_level_rule`
- `admin_save_dealer_risk_limit`
- `admin_toggle_dealer_risk_enabled`
- `admin_toggle_dealer_risk_status`

执行命令：

```powershell
rg -n "admin_toggle_vip_fee_level_enabled\s*=\s*_ok_stub|admin_update_vip_fee_level_rule\s*=\s*_ok_stub|admin_save_dealer_risk_limit\s*=\s*_ok_stub|admin_toggle_dealer_risk_enabled\s*=\s*_ok_stub|admin_toggle_dealer_risk_status\s*=\s*_ok_stub" backend/app/services/admin_queries.py backend/app/routers/admin_pages.py
rg -n "admin_toggle_vip_fee_level_enabled|admin_update_vip_fee_level_rule|admin_save_dealer_risk_limit|admin_toggle_dealer_risk_enabled|admin_toggle_dealer_risk_status|_ok_stub|rowcount|commit\(" backend/app/services/admin_queries.py backend/app/routers/admin_pages.py
```

结果：

- 5 个目标函数均未再绑定 `_ok_stub`。
- `_ok_stub` 仅保留为通用 stub 函数定义，未被上述真实后台写操作引用。
- 5 个目标函数均位于 `backend/app/services/admin_queries.py`，存在真实 SQLAlchemy 写入逻辑、输入校验、异常返回、`rowcount` 或对象存在性检查。
- Dealer / VIP 相关路由位于 `backend/app/routers/admin_pages.py`，成功路径均有 `db.commit()`，成功提示来自 service 返回结果。

关键位置：

- `backend/app/services/admin_queries.py:11905`：`admin_toggle_vip_fee_level_enabled`
- `backend/app/services/admin_queries.py:11939`：`admin_update_vip_fee_level_rule`
- `backend/app/services/admin_queries.py:12033`：`admin_save_dealer_risk_limit`
- `backend/app/services/admin_queries.py:12168`：`admin_toggle_dealer_risk_enabled`
- `backend/app/services/admin_queries.py:12200`：`admin_toggle_dealer_risk_status`
- `backend/app/routers/admin_pages.py:12334`：VIP 规则更新成功后 `db.commit()`
- `backend/app/routers/admin_pages.py:12354`：VIP 启停成功后 `db.commit()`
- `backend/app/routers/admin_pages.py:12775`：Dealer 风控保存成功后 `db.commit()`
- `backend/app/routers/admin_pages.py:12799`：Dealer 启停成功后 `db.commit()`
- `backend/app/routers/admin_pages.py:12823`：Dealer 状态切换成功后 `db.commit()`

结论：P0-1 代码层静态复检通过。VIP / Dealer 真实保存回显仍需在 staging 或测试库执行操作验证。

### 3.2 Activity / Activity Banner RBAC 复检

检查目标 POST：

- `POST /activities/new`
- `POST /activities/{activity_id}/edit`
- `POST /activities/{activity_id}/toggle-status`
- `POST /activities/{activity_id}/delete`
- `POST /activity-banners/new`
- `POST /activity-banners/{banner_id}/edit`
- `POST /activity-banners/{banner_id}/toggle-enabled`
- `POST /activity-banners/{banner_id}/delete`

执行命令：

```powershell
Select-String -Path backend\app\admin\activity_admin.py -Pattern '@router.post','require_admin\(request\)','require_admin_post_permission','site_content.manage','activities/new','toggle-status','activity-banners'
```

结果：

- 8 个 POST 均保留 `require_admin(request)`。
- 8 个 POST 均接入 `require_admin_post_permission(request, db, "site_content.manage")`。
- 未发现 Activity / Activity Banner POST 仅登录、不鉴权的路径。

关键位置：

- `backend/app/admin/activity_admin.py:204`、`249`、`252`
- `backend/app/admin/activity_admin.py:348`、`394`、`397`
- `backend/app/admin/activity_admin.py:471`、`478`、`481`
- `backend/app/admin/activity_admin.py:496`、`498`、`501`
- `backend/app/admin/activity_admin.py:574`、`596`、`599`
- `backend/app/admin/activity_admin.py:669`、`692`、`695`
- `backend/app/admin/activity_admin.py:744`、`751`、`754`
- `backend/app/admin/activity_admin.py:769`、`771`、`774`

结论：P0-2 代码层静态复检通过。

## 4. P1 复检结果

### 4.1 多语言 `????`

执行命令：

```powershell
node -e "const fs=require('fs'); for (const f of ['web/config/locales/zh.json','web/config/locales/zh-TW.json','web/config/locales/ja.json']) { const s=fs.readFileSync(f,'utf8'); JSON.parse(s); const q4=(s.match(/\?\?\?\?/g)||[]).length; const q2=(s.match(/\?{2,}/g)||[]).length; console.log(`${f}: parse ok, ????=${q4}, ?{2,}=${q2}`); }"
```

结果：

- `web/config/locales/zh.json`：JSON parse 通过，`????=0`，连续问号占位 `?{2,}=0`
- `web/config/locales/zh-TW.json`：JSON parse 通过，`????=0`，连续问号占位 `?{2,}=0`
- `web/config/locales/ja.json`：JSON parse 通过，`????=0`，连续问号占位 `?{2,}=0`

结论：多语言 P1 已清理。

### 4.2 TradingPage 模拟资产数据

执行命令：

```powershell
rg -n "mockAssetData|500 USDT|2\.08 MMR|0\.0409" web/components/trading/TradingPage.tsx
```

结果：

- 未发现 `mockAssetData`。
- 未发现 `500 USDT`、`2.08 MMR`、`0.0409` 等模拟资产值。

结论：TradingPage 模拟资产数据 P1 已清理。

### 4.3 前端源码 lint

执行命令：

```powershell
npm.cmd run lint -- --ignore-pattern .next/** --ignore-pattern .next.codex-backup-*/** --ignore-pattern node_modules/**
```

结果：

- error：0
- warning：28
- warning 类型主要包括：
  - `@next/next/no-img-element`
  - `@typescript-eslint/no-unused-vars`
  - `react-hooks/exhaustive-deps`

结论：源码 lint error 已清零；剩余 warning 不构成本轮 P1 阻塞项。

### 4.4 KYC 审核人归因

执行命令：

```powershell
Select-String -Path backend\app\routers\kyc.py -Pattern 'reviewed_by','admin_id','require_admin','approve','reject','TODO' -Context 2,3
```

结果：

- approve / reject 不再写固定 `reviewed_by = "admin"`。
- `_admin_reviewer_id(request)` 优先读取后台管理员 `admin_id` / `id`，并保留用户名、旧 cookie 等兼容 fallback。
- 未改变 KYC 状态流转。

关键位置：

- `backend/app/routers/kyc.py:135` 至 `139`：真实管理员 ID 与兼容 fallback
- `backend/app/routers/kyc.py:462`：approve 写入 reviewer
- `backend/app/routers/kyc.py:495`：reject 写入 reviewer

结论：KYC 审核人归因 P1 已修复。

### 4.5 Markets 股票 / 股票合约 24h 字段

执行命令：

```powershell
rg -n "high_24h|low_24h|base_volume_24h|quote_volume_24h|turnover|amount|buildContractRow|applyTickerCaches|quoteVolume" backend/app/services/market.py backend/app/services/itick_market_service.py backend/app/services/contract_market_service.py backend/app/schemas/contract_market.py web/app/markets/page.tsx web/components/markets/MarketsTable.tsx
```

结果：

- 普通 STOCK / iTick ticker 已映射或兼容 `high_24h`、`low_24h`、`base_volume_24h`、`quote_volume_24h`。
- 股票合约 contract ticker 已映射或兼容 `high_24h`、`low_24h`、`base_volume_24h`、`quote_volume_24h`。
- 前端 `buildContractRow` / `applyTickerCaches` 保留股票合约高、低、成交额字段。
- `MarketsTable` 兼容 high / low / volume / turnover / amount / value / quoteVolume 等别名。
- 成交额显示优先 `quote_volume_24h`，其次 `turnover` / `amount` / `value` / `quoteVolume`，再用 `base_volume_24h * last_price` 兜底。
- 未发现硬写假数据或随机数补数路径；无真实源数据时显示 `--`。

关键位置：

- `backend/app/services/market.py:1537` 至 `1551`
- `backend/app/services/market.py:1577` 至 `1683`
- `backend/app/services/market.py:1745` 至 `1749`
- `backend/app/services/market.py:1856` 至 `1860`
- `backend/app/services/itick_market_service.py:593` 至 `621`
- `backend/app/services/contract_market_service.py:1080` 至 `1131`
- `backend/app/services/contract_market_service.py:1970` 至 `1994`
- `web/app/markets/page.tsx:303` 至 `320`
- `web/app/markets/page.tsx:344` 至 `367`
- `web/app/markets/page.tsx:480` 至 `506`
- `web/app/markets/page.tsx:541` 至 `564`
- `web/components/markets/MarketsTable.tsx:58` 至 `62`
- `web/components/markets/MarketsTable.tsx:122` 至 `126`

结论：Markets 股票 / 股票合约 24h 字段 P1 代码层复检通过。

### 4.6 Redis 公共行情缓存

执行命令：

```powershell
rg -n "def market_cache_key|provider_version|field_version|version|lock|last_good|is_stale|stale_reason|cache_updated_at|user balance|用户余额|KYC|提现|private|binance|itick|cache_fetch_json" backend/app/services/market_cache.py backend/app/routers/market.py backend/app/routers/contract_market.py backend/app/services/market_cache_metrics.py
```

结果：

- `market_cache_key` 兼容旧调用，并支持 `version` / `provider_version` / `field_version` / `query_params` 等维度。
- `/market/tickers` 已升级为显式 v1 key。
- `/contract/market/tickers` 已升级为显式 v1 key。
- 缓存层未写死 `crypto = Binance`、`futures = Binance`、`stock = iTick`。
- `market_cache.py` 明确公共数据边界，不缓存用户余额、订单、持仓、KYC、提现、用户资产、用户私有 WS 数据。
- last_good 返回时会补 `is_stale`、`stale_reason`、`cache_updated_at` 等 stale 标记。
- Redis miss 存在 lock / 防击穿保护；Redis 不可用时保留 memory fallback。
- 缓存 JSON roundtrip 不过滤业务字段，能够保留 `high_24h`、`low_24h`、`quote_volume_24h`。

关键位置：

- `backend/app/services/market_cache.py:45`
- `backend/app/services/market_cache.py:54` 至 `80`
- `backend/app/services/market_cache.py:88` 至 `152`
- `backend/app/services/market_cache.py:201` 至 `225`
- `backend/app/services/market_cache.py:283` 至 `341`
- `backend/app/services/market_cache.py:346` 至 `388`
- `backend/app/services/market_cache.py:394` 至 `450`
- `backend/app/routers/market.py:89` 至 `102`
- `backend/app/routers/contract_market.py:200` 至 `217`
- `backend/app/services/market_cache_metrics.py:51` 至 `72`
- `backend/app/services/market_cache_metrics.py:203` 至 `256`

结论：Redis 公共行情缓存 P1 代码层复检通过；真实 Redis 并发 lock 与 provider_version 联动仍建议在 staging 验证。

### 4.7 合约股票 / CFD 报价与 K线口径

执行命令：

```powershell
rg -n "latestCandlePatchPrice|latestCandlePatchTime|best\.mid|allowRealtimeTradeCandlePatch|title: ''|canPatchLatestCandleWithQuote|Date\.now\(\)|PRE_MARKET|AFTER_HOURS|最后报价|最新价|标记价格|最近有效价" web/app/contract/page.tsx web/components/contract/ContractFuturesChart.tsx
rg -n "最新价|标记价格|最近有效价|Last price|Mark price|Cached quote" web/components/contract/ContractFuturesChart.tsx
```

结果：

- 合约页通过 `latestCandlePatchPrice` / `latestCandlePatchTime` 收口图表 patch 入口。
- 股票 / CFD 非 crypto 合约在 BBO 有效时优先使用 best bid / best ask midpoint 作为可信展示价与 K线 patch 价。
- `ContractFuturesChart` 仅使用页面传入的可信 patch price，不再自行混合 lastPrice / midPrice 推导漂浮价格线。
- quote 不会无条件污染 Kline OHLC；价格 patch 只作用于已存在最后一根 candle，不创建未来 candle，不使用 `Date.now()` 强建当前 bucket，不修改 volume。
- 盘前 / 盘后 / stale 场景不污染 K线；价格线视觉语义改为不显示“最新价 / 标记价格 / 最近有效价”等文字标签，仅保留价格线与价格轴数字。
- 数字货币合约不被强行改为 BBO mid；realtime trade patch 仍通过 `allowRealtimeTradeCandlePatch` 限定 crypto 合约路径。
- hover OHLC 逻辑保持原状，未改为固定显示最新价。

关键位置：

- `web/app/contract/page.tsx:263`
- `web/app/contract/page.tsx:355`
- `web/app/contract/page.tsx:632`
- `web/app/contract/page.tsx:636`
- `web/app/contract/page.tsx:907` 至 `911`
- `web/components/contract/ContractFuturesChart.tsx:440`
- `web/components/contract/ContractFuturesChart.tsx:560`
- `web/components/contract/ContractFuturesChart.tsx:576`
- `web/components/contract/ContractFuturesChart.tsx:1179`
- `web/components/contract/ContractFuturesChart.tsx:1385`
- `web/components/contract/ContractFuturesChart.tsx:1393`

结论：股票 / CFD 报价与 K线口径已完成代码层收口；价格线视觉表现建议在 staging 人工确认。

## 5. 基础检查

### 5.1 Python py_compile

执行范围：

- `backend/app`
- `backend/scripts`
- `backend/alembic`

执行结果：

```text
py_compile files=413 errors=0
```

结论：通过。

### 5.2 Locale JSON parse

执行结果：

```text
web/config/locales/zh.json: parse ok, ????=0, ?{2,}=0
web/config/locales/zh-TW.json: parse ok, ????=0, ?{2,}=0
web/config/locales/ja.json: parse ok, ????=0, ?{2,}=0
```

结论：通过。

### 5.3 前端构建

执行命令：

```powershell
npm.cmd run build
```

结果：

- 构建通过。
- 非阻塞 warning：`baseline-browser-mapping` / Browserslist 数据过期提示、多个 lockfile 导致 Next.js root 推断提示。

结论：通过。

### 5.4 Jinja admin templates parse

执行命令：

```powershell
.venv\Scripts\python.exe <jinja_parse_script>
```

结果：

```text
jinja admin templates=101 errors=0
```

结论：通过。

### 5.5 git diff --check

执行命令：

```powershell
git diff --check
```

结果：

- 通过。
- 输出中存在 CRLF/LF 换行提示，不属于 whitespace error。

结论：通过。

### 5.6 源码 eslint

执行命令：

```powershell
npm.cmd run lint -- --ignore-pattern .next/** --ignore-pattern .next.codex-backup-*/** --ignore-pattern node_modules/**
```

结果：

- error：0
- warning：28

结论：通过；warning 不阻塞本轮复检。

## 6. 数据库迁移与 seed 静态复检

### 6.1 Alembic revision

执行结果：

```text
alembic files=101 revisions=101 heads=['20260616_000102'] errors=0
```

结论：

- Alembic revision 文件语法检查通过。
- 未发现重复 revision。
- 当前为单 head：`20260616_000102`。

### 6.2 必要 seed 文件 / 迁移

检查结果：

- VIP 等级：存在 `backend/scripts/seed_vip_levels.py`，并存在 Alembic seed `backend/alembic/versions/20260420_000002_seed_vip_levels.py`。
- RBAC 权限 / 管理员角色：存在 `backend/scripts/seed_admin_rbac.py`。
- 交易对：存在 `backend/scripts/seed_api_selection_trading_pairs.py`，并有市场分类与合约品种 seed。
- 资产 / 链配置：存在 `backend/scripts/seed_chain_usdt_asset_configs.py`。
- site_settings / banner / announcement 基础数据：存在 white-label home 相关 Alembic 迁移与活动/banner 表迁移；同时存在 `seed_about_page_content.py`、`seed_legal_pages_content.py`、`seed_help_center_content.py` 等基础内容 seed。
- 股票合约 / TradFi CFD：存在 `backend/scripts/seed_contract_stock_symbols.py` 与 `backend/scripts/seed_contract_tradfi_cfd_symbols.py`。

结论：必要 seed 与基础迁移静态复检通过。

## 7. RQ / Worker / Scheduler / Loop 静态复检

执行命令：

```powershell
Get-ChildItem deploy\systemd\*.service | Select-Object -ExpandProperty Name
rg -n "EMBED_BACKGROUND_LOOPS_IN_API|heartbeat|dealer loop|liquidation|tp.*sl|scheduler|rq" backend/app/main.py backend/scripts deploy/systemd
```

结果：

- systemd 模板存在：
  - `exchange-api.service`
  - `exchange-collection-auto-scheduler.service`
  - `exchange-dealer-loop.service`
  - `exchange-liquidation-scanner.service`
  - `exchange-rq-collection.service`
  - `exchange-rq-email.service`
  - `exchange-rq-gas.service`
  - `exchange-rq-maintenance.service`
  - `exchange-rq-payout.service`
  - `exchange-rq-release.service`
  - `exchange-rq-tx-confirm.service`
  - `exchange-rq-withdraw.service`
  - `exchange-tp-sl-scanner.service`
  - `exchange-withdraw-fee-scheduler.service`
- API、RQ worker、scheduler、dealer loop、liquidation scanner、TP/SL scanner 以独立 service / script 方式分工。
- `EMBED_BACKGROUND_LOOPS_IN_API` 默认不重复启动后台 loop。
- `service_heartbeat` 配置与调用存在，关键 worker / scheduler 脚本有 heartbeat。
- `backend/scripts/start_contract_accounting_reconciliation_scheduler.py` 存在，但未发现对应 systemd service 模板。

结论：Worker / Scheduler / Loop 静态复检通过；`contract_accounting_reconciliation_scheduler` systemd 模板缺口列为 P2 或部署清单待确认项。

## 8. 资金安全保护静态复检

检查范围：

- withdraw
- collection
- gas
- platform adjust
- dividend payout
- BD commission payout
- invite commission payout
- stock lock release

执行命令：

```powershell
rg -n "withdraw|collection|gas|platform adjust|adjust|dividend|bd_commission|invite_commission|stock.*lock|DRYGAS_|DRYRUN_|tx_hash|idempot|status|confirm|whitelist|limit|permission|require_admin_post_permission|rowcount" backend/app backend/scripts
```

静态检查结果：

- withdraw：
  - 后台与任务链路存在状态保护、`rowcount` 检查、`tx_hash` 检查、发送与确认状态区分。
  - watcher 仅处理具备真实 `tx_hash` 且处于发送中状态的记录。
- collection / gas：
  - dry-run hash 与真实 hash 存在区分。
  - `DRYRUN_` / `DRYGAS_` 不作为真实链上完成依据。
  - 真实发送路径受 `real_send`、队列、状态、确认逻辑保护。
- platform adjust：
  - 后台写操作保留 RBAC / POST 权限校验与业务状态保护。
- dividend payout：
  - 任务与 service 层存在 PENDING / PAID 等状态保护与重复处理保护。
- BD commission payout：
  - 任务与 service 层存在 PENDING / PAID 等状态保护。
- invite commission payout：
  - 任务与 service 层存在 PENDING / PAID 等状态保护。
- stock lock release：
  - service 层存在 ACTIVE / RELEASED 状态保护与释放记录。

结论：

- 本轮仅做静态检查，未执行任何真实资金动作。
- 未发现 `DRYGAS_` / `DRYRUN_` 被当作真实完成的明显路径。
- 未发现绕过 guard / 白名单 / 限额 / confirm 文本的明显路径。

## 9. 所有检查命令与结果汇总

| 检查项 | 命令或方式 | 结果 |
| --- | --- | --- |
| Git 状态 | `git status --short` | 工作区存在预期修复变更与未跟踪审计/功能文件 |
| env 示例 | `Test-Path .env.example` 等 | 三个 env example 均存在 |
| 敏感信息 | `git ls-files` + `git diff` + `rg` | 未发现真实密钥/私钥/连接串入库 |
| P0 stub | `rg ... _ok_stub` | 5 个目标函数无 `_ok_stub` 绑定 |
| Activity RBAC | `Select-String activity_admin.py` | 8 个 POST 均登录 + RBAC |
| locale JSON | Node JSON parse | 通过，`????=0`，`?{2,}=0` |
| TradingPage mock | `rg mockAssetData...` | 无命中 |
| KYC reviewer | `Select-String kyc.py` | 已写真实管理员 ID 优先与 fallback |
| Markets 24h 字段 | `rg high_24h...` | 字段链路完整 |
| Redis 缓存 | `rg market_cache_key...` | v1 key / stale / lock / public boundary 存在 |
| 合约行情口径 | `rg latestCandlePatchPrice...` | 价格 patch 收口，K线文字标签已去除 |
| Python compile | py_compile script | `files=413 errors=0` |
| Jinja parse | `.venv` + Jinja Environment | `templates=101 errors=0` |
| eslint | `npm.cmd run lint -- --ignore-pattern ...` | 0 error，28 warnings |
| npm build | `npm.cmd run build` | 通过，非阻塞 warning |
| diff check | `git diff --check` | 通过 |
| Alembic | AST revision parser | `files=101 revisions=101 heads=['20260616_000102'] errors=0` |
| Worker/Loop | systemd + `rg` | 主 worker/scheduler 模板存在，1 个 P2 待确认 |
| 资金安全 | 静态 `rg` | 未发现明显绕过路径 |

## 10. 当前风险分级

### P0：0 项

代码层静态复检未发现 P0 阻塞项。

staging / 测试库待验证项不归为代码 P0：

- VIP / Dealer 风控真实保存回显需在测试库或 staging 环境完成操作验证。

### P1：0 项

本轮复检范围内未发现 P1 阻塞项。

已复检通过范围：

- 多语言 `????` 清理
- TradingPage 模拟资产数据清理
- 源码 eslint error 清零
- KYC 审核人归因
- Markets 股票 / 股票合约 24h 高低成交额字段链路
- Redis 公共行情缓存核心 ticker 接口接入
- 合约股票 / CFD 报价与 K线口径代码层收口
- 数字货币合约价格线文字语义调整与图表文字标签去除

### P2：4 项

| 编号 | 等级 | 模块 | 文件路径 | 问题描述 | 影响 | 建议处理方式 | 是否建议立即修复 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| P2-1 | P2 | 部署 / Scheduler | `backend/scripts/start_contract_accounting_reconciliation_scheduler.py`、`deploy/systemd/` | 存在 contract accounting reconciliation scheduler 启动脚本，但未发现对应 systemd service 模板 | 可能导致部署清单漏配该 scheduler | 在部署清单中确认是否需要独立 service；如需要，补充 systemd 模板 | 否，部署确认项 |
| P2-2 | P2 | VIP / Dealer | `backend/app/services/admin_queries.py`、`backend/app/routers/admin_pages.py` | 代码层写入已修复，但真实保存回显未连接测试库验证 | 需确认真实 DB 环境字段、约束、事务行为与代码一致 | 在 staging 执行启停、规则保存、Dealer 状态切换回显验证 | 否，staging 验证项 |
| P2-3 | P2 | Redis 公共行情缓存 | `backend/app/services/market_cache.py`、`backend/app/routers/market.py`、`backend/app/routers/contract_market.py` | 代码层已接入 lock / stale / v1 key，但真实 Redis 并发 lock 与 provider_version 联动未做运行验证 | 高并发 miss 场景与 provider 配置变更污染隔离仍需真实环境验证 | 在 staging 使用 Redis 做并发 miss / loader error / provider_version 变更验证 | 否，staging 验证项 |
| P2-4 | P2 | 合约行情展示 | `web/app/contract/page.tsx`、`web/components/contract/ContractFuturesChart.tsx` | 股票 / CFD 报价与 K线口径已代码层收口，但未启动浏览器做视觉验证 | 视觉表现、价格线贴合、hover OHLC 行为需人工确认 | 在 staging 对 AAPL、ABBV、EURUSD、DJI、XAG、NAS100、BTC 进行人工回归 | 否，视觉确认项 |

## 11. 未执行项及原因

| 未执行项 | 原因 |
| --- | --- |
| 浏览器 / 页面截图验证 | 本轮限制明确禁止启动浏览器 |
| uvicorn / dev server | 本轮限制明确禁止启动本地服务 |
| TestClient / httpx 冒烟 | 本轮限制明确禁止 |
| 外部行情源 / 外部生产服务连接 | 本轮限制明确禁止连接外部生产服务 |
| 真实 Redis 并发 lock 运行验证 | 需要真实 Redis / staging 环境，本轮仅做代码层静态复检 |
| VIP / Dealer 真实保存回显 | 需要测试库或 staging 数据库，本轮禁止修改数据库 |
| 真实链上发送、提现、归集、补 Gas、分红、BD/邀请发放 | 本轮限制明确禁止真实资金动作 |
| git commit | 本轮限制明确禁止提交 |
| 甲方正式报告 | 本轮仅生成内部复检证据 |

## 12. 后续建议

1. 在 staging 完成 VIP / Dealer 风控真实保存回显验证，并保留操作截图或日志证据。
2. 在 staging 使用真实 Redis 验证并发 miss、lock busy、loader error、last_good stale 返回、provider_version 变更后的缓存隔离。
3. 对合约行情页面进行人工视觉回归，重点覆盖 AAPL、ABBV、EURUSD、DJI、XAG、NAS100、BTC。
4. 部署前确认是否需要为 `contract_accounting_reconciliation_scheduler` 增加独立 systemd service。
5. 甲方正式报告建议在 P2 部署确认项已有明确处理口径后生成。
