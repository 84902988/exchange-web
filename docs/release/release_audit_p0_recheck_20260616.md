# 上线前 P0 修复复检报告

生成日期：2026-06-16

复检范围：仅复检内部审计报告中的 P0-1 与 P0-2。  
执行边界：未处理 P1/P2；未生成甲方正式报告；未提交 git commit；未启动浏览器、uvicorn 或 dev server；未执行 TestClient/httpx 冒烟；未连接外部服务；未执行真实资金动作；未修改数据库数据。

## 1. P0 修复复检结论

P0 代码层静态复检通过；因本轮不连接数据库，VIP / Dealer 风控真实保存回显仍需在测试库或 staging 环境验证。

当前复检结果：

- P0-1：VIP / Dealer 风控 `_ok_stub` 修复静态复检通过。
- P0-2：Activity / Activity Banner 后台 POST RBAC 静态复检通过。
- 测试库真实保存回显验证：未执行，原因是本轮明确限制不连接数据库、不修改数据库数据。

## 2. P0-1 复检结果

复检对象：

- `admin_toggle_vip_fee_level_enabled`
- `admin_update_vip_fee_level_rule`
- `admin_save_dealer_risk_limit`
- `admin_toggle_dealer_risk_enabled`
- `admin_toggle_dealer_risk_status`

涉及文件：

- `backend/app/services/admin_queries.py`
- `backend/app/routers/admin_pages.py`

### 2.1 `_ok_stub` 绑定复检

静态扫描结果显示，5 个目标函数均存在唯一真实函数定义，且不存在 `_ok_stub` 绑定。

关键行号：

- `backend/app/services/admin_queries.py:11905`：`admin_toggle_vip_fee_level_enabled`
- `backend/app/services/admin_queries.py:11939`：`admin_update_vip_fee_level_rule`
- `backend/app/services/admin_queries.py:12033`：`admin_save_dealer_risk_limit`
- `backend/app/services/admin_queries.py:12168`：`admin_toggle_dealer_risk_enabled`
- `backend/app/services/admin_queries.py:12200`：`admin_toggle_dealer_risk_status`

结论：通过。

### 2.2 真实 SQLAlchemy 写入逻辑复检

静态确认目标函数中存在真实 SQLAlchemy 写入逻辑：

- `backend/app/services/admin_queries.py:11919-11929`：VIP 等级启停执行 `UPDATE vip_fee_levels`，并检查 `rowcount`。
- `backend/app/services/admin_queries.py:11957-11974`：VIP 费率规则执行 `UPDATE vip_fee_levels`，并检查 `rowcount`。
- `backend/app/services/admin_queries.py:11982-11996`：VIP 条件行执行 `UPDATE vip_fee_level_conditions` 或 `INSERT INTO vip_fee_level_conditions`。
- `backend/app/services/admin_queries.py:12099-12126`：Dealer 风控保存执行 `UPDATE dealer_risk_limits`，并检查 `rowcount`。
- `backend/app/services/admin_queries.py:12130-12153`：Dealer 风控新增执行 `INSERT INTO dealer_risk_limits`，并检查 `rowcount`。
- `backend/app/services/admin_queries.py:12180-12190`：Dealer 风控启停执行 `UPDATE dealer_risk_limits`，并检查 `rowcount`。
- `backend/app/services/admin_queries.py:12213-12223`：Dealer 风控状态切换执行 `UPDATE dealer_risk_limits`，并检查 `rowcount`。

结论：通过。

### 2.3 输入校验、异常返回、存在性检查复检

静态确认存在输入校验、异常返回、rowcount 或对象存在性检查：

- `backend/app/services/admin_queries.py:11915`：VIP 等级不存在时返回错误。
- `backend/app/services/admin_queries.py:11929-11932`：VIP 等级启停 `rowcount` 检查与 SQLAlchemy 异常回滚。
- `backend/app/services/admin_queries.py:11949-11953`：VIP 规则更新前查询等级对象并处理不存在。
- `backend/app/services/admin_queries.py:11974`：VIP 规则更新 `rowcount` 检查。
- `backend/app/services/admin_queries.py:12009-12010`：VIP 规则更新 SQLAlchemy 异常回滚。
- `backend/app/services/admin_queries.py:12038-12064`：Dealer 风控保存校验 symbol、status、remark。
- `backend/app/services/admin_queries.py:12072-12084`：Dealer 风控保存重复 symbol 检查。
- `backend/app/services/admin_queries.py:12093-12097`：Dealer 风控更新前检查对象存在。
- `backend/app/services/admin_queries.py:12126`：Dealer 风控更新 `rowcount` 检查。
- `backend/app/services/admin_queries.py:12153`：Dealer 风控新增 `rowcount` 检查。
- `backend/app/services/admin_queries.py:12156-12157`：Dealer 风控保存 IntegrityError/SQLAlchemyError 异常回滚。
- `backend/app/services/admin_queries.py:12177`：Dealer 风控启停对象不存在时返回错误。
- `backend/app/services/admin_queries.py:12190-12193`：Dealer 风控启停 `rowcount` 检查与异常回滚。
- `backend/app/services/admin_queries.py:12209`：Dealer 风控状态切换对象不存在时返回错误。
- `backend/app/services/admin_queries.py:12223-12226`：Dealer 风控状态切换 `rowcount` 检查与异常回滚。

结论：通过。

### 2.4 Dealer 路由 commit 与真实成功提示复检

静态确认 Dealer 路由写入成功后存在真实 commit，且保存成功提示来自 service 返回结果：

- `backend/app/routers/admin_pages.py:12758`：保存路由调用 `admin_save_dealer_risk_limit`。
- `backend/app/routers/admin_pages.py:12775`：保存成功后执行 `db.commit()`。
- `backend/app/routers/admin_pages.py:12776`：保存成功提示使用 `result.get("message")`。
- `backend/app/routers/admin_pages.py:12797`：启停路由调用 `admin_toggle_dealer_risk_enabled`。
- `backend/app/routers/admin_pages.py:12799`：启停成功后执行 `db.commit()`。
- `backend/app/routers/admin_pages.py:12821`：状态切换路由调用 `admin_toggle_dealer_risk_status`。
- `backend/app/routers/admin_pages.py:12823`：状态切换成功后执行 `db.commit()`。

结论：通过。

## 3. P0-2 复检结果

复检对象：

- `POST /activities/new`
- `POST /activities/{activity_id}/edit`
- `POST /activities/{activity_id}/toggle-status`
- `POST /activities/{activity_id}/delete`
- `POST /activity-banners/new`
- `POST /activity-banners/{banner_id}/edit`
- `POST /activity-banners/{banner_id}/toggle-enabled`
- `POST /activity-banners/{banner_id}/delete`

涉及文件：

- `backend/app/admin/activity_admin.py`

### 3.1 登录校验与 RBAC 权限点复检

静态确认 8 个目标 POST 均保留 `require_admin(request)`，且均接入 `require_admin_post_permission(request, db, "site_content.manage")`。

关键行号：

- `POST /activities/new`
  - `backend/app/admin/activity_admin.py:249`：`require_admin(request)`
  - `backend/app/admin/activity_admin.py:252`：`require_admin_post_permission(..., "site_content.manage")`
- `POST /activities/{activity_id}/edit`
  - `backend/app/admin/activity_admin.py:394`：`require_admin(request)`
  - `backend/app/admin/activity_admin.py:397`：`require_admin_post_permission(..., "site_content.manage")`
- `POST /activities/{activity_id}/toggle-status`
  - `backend/app/admin/activity_admin.py:478`：`require_admin(request)`
  - `backend/app/admin/activity_admin.py:481`：`require_admin_post_permission(..., "site_content.manage")`
- `POST /activities/{activity_id}/delete`
  - `backend/app/admin/activity_admin.py:498`：`require_admin(request)`
  - `backend/app/admin/activity_admin.py:501`：`require_admin_post_permission(..., "site_content.manage")`
- `POST /activity-banners/new`
  - `backend/app/admin/activity_admin.py:596`：`require_admin(request)`
  - `backend/app/admin/activity_admin.py:599`：`require_admin_post_permission(..., "site_content.manage")`
- `POST /activity-banners/{banner_id}/edit`
  - `backend/app/admin/activity_admin.py:692`：`require_admin(request)`
  - `backend/app/admin/activity_admin.py:695`：`require_admin_post_permission(..., "site_content.manage")`
- `POST /activity-banners/{banner_id}/toggle-enabled`
  - `backend/app/admin/activity_admin.py:751`：`require_admin(request)`
  - `backend/app/admin/activity_admin.py:754`：`require_admin_post_permission(..., "site_content.manage")`
- `POST /activity-banners/{banner_id}/delete`
  - `backend/app/admin/activity_admin.py:771`：`require_admin(request)`
  - `backend/app/admin/activity_admin.py:774`：`require_admin_post_permission(..., "site_content.manage")`

结论：通过。

### 3.2 只登录不鉴权路径复检

AST 静态扫描覆盖 8 个目标 POST，未发现 Activity / Activity Banner 目标 POST 仅保留 `require_admin(request)` 而缺少 RBAC 权限校验的情况。

结论：通过。

## 4. 执行命令与结果

### 4.1 Python 编译

命令：

```powershell
python -m py_compile backend/app/services/admin_queries.py backend/app/routers/admin_pages.py backend/app/admin/activity_admin.py
```

结果：通过，退出码 0。

### 4.2 `_ok_stub` 绑定静态扫描

命令：

```powershell
@'
import re
from pathlib import Path
source = Path('backend/app/services/admin_queries.py').read_text(encoding='utf-8')
targets = [
    'admin_toggle_vip_fee_level_enabled',
    'admin_update_vip_fee_level_rule',
    'admin_save_dealer_risk_limit',
    'admin_toggle_dealer_risk_enabled',
    'admin_toggle_dealer_risk_status',
]
for name in targets:
    defs = len(re.findall(rf'^def\s+{name}\s*\(', source, re.M))
    stub = bool(re.search(rf'^{name}\s*=\s*_ok_stub\b', source, re.M))
    print(f'{name}: definitions={defs} ok_stub_binding={stub}')
    if defs != 1 or stub:
        raise SystemExit(f'STUB_SCAN_FAILED: {name}')
print('VIP_DEALER_STUB_SCAN_OK')
'@ | python -
```

结果：通过，退出码 0。输出摘要：

```text
admin_toggle_vip_fee_level_enabled: definitions=1 ok_stub_binding=False
admin_update_vip_fee_level_rule: definitions=1 ok_stub_binding=False
admin_save_dealer_risk_limit: definitions=1 ok_stub_binding=False
admin_toggle_dealer_risk_enabled: definitions=1 ok_stub_binding=False
admin_toggle_dealer_risk_status: definitions=1 ok_stub_binding=False
VIP_DEALER_STUB_SCAN_OK
```

### 4.3 Activity POST RBAC 静态扫描

命令：

```powershell
@'
import ast
from pathlib import Path
path = Path('backend/app/admin/activity_admin.py')
source = path.read_text(encoding='utf-8')
module = ast.parse(source)
targets = {
    '/activities/new',
    '/activities/{activity_id}/edit',
    '/activities/{activity_id}/toggle-status',
    '/activities/{activity_id}/delete',
    '/activity-banners/new',
    '/activity-banners/{banner_id}/edit',
    '/activity-banners/{banner_id}/toggle-enabled',
    '/activity-banners/{banner_id}/delete',
}
found = {}
for node in module.body:
    if not isinstance(node, ast.FunctionDef):
        continue
    for deco in node.decorator_list:
        if not (isinstance(deco, ast.Call) and isinstance(deco.func, ast.Attribute) and deco.func.attr == 'post'):
            continue
        if not deco.args or not isinstance(deco.args[0], ast.Constant):
            continue
        route = deco.args[0].value
        if route in targets:
            segment = '\n'.join(source.splitlines()[node.lineno - 1: node.end_lineno])
            found[route] = (
                node.name,
                node.lineno,
                'require_admin(request)' in segment,
                'require_admin_post_permission(request, db, "site_content.manage")' in segment,
            )
missing = targets - found.keys()
for route in sorted(found):
    name, lineno, has_admin, has_rbac = found[route]
    print(f'{route}: {name} line={lineno} require_admin={has_admin} site_content.manage={has_rbac}')
if missing:
    raise SystemExit(f'MISSING_ROUTES: {sorted(missing)}')
if any(not item[3] for item in found.values()):
    raise SystemExit('RBAC_SCAN_FAILED')
print('ACTIVITY_RBAC_SCAN_OK')
'@ | python -
```

结果：通过，退出码 0。输出摘要：

```text
/activities/new: activity_create_submit line=205 require_admin=True site_content.manage=True
/activities/{activity_id}/delete: activity_delete_submit line=497 require_admin=True site_content.manage=True
/activities/{activity_id}/edit: activity_edit_submit line=349 require_admin=True site_content.manage=True
/activities/{activity_id}/toggle-status: activity_toggle_status line=472 require_admin=True site_content.manage=True
/activity-banners/new: activity_banner_create_submit line=575 require_admin=True site_content.manage=True
/activity-banners/{banner_id}/delete: activity_banner_delete_submit line=770 require_admin=True site_content.manage=True
/activity-banners/{banner_id}/edit: activity_banner_edit_submit line=670 require_admin=True site_content.manage=True
/activity-banners/{banner_id}/toggle-enabled: activity_banner_toggle_enabled line=745 require_admin=True site_content.manage=True
ACTIVITY_RBAC_SCAN_OK
```

### 4.4 Git diff 空白检查

命令：

```powershell
git diff --check -- backend/app/services/admin_queries.py backend/app/routers/admin_pages.py backend/app/admin/activity_admin.py
```

结果：通过，退出码 0。  
备注：命令输出 Git 工作区行尾提示 `LF will be replaced by CRLF`，未发现 whitespace error。

## 5. 当前 P0 状态

- 代码静态复检：通过。
- 测试库真实保存回显验证：未执行。

未执行真实保存回显验证原因：本轮复检限制明确要求不连接数据库、不修改数据库数据。因此 VIP / Dealer 风控真实保存回显仍需在测试库或 staging 环境验证。

## 6. 后续建议

1. 在测试库或 staging 环境用具备对应权限的后台账号验证 VIP 费率等级启停、VIP 规则更新、Dealer 风控新增/编辑/启停/状态切换的真实保存与页面回显。
2. 在测试库或 staging 环境验证无权限管理员访问 8 个 Activity / Activity Banner POST 时触发后台一致的无权限处理。
3. P0 静态复检通过后，再进入 P1/P2 风险项处理或生成甲方正式报告流程。
