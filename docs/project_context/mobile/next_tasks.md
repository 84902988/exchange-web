# Mobile Next Tasks

## 已完成

### P0：首页优化

- 检查未登录首页视觉
- 检查登录后首页结构
- 优化快捷入口
- 优化公告 / 新闻 / 活动区
- 优化行情榜单展示
- 完成深色金色品牌主题

### Markets V1

- 行情页结构
- 搜索栏
- 分类 Tab
- 总览 6 张行情卡
- 股票 / 现货 / 合约 CFD / 链上交易分区
- loading / error / empty / 搜索无结果
- 数字格式优化
- skeleton + stale snapshot + fallback 机制

### Trade V1

- 现货交易页 V1
- 买入 / 卖出表单
- 盘口
- 更多功能 Sheet
- 未登录可看公开行情、盘口、K线
- 未登录不请求私有接口
- 真实下单仍保留 TODO

### 移动端原生 K线 V1

- 蜡烛图
- 周期切换：1m / 5m / 15m / 1h / 4h / 1d
- MA5 / MA10 / MA20
- 价格轴 / 时间轴 / 最新价标签
- 主页面和 Modal 复用
- 横向拖动查看历史 K线

## 已知问题

- Markets 行情首屏仍然感觉慢，尚未完全收口
- `/market/mobile/overview` 聚合快照已完成代码层改造，但实际体感仍需后续验证和优化
- 本轮暂缓继续深挖行情性能

## 下一步

### P1：Markets 性能继续优化

1. 后端 mobile overview 预热 / 定时刷新缓存
2. Redis last-good 命中率验证
3. 移动端 AsyncStorage 持久化 stale snapshot，冷启动先展示上次数据
4. Markets WebSocket ticker delta 增量更新
5. 后端 iTick / 外部行情源慢路径拆分，不阻塞移动端首屏
6. mobile overview 接口响应时间打点

### P2：Trade V1 接口收口

- 确认余额接口是否使用 `/asset/account-balances`
- 当前委托 / 历史委托 / 我的成交真实接口核对
- `/order/create` 下单接口接入前做只读契约复核
- 保持未登录不请求私有接口

### P3：Contract / Assets 真实接口接入

- Contract V1 接入
- Assets V1 接入
