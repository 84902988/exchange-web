export const DEFAULT_SITE_LOGO_URL = '/icons/royal-exchange-logo-256.png';

const LEGACY_SITE_LOGO_URLS = new Set([
  '/icons/logo-1.svg',
]);

export function resolveSiteLogoUrl(logoUrl?: string | null): string {
  const normalized = String(logoUrl || '').trim();
  if (!normalized || LEGACY_SITE_LOGO_URLS.has(normalized)) {
    return DEFAULT_SITE_LOGO_URL;
  }
  return normalized;
}
