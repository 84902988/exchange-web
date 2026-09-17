# 通用源码与品牌交付

源码默认使用中性名称 `Exchange` 和中性交换图标，不包含客户公司资料、人员名单或商业牌照声明。

## 生成交付副本

1. 在仓库外保存品牌配置，结构参考 `branding.example.json`。Logo、宣传素材和经确认的公司内容也放在仓库外。
2. 导出当前源码到一个尚不存在、且不在任何 Git 仓库内的目录：

   ```powershell
   python scripts/export_public_source.py --target D:/delivery/source
   ```

3. 将配置应用到该副本：

   ```powershell
   python scripts/apply_branding.py --profile D:/private/branding.json --target D:/delivery/source
   ```

   图标生成需要 Pillow。此操作更新 Android/iOS 桌面名称、启动页、图标、移动端品牌配置、网页品牌配置及提供的宣传素材。脚本拒绝修改 Git 工作区。

4. 按原有流程在交付副本中构建。正式包的 API 地址、应用标识、签名材料和后端邮件发件人仍通过各自部署配置设置。

## 配置范围

- `displayName`：桌面及应用内默认名称；网站后台的站点配置继续优先决定其已有动态展示位置。
- `logoFile` / `iconBackground`：外部 Logo 与图标底色。
- `mobile.complianceLicenses`：仅填已确认的牌照内容；空数组隐藏该区域。
- `mobile.blackCard` / `blackCardTranslations`：卡片资料及四语言内容；默认关闭。
- `webTranslations`：按语言覆盖委员会等内容；默认名单为空。
- `assetOverrides`：外部宣传媒体到交付副本 `web/public/` 的映射。
- `legacyLocaleStorageKeys` / `legacyFavoritesStorageKeys`：品牌旧版的用户偏好迁移键；公版默认空数组。行情缓存采用中性新键重新加载。

已有数据库中的站点名称、介绍、邮件地址、上传文件及活动内容由运营后台管理。源码清理不会改写这些数据。新部署必须配置发件邮箱和 `ALIYUN_DM_FROM_ALIAS`，不要把客户 `.env`、证书或签名密钥提交到仓库。

## 发布边界

导出包含当前已跟踪及未忽略的新增源码，排除 Git 历史、运行数据、内部文档、构建产物及常见密钥文件，并附带 SHA-256 清单。导出前仍应检查新增源码和二进制素材；这不是通用秘密扫描器。

修改当前文件不会抹除旧 Git 提交、其他分支、标签、发布附件或已下载副本中的历史品牌资料。若需对外提供完全中性的 Git 仓库，应以审核后的导出建立新的历史；现有仓库的历史改写须另行安排备份与协作迁移。

第三方软件名称、许可证与版权声明保持原样。交易币种、账户数据结构和业务规则不属于品牌配置。
