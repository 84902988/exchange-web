// 新增修改-2026.1.21-权限管理
// lib/auth/permission.ts

import type { MenuItem } from '@/config/menuConfig';
import { apiPermissionMap } from '@/config/apiPermission';

/* ======================
   菜单权限类型（本地定义，避免依赖 menuConfig 导出）
====================== */

export type MenuAuth = 'both' | 'guest' | 'user' | 'admin';

/* ======================
   API 权限
====================== */

export const API_RULES = [
  { prefix: '/auth', access: 'public' },
  { prefix: '/announcement', access: 'public' },
  { prefix: '/public', access: 'public' },

  { prefix: '/user', access: 'login' },
  { prefix: '/assets', access: 'login' },
  { prefix: '/finance', access: 'login' },
  { prefix: '/spot', access: 'login' },
  { prefix: '/futures', access: 'login' },
  { prefix: '/kyc', access: 'login' },
  { prefix: '/password', access: 'login' },
  { prefix: '/identity', access: 'login' },

  { prefix: '/admin', access: 'admin' },
  { prefix: '/system', access: 'admin' },
] as const;

export function canAccessApi(
  path: string,
  isLoggedIn: boolean,
  role?: 'admin'
): boolean {
  const cleanPath = path.split('?')[0];

  const rule = API_RULES.find(
    r => cleanPath === r.prefix || cleanPath.startsWith(r.prefix + '/')
  );

  if (!rule) return false;

  switch (rule.access) {
    case 'public':
      return true;
    case 'login':
      return isLoggedIn;
    case 'admin':
      return isLoggedIn && role === 'admin';
    default:
      return false;
  }
}

/* ======================
   菜单 / 页面权限
====================== */

export function canAccess(
  auth: MenuAuth | undefined,
  isLoggedIn: boolean,
  role?: string
): boolean {
  if (!auth || auth === 'both') return true;
  if (auth === 'guest') return !isLoggedIn;
  if (auth === 'user') return isLoggedIn;
  if (auth === 'admin') return isLoggedIn && role === 'admin';
  return false;
}

export function canAccessMenuItem(
  item: MenuItem,
  isLoggedIn: boolean,
  role?: string
): boolean {
  // 兼容 MenuItem 中 auth 不存在或未声明的情况
  const auth = (item as MenuItem & { auth?: MenuAuth }).auth;
  return canAccess(auth, isLoggedIn, role);
}

/* ======================
   API 权限映射（可选）
====================== */

export function canAccessApiByKey(
  key: keyof typeof apiPermissionMap,
  isLoggedIn: boolean,
  role?: string
): boolean {
  const auth = apiPermissionMap[key] as MenuAuth | undefined;
  return canAccess(auth, isLoggedIn, role);
}
