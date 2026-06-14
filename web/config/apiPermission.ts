// config/apiPermission.ts
export type ApiAuth = 'guest' | 'user' | 'admin';

export const apiPermissionMap: Record<string, ApiAuth> = {
  // ===== 资产 =====
  '/asset/balance': 'user',
  '/asset/transfer': 'user',

  // ===== 用户 =====
  '/user/profile': 'user',
  '/user/security': 'user',

  // ===== 公共 =====
  '/notice/list': 'guest',
};
