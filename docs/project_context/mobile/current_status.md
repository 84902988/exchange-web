# Mobile Current Status

- 移动端项目目录：`mobile/`
- 技术栈：React Native 0.86 + React 19
- 主 Tab：Home / Markets / Trade / Contract / Assets
- 中文 Tab：首页 / 行情 / 交易 / 合约 / 资产
- 当前主题：深色 + 金色品牌体系

## 已完成

### 基础能力

- 移动端导航壳
- 登录 / 注册
- AuthProvider + AsyncStorage token 持久化
- SplashScreen 接入 Royal Exchange Logo
- HarmonyOS Sans 字体接入结构
- 固定 5 个主 Tab：Home / Markets / Trade / Contract / Assets

### Home / Markets

- 首页深色金色品牌主题
- 首页未登录偏转化、登录后偏用户工作台
- 行情页 Markets V1
- 搜索栏、分类 Tab、概览卡和分区列表
- loading / error / empty / 搜索无结果
- mobile market snapshot 优先请求 `/market/mobile/overview`
- snapshot 失败或空数据时 fallback 到旧真实接口

### Trade V1

- 现货交易页 V1
- 顶部业务分类和交易对 Header
- 买入 / 卖出表单
- 限价 / 市价结构
- 盘口展示与点击盘口价填入价格框
- K线主页面和全屏 Modal
- 更多功能 Sheet
- 未登录可看公开行情、盘口、K线
- 未登录不请求私有接口，按钮显示登录
- 已登录显示买入 / 卖出按钮
- 真实现货下单提交仍保留 TODO，不假装成功

### Contract V1

- 合约页已从占位升级为移动端合约交易页结构
- 接入合约 quote / depth / kline / market trades 等公开行情能力
- 接入合约账户、持仓、订单、成交等私有接口封装
- 私有接口按登录态保护，未登录不请求账户、持仓、订单、成交
- 未登录可看合约行情、盘口、K线
- 下单表单包含逐仓、10x、单向、开仓 / 平仓、开多 / 开空、限价 / 市价、价格、数量、百分比和估算信息
- 真实合约下单提交仍保留 TODO，不假装成功

### Assets V1

- 资产页完成总览、现货、合约、邀请、代理结构
- 资产 API 封装接入：
  - `/asset/account-balances`
  - contract summary
  - invite overview
  - BD team overview
- 未登录态已简化：
  - 顶部账户 Tab
  - 总资产卡
  - 登录提示
  - 充值 / 提现 / 划转 / 资金流水快捷入口
- 未登录不请求私有资产、邀请或代理接口
- 登录后展示完整资产、账户分布、现货资产、合约摘要、邀请摘要和代理摘要
- 充值 / 提现 / 划转 / 资金流水仍为后续子页面 TODO

### Trade / Contract UI 收口

- BBO 已移入价格输入框右侧
- 市价模式隐藏 BBO
- 盘口底部精度选择已隐藏
- 保留轻量 B/S 买卖盘占比条
- Trade / Contract 首屏交易区共用统一高度
- 左侧下单卡片、右侧盘口卡片统一规格
- 盘口固定卖 7 档 + 买 7 档，数据不足时用空槽位补齐
- Trade / Contract 共用 `mobile/src/constants/tradingLayout.ts` 布局常量
- 没有新增跟单、TG 信号、交易机器人等假入口

### 移动端原生 K线 V1

- 复用 `react-native-svg`，无新增依赖
- 蜡烛图使用 open / high / low / close
- 周期切换：1m / 5m / 15m / 1h / 4h / 1d
- MA5 / MA10 / MA20
- 右侧价格轴、底部时间轴、最新价标签
- 主页面和 Modal 复用同一 K线组件
- 横向拖动查看历史 K线

## 当前保留 TODO

- 真实现货 / 合约下单提交联调
- 移动端充值页面
- 移动端提现页面
- 移动端划转页面
- 移动端资金流水页面
- 非 USDT 币种估值
- 移动端整体真机 / 模拟器人工体验验证

## 本阶段提交边界

- 允许提交：`mobile/`
- 允许提交：`docs/project_context/mobile/`
- 不提交：`backend/`
- 不提交：`web/`
- 不提交：`docs/ops/`
- 不提交：`docs/project_context/current_dev_context_v2.md`

## 验证记录

- `git diff --check -- mobile docs/project_context/mobile`：通过，仅 LF/CRLF 提示
- `npm.cmd run lint`：通过
- `npx.cmd tsc --noEmit`：通过
