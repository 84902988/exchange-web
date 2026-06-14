# White-Label Home V1 Status

## 1. 已完成模块

- White-Label 站点基础配置：站点名称、站点标语、Logo、支持邮箱、首页 Hero、页脚说明、风险说明。
- 首页 Banner 管理：后台新增、编辑、启用、禁用，前台只展示启用且有效期内的 Banner。
- 公告管理：后台新增、编辑、启用、禁用，前台展示最新公告。
- 后台图片上传：站点设置和首页 Banner 支持上传图片并自动填入 URL。
- Header 动态化：Logo、站点名称、站点标语消费 `/site/config`。
- Footer 动态化：站点名称、支持邮箱、页脚说明、风险说明、页脚链接配置消费 `/site/config`。
- Admin IA V1：后台左侧菜单已按运营理解重新分组。

## 2. 数据表

- `site_settings`
  - 存储站点白标基础配置、首页 Hero 配置、页脚说明、风险说明、页脚链接开关和链接地址。
- `home_banners`
  - 存储首页 Banner 标题、图片、跳转链接、排序、状态、生效时间和失效时间。
- `announcements`
  - 存储公告标题、slug、摘要、内容、置顶状态、发布状态和发布时间。

相关迁移：

- `20260510_000023_add_white_label_home_tables.py`
  - 新增 `site_settings`、`home_banners`、`announcements`。
- `20260510_000024_add_site_footer_link_config.py`
  - 为 `site_settings` 新增 Footer 链接配置字段。

## 3. API

- `GET /site/config`
  - 返回站点配置、首页 Hero 配置、Footer 配置和 Footer 链接配置。
- `GET /home/banners`
  - 返回启用且在有效期内的首页 Banner，按 `sort_order` 升序排序。
- `GET /announcements/latest`
  - 返回启用、已发布的最新公告，按置顶和发布时间排序。
- `POST /admin/uploads/image`
  - 后台登录后可用，用于上传站点和 Banner 图片。

## 4. 后台页面

- `/admin/site-settings`
  - 管理站点名称、站点标语、Logo、支持邮箱、首页 Hero、免责声明、页脚链接开关和链接地址。
- `/admin/home-banners`
  - 管理首页 Banner 列表、筛选、启用和禁用。
- `/admin/home-banners/new`
  - 新增首页 Banner。
- `/admin/home-banners/{id}/edit`
  - 编辑首页 Banner。
- `/admin/announcements`
  - 管理公告列表、筛选、启用和禁用。
- `/admin/announcements/new`
  - 新增公告。
- `/admin/announcements/{id}/edit`
  - 编辑公告。

## 5. 前台消费位置

- `web/components/layout/Header.tsx`
  - 消费 `logo_url`、`site_name`、`site_slogan`。
- `web/components/layout/Footer.tsx`
  - 消费 `site_name`、`support_email`、`footer_disclaimer`、`risk_disclaimer`、Footer 链接开关和链接 URL。
- `web/components/home/HomePageContent.tsx`
  - 消费 `/site/config`、`/home/banners`、`/announcements/latest`。
- `web/components/home/HomeHero.tsx`
  - 展示首页 Hero 标题、副标题、按钮和背景图。
- `web/components/home/PromoCards.tsx`
  - 展示首页 Banner。
- `web/components/home/HomeNotice.tsx`
  - 展示最新公告。

## 6. 空值语义规则

- 接口失败：前端使用 fallback。
- 配置不存在：后端返回默认配置，前端使用返回值。
- 字段为 `null` / `undefined`：视为未配置，前端可使用 fallback。
- 字段为空字符串 `""`：视为运营主动清空，前端不显示或不使用默认值。
- 后端保存站点设置时，不再把可选字段的空字符串强制替换成默认值。

重点字段：

- `site_slogan`
- `support_email`
- `risk_disclaimer`
- `footer_disclaimer`
- `logo_url`
- `home_hero_image`

## 7. Footer 链接开关规则

Footer 链接由 `site_settings` 控制：

- `show_risk_link`
- `risk_link_url`
- `show_terms_link`
- `terms_link_url`
- `show_privacy_link`
- `privacy_link_url`

规则：

- `show_* = true` 时显示对应链接项。
- `show_* = false` 时不渲染对应链接项。
- URL 有值时渲染为可点击链接。
- URL 为空字符串但 `show_* = true` 时渲染为普通文本。
- `risk_disclaimer` 是风险免责声明正文，不等同于“风险提示”链接。
- `footer_disclaimer` 是品牌补充说明，不与 `risk_disclaimer` 混在同一行。

## 8. 图片上传规则

- 上传接口：`POST /admin/uploads/image`
- 仅后台登录可用。
- 接收 multipart `file`。
- 允许类型：
  - `image/png`
  - `image/jpeg`
  - `image/webp`
  - `image/svg+xml`
- 文件大小限制：2MB。
- 文件名规则：`uuid + 原扩展名`。
- 保存目录：`backend/static/uploads/site/`。
- 返回格式：

```json
{ "url": "/static/uploads/site/<filename>" }
```

- 不提供公开上传接口。
- 不提供删除文件、媒体库、裁剪或 CDN 能力。

## 9. 当前不做的内容

- 不做多租户站点隔离。
- 不做媒体库。
- 不做图片删除。
- 不做图片裁剪、压缩、水印或 CDN 同步。
- 不做站点主题色、字体、布局模板配置。
- 不做法律条款正文 CMS。
- 不做前台导航菜单配置。
- 不改交易、资金、撮合、Dealer、分红、BD、发放逻辑。
- 不打开生产 `ENABLE_DB_AUTO_CREATE_ALL`。

## 10. 后续扩展建议

- 增加媒体库和图片删除能力，并记录上传人、上传时间、文件大小和 MIME 类型。
- 增加 Footer 链接正文页面，如 `/risk`、`/terms`、`/privacy` 的后台配置。
- 增加站点主题配置，如品牌色、按钮色、首页卡片样式。
- 增加 Banner 多语言字段。
- 增加 Banner 点击统计和曝光统计。
- 增加公告详情页的后台预览能力。
- 增加配置变更审计日志。
- 增加站点配置导入、导出能力，便于白标交付和环境同步。
