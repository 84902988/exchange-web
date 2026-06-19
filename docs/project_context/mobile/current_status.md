# Mobile Current Status

- 移动端项目目录：`mobile/`
- 技术栈：React Native 0.86 + React 19
- 主 Tab：Home / Markets / Trade / Contract / Assets
- 中文 Tab：首页 / 行情 / 交易 / 合约 / 资产
- 当前可用调试命令：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\mobile_dev_start.ps1
```

## 已完成

### 基础能力

- 移动端导航壳
- 登录 / 注册
- AuthProvider + AsyncStorage token 持久化
- SplashScreen 接入 Royal Exchange Logo
- HarmonyOS Sans 字体接入结构
- 首页 deferred stash 已恢复
- HomeNewsFeed 已接入，InfoFeed 已移除
- mobile 品牌基础提交：`d2464af`
- 移动端调试脚本提交：`b9b17e2`
- 首页黄色主题提交：`a2959c7 feat(mobile): refine home gold theme`
- 首页已完成 PPT 第 2 页右侧黄色主题优化：Hero Logo 不再压文字，注册按钮白字，底部 Tab active 金色且无大灰色圆背景

### Markets V1

- 行情页结构完成
- 深色金色主题统一
- 搜索栏
- 分类 Tab
- 总览 6 张行情卡
- 股票 / 现货 / 合约 CFD / 链上交易分区
- loading / error / empty / 搜索无结果
- Home / Markets 底部 TabBar 与正文间距统一
- 分类 Tab 上跳问题已修复
- 数字格式优化完成

### Mobile Market Snapshot V1

- 已完成代码层改造，新增后端接口：`GET /market/mobile/overview`
- 后端聚合返回：`server_time`、`updated_at`、`stale`、`source`、`overview_cards`、`sections`
- 后端使用 market cache / last-good：
  - cache key：`market:mobile_overview`
  - TTL：`10s`
  - last-good：`24h`
- mobile 端优先请求 `/market/mobile/overview`
- 新接口失败时 fallback 到旧接口：
  - `/market/pairs?market_type=all&page_size=100`
  - `/market/tickers`
- 已修复 mobile fallback 软失败点：snapshot HTTP 200 但解析为空时，也会 fallback 到旧真实接口
- 只有新旧接口都失败或都无数据时，才进入开发 fallback mock
- 不影响现有 web 接口：`/market/pairs`、`/market/tickers`

### Trade V1

- 现货交易页 V1 深色金色主题
- 顶部业务分类
- 交易对 Header
- 买入 / 卖出表单
- 限价 / 市价结构
- 盘口展示
- 点击盘口价格填入价格框
- 更多功能 Sheet
- 未登录可看公开行情、盘口、K线
- 未登录按钮显示“登录”
- 未登录不请求私有接口
- 已登录显示买入 / 卖出按钮，但真实下单仍保留 TODO，不假装成功

### 移动端原生 K线 V1

- 已确认 `react-native-svg` 已存在，无新增依赖
- 新增移动端原生 K线组件
- 蜡烛图使用 open / high / low / close
- 涨绿跌红
- 支持十字星 / 单根 K线 / 数据不足
- 周期切换：1m / 5m / 15m / 1h / 4h / 1d
- MA5 / MA10 / MA20
- 右侧价格轴
- 底部时间轴
- 最新价标签
- 主页面和 Modal 复用同一 K线组件
- 横向拖动查看历史 K线
- 删除用户端不需要的开发说明文案和摘要行
- 未使用 PC SpotChart、WebView、TradingView

### 性能收口

- Trade 页公开行情拆分加载
- K线 loading 不阻塞 Header / 表单 / 盘口
- K线绘制 useMemo 优化
- 横向拖动减少 setState
- Trade 公开 market 请求 4 秒轻缓存
- 私有余额 / 订单 / 成交不缓存
- Markets 首屏改为 skeleton + stale snapshot + fallback 机制

## 已知问题

- Markets 行情首屏仍然感觉慢，后续单独优化
- 当前已做 `/market/mobile/overview` 聚合快照，但实际体感仍未完全达到预期
- 暂时不继续深挖本轮行情性能，后续作为 P1/P2 优化任务

## 当前未提交状态

- 当前还有 Trade V1 / K线 / Mobile Market Snapshot 相关工作区改动未提交
- `docs/ops/` 和 `docs/project_context/current_dev_context_v2.md` 仍为未跟踪，未处理
- 本轮仅更新进度文档，不提交、不 push

## 验证记录

- `py_compile`：通过
- `git diff --check -- backend mobile`：通过，仅 LF/CRLF 提示
- `npm.cmd run lint`：通过
- `npx.cmd tsc --noEmit`：通过
