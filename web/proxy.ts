import { handleGeoAccessProxy } from './lib/server/geoAccessProxy';
import type { NextRequest } from 'next/server';

export async function proxy(request: NextRequest) {
  return handleGeoAccessProxy(request);
}

export const config = {
  matcher: [
    '/((?!api|_next/static|_next/image|favicon.ico|sitemap.xml|robots.txt|restricted|region-restricted).*)',
  ],
};
