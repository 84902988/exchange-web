# Mobile Next Tasks

## 已完成

### Home / Markets

- 首页深色金色品牌主题
- 首页未登录 / 登录后状态分层
- Markets V1
- mobile market snapshot + fallback 机制
- 行情页搜索、分类、概览卡、分区列表和状态页

### Trade V1

- 现货交易页 V1
- 买入 / 卖出表单
- 限价 / 市价
- BBO 价格输入框内按钮
- 盘口 7 + 7 固定档位
- 轻量 B/S 买卖盘占比条
- 原生 K线和全屏 Modal
- 未登录不请求私有接口
- 真实下单仍保留 TODO

### Contract V1

- 合约交易页 V1
- 合约 quote / depth / kline / trades
- 合约账户、持仓、订单、成交接口封装
- 未登录不请求私有合约接口
- 逐仓、10x、单向、开仓 / 平仓、开多 / 开空表单结构
- 盘口 7 + 7 固定档位
- 与 Trade 共用 `mobile/src/constants/tradingLayout.ts`
- 真实合约下单仍保留 TODO

### Assets V1

- 总览 / 现货 / 合约 / 邀请 / 代理
- `account-balances`
- contract summary
- invite overview
- BD team overview
- 未登录态简化
- 快捷入口：充值 / 提现 / 划转 / 资金流水

## P0：真实交易提交联调

1. 只读复核现货 `/order/create` 参数契约。
2. 只读复核合约 `/contract/orders/open` 与 `/contract/orders/close-summary` 参数契约。
3. 增加移动端提交前精度、余额、保证金和风险提示校验。
4. 接入真实提交时必须避免假成功提示。
5. 保持未登录不请求私有接口。

## P1：资产子页面

1. 移动端充值页面。
2. 移动端提现页面。
3. 移动端划转页面。
4. 移动端资金流水页面。
5. 子页面接入前先复核现有后端接口，不新建 mobile backend。

## P2：资产估值与账户体验

1. 非 USDT 币种估值。
2. 资产汇率 / 标记价格来源复核。
3. 账户分布图进一步产品化。
4. 邀请 / 代理数据空态和错误态细化。

## P3：体验验证

1. 移动端整体真机验证。
2. 移动端模拟器人工体验验证。
3. Trade / Contract 首屏视觉复核。
4. K线横向拖动和 Modal 交互复核。
5. 未登录 / 已登录分支回归。

## 延后事项

- Markets 行情首屏体感继续优化。
- mobile overview 预热 / 定时刷新缓存。
- Redis last-good 命中率验证。
- 移动端 AsyncStorage 持久化 stale snapshot。
- WebSocket ticker delta 增量更新。
