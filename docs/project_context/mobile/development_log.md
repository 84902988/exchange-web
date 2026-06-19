# Mobile Development Log

## d2464af feat(mobile): add brand splash and home experience

说明：恢复首页体验、接入 Logo、接入字体结构。

## b9b17e2 chore(scripts): add mobile dev helper

说明：新增移动端一键调试脚本。

## a2959c7 feat(mobile): refine home gold theme

说明：

- 首页从青绿色主题调整为金色品牌主题。
- Hero 接近 PPT 第 2 页右侧黄色版。
- 修复 Logo 与 WELCOME BONUS 重叠。
- 修复注册按钮文字颜色。
- 修复底部导航 active 大灰色圆背景。

## 当前阶段：Trade / Contract / Assets V1 收口

说明：

- Contract V1 从占位页升级为移动端合约交易页结构。
- Contract V1 接入合约行情、盘口、K线和成交等公开数据。
- Contract V1 私有数据按登录态保护，未登录不请求账户、持仓、订单、成交。
- Contract V1 真实下单仍保留 TODO，不假装成功。
- Assets V1 完成总览、现货、合约、邀请、代理结构。
- Assets V1 接入 `account-balances`、contract summary、invite overview、BD team overview。
- Assets 未登录态简化为总资产卡、登录提示和快捷入口。
- 充值 / 提现 / 划转 / 资金流水仍为后续子页面 TODO。
- Trade / Contract BBO 已移入价格输入框右侧。
- Trade / Contract 盘口底部隐藏精度选择，保留轻量 B/S 买卖盘占比条。
- Trade / Contract 首屏交易区统一高度，左右卡片统一规格。
- Trade / Contract 盘口固定卖 7 档 + 买 7 档，不足用空槽位补齐。
- Trade / Contract 共用 `mobile/src/constants/tradingLayout.ts` 布局常量。
- 未新增跟单、TG 信号、交易机器人等假入口。

验证：

- `git diff --check -- mobile docs/project_context/mobile`：通过，仅 LF/CRLF 提示
- `npm.cmd run lint`：通过
- `npx.cmd tsc --noEmit`：通过

提交：

- 建议提交信息：`feat(mobile): refine trading and assets experience`
