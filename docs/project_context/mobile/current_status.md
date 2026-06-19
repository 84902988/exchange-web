# Mobile Current Status

- 移动端项目目录：`mobile/`
- 技术栈：React Native 0.86 + React 19
- 主 Tab：Home / Markets / Trade / Contract / Assets
- 中文 Tab：首页 / 行情 / 交易 / 合约 / 资产

## 已完成

- 移动端导航壳
- 登录 / 注册
- AuthProvider + AsyncStorage token 持久化
- SplashScreen 接入 Royal Exchange Logo
- HarmonyOS Sans 字体接入结构
- 首页 deferred stash 已恢复
- HomeNewsFeed 已接入
- InfoFeed 已移除
- mobile 品牌基础提交：`d2464af`
- 移动端调试脚本提交：`b9b17e2`

## 当前可用调试命令

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\mobile_dev_start.ps1
```

## 当前待做

- 首页体验继续优化
- 然后做 Markets V1 真实行情接入
