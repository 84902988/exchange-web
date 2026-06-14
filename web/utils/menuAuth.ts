import type { MenuItem } from '@/config/menuConfig';
import type { MenuAuth } from '@/lib/auth/permission';

/**
 * 菜单显示权限判断
 * 兼容 MenuItem 中不存在 auth 字段的情况
 */
export function canShowMenu(
  item: { auth?: MenuAuth },
  isLoggedIn: boolean
): boolean {
  const auth = item.auth;

  if (!auth || auth === 'both') return true;
  if (auth === 'user') return isLoggedIn;
  if (auth === 'guest') return !isLoggedIn;
  if (auth === 'admin') return isLoggedIn; // 前端菜单一般不细分 admin

  return true;
}

/**
 * 如果你某些地方一定传的是 MenuItem
 * 可以用这个包装函数（可选）
 */
export function canShowMenuItem(
  item: MenuItem,
  isLoggedIn: boolean
): boolean {
  return canShowMenu(item as any, isLoggedIn);
}
