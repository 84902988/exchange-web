# Admin RBAC V1 后台 POST 权限拦截清单

## 1. 总结

本次仅做后台 POST 路由权限审计，不改业务代码、不接入拦截、不新增 migration、不改权限 seed。

扫描范围：

- `backend/app/routers/admin_pages.py`
- `backend/app/admin/activity_admin.py`
- `backend/app/routers/kyc.py` 中 `/admin/kyc/*` 后台审核 POST
- `backend/app/routers/admin*.py`：当前仅发现 `admin_pages.py`

扫描结果：

- 按 POST 装饰器计：82 条后台 POST 路由。
- 按同一处理函数的别名路由合并后：76 条审计记录。
- 第一批建议只接 P0。P1/P2 先保留文档评审，避免一次性拦截影响运营流程。
- 当前 seed 中只有部分 `.manage` 权限点；文档中标注“需补 seed 权限点”的路由，接入前应先补权限点并做幂等 seed。

## 2. 风险等级说明

| 等级 | 定义 | 接入建议 |
| --- | --- | --- |
| P0 | 直接影响资金、提现审核、链上发送、平台调账、管理员/角色/权限、资产/链配置、交易对/合约品种启停、Dealer 风控、真实归集/Gas 发送。 | 第一批接入。 |
| P1 | 影响用户状态、KYC 审核、Banner/公告发布和删除、VIP/分红/BD/邀请配置、股票锁仓配置、手动任务触发但不直接转账。 | 第二批接入，先补权限点和操作确认。 |
| P2 | 登录、低风险展示类更新、普通文案或非核心展示配置。 | 最后接入或保持特殊处理。 |

## 3. P0 高风险 POST

| 路由路径 | 所在文件 | 函数名 | 当前动作说明 | 风险等级 | 建议权限码 | 第一批接入 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/admin/admin-users` | `backend/app/routers/admin_pages.py` | `create_admin_user_account` | 新增管理员并绑定角色。 | P0 | `admin_users.manage` | YES | 需补 seed 权限点；当前仅 super_admin 可操作。 |
| `/admin/admin-users/{admin_user_id}/reset-password` | `backend/app/routers/admin_pages.py` | `reset_admin_user_password` | 重置管理员密码。 | P0 | `admin_users.manage` | YES | 需补 seed 权限点。 |
| `/admin/admin-users/{admin_user_id}/disable` | `backend/app/routers/admin_pages.py` | `disable_admin_user_account` | 停用管理员。 | P0 | `admin_users.manage` | YES | 需补 seed 权限点；保留“不能停用自己/最后 super_admin”保护。 |
| `/admin/admin-users/{admin_user_id}/enable` | `backend/app/routers/admin_pages.py` | `enable_admin_user_account` | 启用管理员。 | P0 | `admin_users.manage` | YES | 需补 seed 权限点。 |
| `/admin/admin-roles` | `backend/app/routers/admin_pages.py` | `create_admin_role` | 新增后台角色。 | P0 | `admin_roles.manage` | YES | 需补 seed 权限点；当前仅 super_admin 可操作。 |
| `/admin/admin-roles/{role_id}/edit` | `backend/app/routers/admin_pages.py` | `update_admin_role` | 编辑角色名称、描述、状态。 | P0 | `admin_roles.manage` | YES | 需补 seed 权限点；super_admin 系统角色仍需保护。 |
| `/admin/admin-roles/{role_id}/permissions` | `backend/app/routers/admin_pages.py` | `update_admin_role_permissions` | 更新角色权限绑定。 | P0 | `admin_roles.manage` | YES | 需补 seed 权限点；最高风险权限变更。 |
| `/admin/collections/tasks/{task_id}/real-send` | `backend/app/routers/admin_pages.py` | `collection_task_real_send` | 触发归集任务真实链上发送。 | P0 | `collection_tasks.manage` | YES | 需补 seed 权限点；真实发送必须第一批拦截。 |
| `/admin/collections/gas-tasks/{task_id}/real-send` | `backend/app/routers/admin_pages.py` | `gas_task_real_send` | 触发 Gas 任务真实链上发送。 | P0 | `gas_tasks.manage` | YES | 需补 seed 权限点；真实发送必须第一批拦截。 |
| `/admin/withdraw-reviews/{withdraw_id}/approve` | `backend/app/routers/admin_pages.py` | `withdraw_review_approve` | 提现审核通过。 | P0 | `withdraw_reviews.manage` | YES | 需补 seed 权限点；不要复用 `withdraw_reviews.view`。 |
| `/admin/withdraw-reviews/{withdraw_id}/reject` | `backend/app/routers/admin_pages.py` | `withdraw_review_reject` | 提现审核拒绝。 | P0 | `withdraw_reviews.manage` | YES | 需补 seed 权限点；会影响提现资金状态。 |
| `/admin/asset-configs/assets/create` | `backend/app/routers/admin_pages.py` | `asset_config_asset_create` | 新增资产配置。 | P0 | `asset_configs.manage` | YES | seed 已有。 |
| `/admin/asset-configs/assets/{asset_id}/update` | `backend/app/routers/admin_pages.py` | `asset_config_asset_update` | 更新资产配置。 | P0 | `asset_configs.manage` | YES | seed 已有。 |
| `/admin/asset-configs/assets/{asset_id}/delete` | `backend/app/routers/admin_pages.py` | `asset_config_asset_delete` | 删除资产配置。 | P0 | `asset_configs.manage` | YES | seed 已有；建议保留二次确认。 |
| `/admin/asset-configs/chains/create` | `backend/app/routers/admin_pages.py` | `asset_config_chain_create` | 新增链配置。 | P0 | `asset_configs.manage` | YES | seed 已有。 |
| `/admin/asset-configs/chains/{chain_id}/update` | `backend/app/routers/admin_pages.py` | `asset_config_chain_update` | 更新链配置。 | P0 | `asset_configs.manage` | YES | seed 已有。 |
| `/admin/asset-configs/chains/{chain_id}/delete` | `backend/app/routers/admin_pages.py` | `asset_config_chain_delete` | 删除链配置。 | P0 | `asset_configs.manage` | YES | seed 已有；可能影响充提链路。 |
| `/admin/asset-configs/asset-chains/create` | `backend/app/routers/admin_pages.py` | `asset_config_asset_chain_create` | 新增资产链绑定。 | P0 | `asset_configs.manage` | YES | seed 已有。 |
| `/admin/asset-configs/asset-chains/{asset_chain_id}/update` | `backend/app/routers/admin_pages.py` | `asset_config_asset_chain_update` | 更新资产链绑定。 | P0 | `asset_configs.manage` | YES | seed 已有。 |
| `/admin/asset-configs/asset-chains/{asset_chain_id}/delete` | `backend/app/routers/admin_pages.py` | `asset_config_asset_chain_delete` | 删除资产链绑定。 | P0 | `asset_configs.manage` | YES | seed 已有。 |
| `/admin/pairs/create` | `backend/app/routers/admin_pages.py` | `pair_create_submit` | 新增现货交易对。 | P0 | `trading_pairs.manage` | YES | seed 已有。 |
| `/admin/pairs/{pair_id}/edit` | `backend/app/routers/admin_pages.py` | `pair_edit_submit` | 编辑现货交易对。 | P0 | `trading_pairs.manage` | YES | seed 已有。 |
| `/admin/pairs/{pair_id}/toggle-status` | `backend/app/routers/admin_pages.py` | `pair_toggle_status` | 启停现货交易对。 | P0 | `trading_pairs.manage` | YES | seed 已有。 |
| `/admin/pairs/{pair_id}/delete` | `backend/app/routers/admin_pages.py` | `pair_delete_submit` | 删除现货交易对。 | P0 | `trading_pairs.manage` | YES | seed 已有。 |
| `/admin/contract-symbols/new` | `backend/app/routers/admin_pages.py` | `contract_symbol_create_submit` | 新增合约品种。 | P0 | `contract_symbols.manage` | YES | seed 已有。 |
| `/admin/contract-symbols/{symbol_id}/edit` | `backend/app/routers/admin_pages.py` | `contract_symbol_edit_submit` | 编辑合约品种。 | P0 | `contract_symbols.manage` | YES | seed 已有。 |
| `/admin/contract-symbols/{symbol_id}/toggle` | `backend/app/routers/admin_pages.py` | `contract_symbol_toggle_status` | 启停合约品种。 | P0 | `contract_symbols.manage` | YES | seed 已有。 |
| `/admin/stock-token-locks/release` | `backend/app/routers/admin_pages.py` | `stock_token_locks_release_submit` | 批量释放股票锁仓。 | P0 | `stock_locks.manage` | YES | 需补 seed 权限点；会影响用户资产可用性。 |
| `/admin/stock-token-locks/{lock_item_id}/force-release` | `backend/app/routers/admin_pages.py` | `stock_token_lock_force_release_submit` | 强制释放单笔股票锁仓。 | P0 | `stock_locks.manage` | YES | 需补 seed 权限点。 |
| `/admin/platform/adjust` | `backend/app/routers/admin_pages.py` | `platform_adjust_submit` | 平台账户调账。 | P0 | `platform_adjust.manage` | YES | seed 已有；资金高风险。 |
| `/admin/invite/commissions/{record_id}/pay` | `backend/app/routers/admin_pages.py` | `user_invite_commission_pay` | 支付单笔邀请佣金。 | P0 | `invite_commissions.manage` | YES | 需补 seed 权限点；不要复用 `invite.view`。 |
| `/admin/invite/commissions/pay-pending` | `backend/app/routers/admin_pages.py` | `user_invite_commissions_pay_pending` | 批量支付待支付邀请佣金。 | P0 | `invite_commissions.manage` | YES | 需补 seed 权限点；批量资金操作。 |
| `/admin/bd/commissions/{record_id}/pay` | `backend/app/routers/admin_pages.py` | `bd_commission_pay` | 支付单笔 BD 佣金。 | P0 | `bd_commissions.manage` | YES | 需补 seed 权限点；不要复用 `bd.view`。 |
| `/admin/bd/commissions/pay-pending` | `backend/app/routers/admin_pages.py` | `bd_commissions_pay_pending` | 批量支付待支付 BD 佣金。 | P0 | `bd_commissions.manage` | YES | 需补 seed 权限点；批量资金操作。 |
| `/admin/dividend-pools/{pool_id}/distribute`, `/admin/dividends/{pool_id}/distribute` | `backend/app/routers/admin_pages.py` | `dividend_pool_distribute` | 执行分红池发放。 | P0 | `dividends.distribute` | YES | 需补 seed 权限点；不要复用 `dividend.view`。 |
| `/admin/platform/dealer-risk/save` | `backend/app/routers/admin_pages.py` | `dealer_risk_save` | 保存 Dealer 风控参数。 | P0 | `dealer_risk.manage` | YES | seed 已有。 |
| `/admin/platform/dealer-risk/{risk_id}/toggle-enabled` | `backend/app/routers/admin_pages.py` | `dealer_risk_toggle_enabled` | 启停 Dealer 风控规则。 | P0 | `dealer_risk.manage` | YES | seed 已有。 |
| `/admin/platform/dealer-risk/{risk_id}/toggle-status` | `backend/app/routers/admin_pages.py` | `dealer_risk_toggle_status` | 切换 Dealer 风控状态。 | P0 | `dealer_risk.manage` | YES | seed 已有。 |

## 4. P1 中风险 POST

| 路由路径 | 所在文件 | 函数名 | 当前动作说明 | 风险等级 | 建议权限码 | 第一批接入 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/admin/uploads/image` | `backend/app/routers/admin_pages.py` | `upload_admin_site_image` | 上传后台站点/内容图片。 | P1 | `admin_uploads.manage` | NO | 需补 seed 权限点；也可按调用页面做上下文权限。 |
| `/admin/users/{user_id}/disable` | `backend/app/routers/admin_pages.py` | `disable_user_account` | 停用普通用户。 | P1 | `users.manage` | NO | 需补 seed 权限点；影响用户状态。 |
| `/admin/users/{user_id}/enable` | `backend/app/routers/admin_pages.py` | `enable_user_account` | 启用普通用户。 | P1 | `users.manage` | NO | 需补 seed 权限点。 |
| `/admin/users/{user_id}/withdraw-lock` | `backend/app/routers/admin_pages.py` | `lock_user_withdraw` | 锁定用户提现能力。 | P1 | `users.manage` 或 `withdraw_controls.manage` | NO | 需补 seed 权限点；需人工确认是否升级 P0。 |
| `/admin/users/{user_id}/withdraw-unlock` | `backend/app/routers/admin_pages.py` | `unlock_user_withdraw` | 解除用户提现锁定。 | P1 | `users.manage` 或 `withdraw_controls.manage` | NO | 需补 seed 权限点；需人工确认是否升级 P0。 |
| `/admin/collections/tasks/{task_id}/dry-run` | `backend/app/routers/admin_pages.py` | `collection_task_dry_run` | 归集任务 dry-run。 | P1 | `collection_tasks.manage` | NO | 需补 seed 权限点；不直接转账。 |
| `/admin/collections/gas-tasks/{task_id}/dry-run` | `backend/app/routers/admin_pages.py` | `gas_task_dry_run` | Gas 任务 dry-run。 | P1 | `gas_tasks.manage` | NO | 需补 seed 权限点；不直接转账。 |
| `/admin/stock-token-lock-configs/new` | `backend/app/routers/admin_pages.py` | `stock_token_lock_config_create_submit` | 新增股票锁仓配置。 | P1 | `stock_locks.manage` | NO | 需补 seed 权限点。 |
| `/admin/stock-token-lock-configs/{config_id}/edit` | `backend/app/routers/admin_pages.py` | `stock_token_lock_config_edit_submit` | 编辑股票锁仓配置。 | P1 | `stock_locks.manage` | NO | 需补 seed 权限点。 |
| `/admin/stock-token-lock-configs/{config_id}/toggle-active` | `backend/app/routers/admin_pages.py` | `stock_token_lock_config_toggle_active` | 启停股票锁仓配置。 | P1 | `stock_locks.manage` | NO | 需补 seed 权限点。 |
| `/admin/bd/applications/{application_id}/approve` | `backend/app/routers/admin_pages.py` | `bd_application_approve` | 通过 BD 申请。 | P1 | `bd.manage` | NO | 需补 seed 权限点；不要复用 `bd.view`。 |
| `/admin/bd/applications/{application_id}/reject` | `backend/app/routers/admin_pages.py` | `bd_application_reject` | 拒绝 BD 申请。 | P1 | `bd.manage` | NO | 需补 seed 权限点。 |
| `/admin/bd/accounts/{bd_user_id}/disable` | `backend/app/routers/admin_pages.py` | `bd_account_disable` | 停用 BD 账号。 | P1 | `bd.manage` | NO | 需补 seed 权限点。 |
| `/admin/bd/accounts/{bd_user_id}/enable` | `backend/app/routers/admin_pages.py` | `bd_account_enable` | 启用 BD 账号。 | P1 | `bd.manage` | NO | 需补 seed 权限点。 |
| `/admin/dividend-config`, `/admin/dividends/config` | `backend/app/routers/admin_pages.py` | `dividend_config_submit` | 更新分红全局配置。 | P1 | `dividends.manage` | NO | 需补 seed 权限点；不要复用 `dividend.view`。 |
| `/admin/dividend-config/rules/{level_id}`, `/admin/dividends/config/rules/{level_id}` | `backend/app/routers/admin_pages.py` | `dividend_config_rule_update` | 更新分红等级规则。 | P1 | `dividends.manage` | NO | 需补 seed 权限点。 |
| `/admin/dividend-config/rules/{level_id}/toggle`, `/admin/dividends/config/rules/{level_id}/toggle` | `backend/app/routers/admin_pages.py` | `dividend_config_rule_toggle` | 启停分红等级规则。 | P1 | `dividends.manage` | NO | 需补 seed 权限点。 |
| `/admin/dividend-pools/create`, `/admin/dividends/create` | `backend/app/routers/admin_pages.py` | `dividend_pool_create` | 创建分红池。 | P1 | `dividends.manage` | NO | 需补 seed 权限点；未发放前不直接转账。 |
| `/admin/dividend-pools/{pool_id}/calculate`, `/admin/dividends/{pool_id}/calculate` | `backend/app/routers/admin_pages.py` | `dividend_pool_calculate` | 计算分红池。 | P1 | `dividends.manage` | NO | 需补 seed 权限点；手动任务但不直接发放。 |
| `/admin/home-banners/new` | `backend/app/routers/admin_pages.py` | `home_banner_create_submit` | 新增首页 Banner。 | P1 | `banners.manage` | NO | seed 已有。 |
| `/admin/home-banners/{banner_id}/edit` | `backend/app/routers/admin_pages.py` | `home_banner_edit_submit` | 编辑首页 Banner。 | P1 | `banners.manage` | NO | seed 已有。 |
| `/admin/home-banners/{banner_id}/toggle-status` | `backend/app/routers/admin_pages.py` | `home_banner_toggle_status` | 上下架首页 Banner。 | P1 | `banners.manage` | NO | seed 已有。 |
| `/admin/home-banners/{banner_id}/delete` | `backend/app/routers/admin_pages.py` | `home_banner_delete_submit` | 删除首页 Banner。 | P1 | `banners.manage` | NO | seed 已有。 |
| `/admin/announcements/new` | `backend/app/routers/admin_pages.py` | `announcement_create_submit` | 新增公告。 | P1 | `announcements.manage` | NO | seed 已有。 |
| `/admin/announcements/{announcement_id}/edit` | `backend/app/routers/admin_pages.py` | `announcement_edit_submit` | 编辑公告。 | P1 | `announcements.manage` | NO | seed 已有。 |
| `/admin/announcements/{announcement_id}/toggle-status` | `backend/app/routers/admin_pages.py` | `announcement_toggle_status` | 发布/下架公告。 | P1 | `announcements.manage` | NO | seed 已有。 |
| `/admin/activities/new` | `backend/app/admin/activity_admin.py` | `activity_create_submit` | 新增活动。 | P1 | `banners.manage` 或 `activities.manage` | NO | 当前菜单将活动归入 `banners.manage`；若需细分需补 seed。 |
| `/admin/activities/{activity_id}/edit` | `backend/app/admin/activity_admin.py` | `activity_edit_submit` | 编辑活动。 | P1 | `banners.manage` 或 `activities.manage` | NO | 同上。 |
| `/admin/activities/{activity_id}/toggle-status` | `backend/app/admin/activity_admin.py` | `activity_toggle_status` | 上下架活动。 | P1 | `banners.manage` 或 `activities.manage` | NO | 同上。 |
| `/admin/activities/{activity_id}/delete` | `backend/app/admin/activity_admin.py` | `activity_delete_submit` | 删除活动。 | P1 | `banners.manage` 或 `activities.manage` | NO | 同上。 |
| `/admin/activity-banners/new` | `backend/app/admin/activity_admin.py` | `activity_banner_create_submit` | 新增活动 Banner。 | P1 | `banners.manage` | NO | seed 已有。 |
| `/admin/activity-banners/{banner_id}/edit` | `backend/app/admin/activity_admin.py` | `activity_banner_edit_submit` | 编辑活动 Banner。 | P1 | `banners.manage` | NO | seed 已有。 |
| `/admin/activity-banners/{banner_id}/toggle-enabled` | `backend/app/admin/activity_admin.py` | `activity_banner_toggle_enabled` | 启停活动 Banner。 | P1 | `banners.manage` | NO | seed 已有。 |
| `/admin/activity-banners/{banner_id}/delete` | `backend/app/admin/activity_admin.py` | `activity_banner_delete_submit` | 删除活动 Banner。 | P1 | `banners.manage` | NO | seed 已有。 |
| `/admin/kyc/{submission_id}/approve` | `backend/app/routers/kyc.py` | `approve_kyc_submission` | KYC 审核通过。 | P1 | `kyc_reviews.manage` | NO | 需补 seed 权限点；也可并入 `users.manage`，需产品确认。 |
| `/admin/kyc/{submission_id}/reject` | `backend/app/routers/kyc.py` | `reject_kyc_submission` | KYC 审核拒绝。 | P1 | `kyc_reviews.manage` | NO | 需补 seed 权限点。 |

## 5. P2 低风险 POST

| 路由路径 | 所在文件 | 函数名 | 当前动作说明 | 风险等级 | 建议权限码 | 第一批接入 | 备注 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `/admin/login` | `backend/app/routers/admin_pages.py` | `login_submit` | 后台管理员登录认证。 | P2 | N/A | NO | 登录入口不应做 RBAC POST 拦截；继续使用用户名密码认证。 |
| `/admin/site-settings` | `backend/app/routers/admin_pages.py` | `site_settings_submit` | 更新站点基础展示配置。 | P2 | `site_settings.manage` | NO | seed 已有；虽为写操作，但不直接影响资金或权限。 |

## 6. 暂不接入原因

本步只输出审计文档，不接入 POST 拦截，主要原因：

1. POST 操作覆盖资金、审核、配置、内容发布、用户状态等多个域，一次性接入容易误伤运营流程。
2. 当前 seed 权限点以查看和少量管理权限为主，高风险写操作需要补充更细的 `.manage` 权限点。
3. 部分 POST 是同一页面内的别名路径或历史路径，需要先统一权限归属，避免同一动作在不同 URL 下权限不一致。
4. 上传、活动、KYC、佣金、分红等操作是否拆分独立权限，需要产品和运营确认。
5. 第七步刚接入 GET 页面访问拦截，POST 拦截应分批灰度，方便定位问题。

## 7. 后续分批接入建议

第一批：只接 P0。

- 管理员管理：`admin_users.manage`
- 角色权限管理：`admin_roles.manage`
- 提现审核：`withdraw_reviews.manage`
- 平台调账：`platform_adjust.manage`
- 资产/链配置：`asset_configs.manage`
- 交易对配置：`trading_pairs.manage`
- 合约品种配置：`contract_symbols.manage`
- Dealer 风控：`dealer_risk.manage`
- 真实归集/Gas 发送：`collection_tasks.manage`、`gas_tasks.manage`
- 直接资金发放：`invite_commissions.manage`、`bd_commissions.manage`、`dividends.distribute`
- 股票锁仓强制释放：`stock_locks.manage`

第二批：接 P1 中的用户状态、KYC、内容发布、业务配置。

- 用户启停和提现锁：`users.manage` 或 `withdraw_controls.manage`
- KYC 审核：`kyc_reviews.manage`
- Banner/活动：`banners.manage` 或新增 `activities.manage`
- 公告：`announcements.manage`
- BD/邀请配置：`bd.manage`、`invite.manage`
- 分红配置和计算：`dividends.manage`
- 股票锁仓配置：`stock_locks.manage`

第三批：评估 P2。

- `/admin/login` 保持不接 RBAC POST 拦截。
- `/admin/site-settings` 可继续使用 `site_settings.manage`，但建议在 P0/P1 稳定后再接。
- `/admin/uploads/image` 建议先设计上下文权限，或补 `admin_uploads.manage` 后统一接入。
