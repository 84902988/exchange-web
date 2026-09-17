import configuration from '@/config/branding.json';

export const applicationName =
  process.env.NEXT_PUBLIC_APP_NAME?.trim() || configuration.displayName || 'Exchange';

export function withBrandName(value: string): string {
  return value.replace(/\{\{brandName\}\}/g, () => applicationName);
}

export const legacyFavoritesStorageKeys: readonly string[] = configuration.legacyFavoritesStorageKeys;
