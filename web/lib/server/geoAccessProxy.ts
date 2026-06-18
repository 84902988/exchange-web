import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';
const RESTRICTED_PATH = '/restricted';
const LEGACY_RESTRICTED_PATH = '/region-restricted';
const BACKEND_ORIGIN =
  process.env.NEXT_PUBLIC_BACKEND_ORIGIN ||
  process.env.NEXT_PUBLIC_API_BASE_URL ||
  'http://127.0.0.1:8000';
const TEST_LOCAL_GEO_ACCESS = process.env.WEB_GEO_ACCESS_TEST_LOCAL === 'true';
const CHECK_TIMEOUT_MS = Number(process.env.WEB_GEO_ACCESS_CHECK_TIMEOUT_MS || 8000);

const STATIC_FILE_EXTENSIONS =
  /\.(?:avif|bmp|css|cur|gif|ico|jpeg|jpg|js|json|map|mjs|otf|png|svg|ttf|txt|webmanifest|woff|woff2|xml)$/i;

function normalizeHostname(host: string) {
  const normalized = host.trim().toLowerCase();
  if (normalized.startsWith('[')) {
    return normalized.slice(1, normalized.indexOf(']'));
  }
  return normalized.split(':', 1)[0];
}

function isLocalHost(hostname: string) {
  const normalized = normalizeHostname(hostname);
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

function requestHostname(req: NextRequest) {
  return req.headers.get('host') || req.nextUrl.hostname;
}

function shouldBypassLocalHost(req: NextRequest) {
  if (!isLocalHost(requestHostname(req))) return false;
  return !(TEST_LOCAL_GEO_ACCESS && req.headers.has('cf-ipcountry'));
}

function isStaticOrSystemPath(pathname: string) {
  return (
    pathname.startsWith('/_next/') ||
    pathname.startsWith('/assets/') ||
    pathname.startsWith('/icons/') ||
    pathname.startsWith('/images/') ||
    pathname.startsWith('/static/') ||
    pathname.startsWith('/health') ||
    pathname === '/favicon.ico' ||
    pathname === '/robots.txt' ||
    pathname === '/sitemap.xml' ||
    STATIC_FILE_EXTENSIONS.test(pathname)
  );
}

function shouldCheckGeoAccess(req: NextRequest): { check: boolean; reason?: string } {
  const { pathname } = req.nextUrl;
  const method = req.method.toUpperCase();

  if (method !== 'GET' && method !== 'HEAD') return { check: false, reason: 'method' };
  if (shouldBypassLocalHost(req)) return { check: false, reason: 'localhost' };
  if (pathname === RESTRICTED_PATH || pathname === LEGACY_RESTRICTED_PATH) {
    return { check: false, reason: 'restricted-page' };
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) return { check: false, reason: 'api' };
  if (pathname === '/admin' || pathname.startsWith('/admin/')) return { check: false, reason: 'admin' };
  if (isStaticOrSystemPath(pathname)) return { check: false, reason: 'static-or-system' };
  return { check: true };
}

function firstForwardedIp(value: string | null) {
  return (value || '').split(',', 1)[0]?.trim() || '';
}

function getOriginalIp(req: NextRequest) {
  const cfIp = req.headers.get('cf-connecting-ip')?.trim();
  if (cfIp) return cfIp;
  const forwardedFor = firstForwardedIp(req.headers.get('x-forwarded-for'));
  if (forwardedFor) return forwardedFor;
  const realIp = req.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp;
  return '';
}

function appendIfPresent(headers: Headers, name: string, value: string | null | undefined) {
  const normalized = (value || '').trim();
  if (normalized) headers.set(name, normalized);
}

async function checkGeoAccess(req: NextRequest) {
  const headers = new Headers();
  const originalIp = getOriginalIp(req);
  const forwardedFor = req.headers.get('x-forwarded-for')?.trim();

  appendIfPresent(headers, 'accept', 'application/json');
  appendIfPresent(headers, 'user-agent', req.headers.get('user-agent'));
  appendIfPresent(headers, 'cf-ipcountry', req.headers.get('cf-ipcountry'));
  appendIfPresent(headers, 'cf-connecting-ip', req.headers.get('cf-connecting-ip') || originalIp);
  appendIfPresent(headers, 'x-real-ip', req.headers.get('x-real-ip') || originalIp);
  appendIfPresent(headers, 'x-forwarded-for', forwardedFor || originalIp);
  appendIfPresent(headers, 'x-forwarded-host', req.headers.get('host'));
  appendIfPresent(headers, 'x-forwarded-proto', req.nextUrl.protocol.replace(':', ''));
  appendIfPresent(headers, 'x-geo-access-path', `${req.nextUrl.pathname}${req.nextUrl.search}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CHECK_TIMEOUT_MS);

  try {
    const response = await fetch(new URL('/geo-access/check', BACKEND_ORIGIN), {
      method: 'GET',
      headers,
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return { allowed: true, checkStatus: 'error' };
    return {
      ...((await response.json()) as { allowed?: boolean }),
      checkStatus: 'called',
    };
  } catch {
    return { allowed: true, checkStatus: 'error' };
  } finally {
    clearTimeout(timeout);
  }
}

function withGeoDebugHeaders(
  response: NextResponse,
  checkStatus: 'allowed' | 'blocked' | 'called' | 'error' | 'skipped',
  skipReason?: string,
) {
  response.headers.set('x-geo-middleware', 'hit');
  response.headers.set('x-geo-check', checkStatus);
  if (skipReason) response.headers.set('x-geo-skip-reason', skipReason);
  return response;
}

export async function handleGeoAccessProxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const geoCheck = shouldCheckGeoAccess(req);
  let checkStatus: 'allowed' | 'blocked' | 'called' | 'error' | 'skipped' = 'skipped';
  let skipReason = geoCheck.reason;

  if (geoCheck.check) {
    const result = await checkGeoAccess(req);
    if (result.allowed === false) {
      const url = req.nextUrl.clone();
      url.pathname = RESTRICTED_PATH;
      url.search = '';
      return withGeoDebugHeaders(NextResponse.redirect(url, 302), 'blocked');
    }

    checkStatus = result.checkStatus === 'error' ? 'error' : 'allowed';
    skipReason = undefined;
  }

  if (pathname.startsWith('/login') || pathname.startsWith('/api')) {
    return withGeoDebugHeaders(NextResponse.next(), checkStatus, skipReason);
  }

  if (pathname.startsWith('/user')) {
    const access = req.cookies.get(ACCESS_COOKIE)?.value;
    const refresh = req.cookies.get(REFRESH_COOKIE)?.value;

    if (!access && !refresh) {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      url.searchParams.set('next', pathname);
      return withGeoDebugHeaders(NextResponse.redirect(url), checkStatus, skipReason || 'auth');
    }
  }

  return withGeoDebugHeaders(NextResponse.next(), checkStatus, skipReason);
}
