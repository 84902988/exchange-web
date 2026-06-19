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

## 当前未提交：Markets V1 / Trade V1 / Mobile Market Snapshot V1

说明：

- Markets V1 已完成深色金色主题、搜索、分类 Tab、6 张概览卡、分区列表和状态页。
- Home / Markets 底部 TabBar 与正文间距已统一，分类 Tab 上跳问题已修复。
- Mobile Market Snapshot V1 已新增 `GET /market/mobile/overview`，mobile 优先请求该接口，失败或空 snapshot 时 fallback 到旧真实接口。
- Trade V1 已完成现货交易页结构、买卖表单、盘口、更多功能 Sheet 和未登录限制逻辑。
- 移动端原生 K线 V1 已完成蜡烛图、周期切换、MA、坐标轴、最新价标签、Modal 复用和横向拖动。
- Trade / K线 已做首屏加载和拖动性能收口。

验证：

- `py_compile`：通过
- `git diff --check -- backend mobile`：通过，仅 LF/CRLF 提示
- `npm.cmd run lint`：通过
- `npx.cmd tsc --noEmit`：通过
