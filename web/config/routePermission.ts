// config/routePermission.ts
export type RouteAuth = 'guest' | 'user' | 'admin';

export const routePermission: Record<string, RouteAuth> = {
  '/login': 'guest',
  '/register': 'guest',

  '/user': 'user',
  '/asset': 'user',

  '/admin': 'admin',
  '/admin/users': 'admin',
};
