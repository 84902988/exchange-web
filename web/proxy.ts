import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

const ACCESS_COOKIE = 'access_token';
const REFRESH_COOKIE = 'refresh_token';
const REGION_RESTRICTED_PATH = '/region-restricted';
const REGION_RESTRICTED_CODE = 'REGION_RESTRICTED';
const REGION_RESTRICTED_MESSAGE = 'Service is not available in your region.';

function isGeoRestrictionEnabled() {
  const raw = process.env.GEO_RESTRICTION_ENABLED;
  if (raw === undefined) return true;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

function restrictedCountries() {
  return (process.env.GEO_RESTRICTED_COUNTRIES || 'CN')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter(Boolean);
}

function countryHeaderName() {
  return process.env.GEO_RESTRICTION_HEADER || 'CF-IPCountry';
}

function isStaticPath(pathname: string) {
  return (
    pathname.startsWith('/_next') ||
    pathname.startsWith('/favicon') ||
    pathname.startsWith('/assets') ||
    pathname.startsWith('/icons') ||
    pathname.startsWith('/images') ||
    pathname === '/robots.txt'
  );
}

export function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isStaticPath(pathname) || pathname === REGION_RESTRICTED_PATH) {
    return NextResponse.next();
  }

  if (isGeoRestrictionEnabled()) {
    const countryCode = (req.headers.get(countryHeaderName()) || '').trim().toUpperCase();
    if (countryCode && restrictedCountries().includes(countryCode)) {
      if (pathname.startsWith('/api')) {
        return NextResponse.json(
          {
            code: REGION_RESTRICTED_CODE,
            message: REGION_RESTRICTED_MESSAGE,
          },
          { status: 403 },
        );
      }

      const url = req.nextUrl.clone();
      url.pathname = REGION_RESTRICTED_PATH;
      url.search = '';
      return NextResponse.redirect(url, 302);
    }
  }

  if (pathname.startsWith('/login') || pathname.startsWith('/api')) {
    return NextResponse.next();
  }

  if (pathname.startsWith('/user')) {
    const access = req.cookies.get(ACCESS_COOKIE)?.value;
    const refresh = req.cookies.get(REFRESH_COOKIE)?.value;

    if (!access && !refresh) {
      const url = req.nextUrl.clone();
      url.pathname = '/login';
      url.searchParams.set('next', pathname);
      return NextResponse.redirect(url);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ['/:path*'],
};
