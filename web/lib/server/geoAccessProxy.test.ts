import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readSource(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), 'utf8');
}

test('public user navigation is owned by the client auth guard instead of cross-origin cookies in the proxy', () => {
  const proxySource = readSource('lib/server/geoAccessProxy.ts');
  const userLayoutSource = readSource('app/user/layout.tsx');
  const loginFormSource = readSource('components/auth/LoginForm.tsx');
  const loginClientSource = readSource('app/login/LoginClient.tsx');

  expect(proxySource).not.toContain("pathname.startsWith('/user')");
  expect(proxySource).not.toContain("req.cookies.get('access_token')");
  expect(proxySource).not.toContain("req.cookies.get('refresh_token')");
  expect(userLayoutSource).toContain('<AuthGuard requireLogin>');
  expect(loginFormSource).toContain('router.replace(getRedirectTarget())');
  expect(loginClientSource).toContain('if (isLoggedIn) router.replace(redirectTarget)');
});
