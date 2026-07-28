# Linux 前端正式发布说明

本文只规定 Linux 正式环境的前端进程归属和发布流程，不改变 Windows
本地开发方式，也不改变页面、交易或资金业务逻辑。

## 运行方式约定

- Windows 本地开发：在 `web/` 中使用 `npm.cmd run dev`。
- Linux 正式环境：只由 `exchange-web.service` 管理 Next.js 前端。
- 正式前端监听端口：`3000`。
- PM2 不得同时管理名为 `exchange-web` 的前端进程。
- Nginx 只负责反向代理；普通页面、翻译和图片发布不需要重载 Nginx。

正式 unit 模板位于：

```text
deploy/systemd/exchange-web.service
```

## 首次安装 systemd unit

```bash
cd /opt/exchange-web
sudo install -o root -g root -m 0644 \
  deploy/systemd/exchange-web.service \
  /etc/systemd/system/exchange-web.service
sudo systemctl daemon-reload
sudo systemd-analyze verify /etc/systemd/system/exchange-web.service
sudo systemctl enable exchange-web.service
```

首次启动前必须已经准备好：

- `/opt/exchange-web/web/.env.production`
- `/opt/exchange-web/web/node_modules/`
- 一次成功生成的 `/opt/exchange-web/web/.next/BUILD_ID`
- Linux 运行用户和用户组 `www:www`

## 1. 进入前端目录

```bash
cd /opt/exchange-web/web
pwd
```

应显示：

```text
/opt/exchange-web/web
```

## 2. 发布前检查唯一监听

```bash
systemctl is-active exchange-web
systemctl show exchange-web -p MainPID -p ActiveEnterTimestamp
ss -ltnp 'sport = :3000'
```

自动核对端口归属：

```bash
WEB_SERVICE_PID=$(systemctl show exchange-web -p MainPID --value)
WEB_PORT_PID=$(ss -ltnp 'sport = :3000' \
  | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' \
  | head -n 1)

echo "systemd PID: $WEB_SERVICE_PID"
echo "端口 3000 PID: $WEB_PORT_PID"

if [ "$WEB_SERVICE_PID" != "0" ] \
  && [ "$WEB_SERVICE_PID" = "$WEB_PORT_PID" ]; then
  echo "检查通过：3000 端口由 systemd 的 exchange-web 监听"
else
  echo "检查失败：端口归属异常，停止发布并排查"
  exit 1
fi
```

## 3. 检查并清理 PM2 前端残留

```bash
pm2 list --no-color 2>/dev/null | grep exchange-web || true
```

如果出现名为 `exchange-web` 的记录，无论其状态为 `online`、`errored`
还是反复重启，都只删除这一条前端记录：

```bash
pm2 stop exchange-web 2>/dev/null || true
pm2 delete exchange-web 2>/dev/null || true
pm2 save || pm2 save --force
```

不要使用会影响其他 Node.js 服务的广泛停止命令：

```text
pm2 kill
pkill node
killall node
```

清理后重新确认 systemd 的唯一归属：

```bash
systemctl restart exchange-web
systemctl is-active exchange-web
```

## 4. 构建前端

```bash
npm run build
```

只有明确显示构建成功后才能继续。如果出现 `Build failed`、红色编译错误、
命令异常退出或构建中断，立即停止，不要重启 systemd、PM2 或 Nginx。

## 5. 修复 Next.js 运行缓存权限

```bash
install -d -o www -g www -m 0755 .next/cache/images
chown -R www:www .next/cache
```

不要对整个项目执行无差别的递归权限修改。

## 6. 重启正式前端

```bash
systemctl restart exchange-web
```

不要使用 `pm2 restart exchange-web`。

## 7. 检查服务状态

```bash
systemctl is-active exchange-web
systemctl show exchange-web -p MainPID -p ActiveEnterTimestamp
```

验收要求：

- 状态为 `active`。
- `MainPID` 不为 `0`。
- `ActiveEnterTimestamp` 是本次发布后的时间。

如果状态异常，查看日志并停止后续操作：

```bash
journalctl -u exchange-web -n 80 --no-pager
```

## 8. 发布后再次核对唯一监听

```bash
WEB_SERVICE_PID=$(systemctl show exchange-web -p MainPID --value)
WEB_PORT_PID=$(ss -ltnp 'sport = :3000' \
  | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' \
  | head -n 1)

echo "systemd PID: $WEB_SERVICE_PID"
echo "端口 3000 PID: $WEB_PORT_PID"

if [ "$WEB_SERVICE_PID" != "0" ] \
  && [ "$WEB_SERVICE_PID" = "$WEB_PORT_PID" ]; then
  echo "验收通过：前端仅由 systemd 管理"
else
  echo "验收失败：3000 端口归属异常"
  exit 1
fi

pm2 list --no-color 2>/dev/null | grep exchange-web || true
```

PM2 列表中不应再出现 `exchange-web`。

## 9. 服务器本机验收

检查首页和本次修改的页面：

```bash
curl -I http://127.0.0.1:3000/
curl -I http://127.0.0.1:3000/mastercard
```

页面应返回 `HTTP 200`。HTTP 200 只能证明页面可访问；涉及内容更新时，
还必须检查新内容标识。

例如检查 Mastercard 新图片：

```bash
curl -I \
  http://127.0.0.1:3000/images/mastercard/v2/mcbg1-v2.png
curl -I \
  http://127.0.0.1:3000/images/mastercard/v2/mastercard-v2.png

curl -s http://127.0.0.1:3000/mastercard \
  | grep -oE 'mcbg1-v2|mastercard-v2' \
  | sort -u
```

两张图片都应返回 HTTP 200，最后一条命令应同时显示：

```text
mastercard-v2
mcbg1-v2
```

## 10. 浏览器验收

- Windows：使用无痕窗口，或按 `Ctrl + F5`。
- Safari：使用无痕窗口，或按 `Option + Command + R`。
- 至少检查桌面端和移动端。
- 图片更新时分别确认背景图和卡面图均为新版本。

## 文件位置和发布注意事项

- 页面代码：`web/app/<页面路径>/page.tsx`
- 图片文件：`web/public/`
- 翻译文件：`web/config/locales/`
- 静态宣传页不要配置 `force-dynamic`。
- 图片更新尽量使用新文件名，避免复用旧浏览器缓存。
- 修改图片后必须同时检查原图 URL 和页面引用。
- 正确顺序：检查进程、构建、权限处理、systemd 重启、端口核对、页面验收。
- 构建失败时不要重启任何服务。

`pm2-undefined.service` 等历史 PM2 开机项不属于日常发布流程。只有确认
PM2 不再管理任何其他正式服务后，才能在单独的维护操作中停用或删除。
