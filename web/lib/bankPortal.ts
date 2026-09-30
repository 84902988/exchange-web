import type { MenuItem } from '@/config/menuConfig';

export function withBankPortal(items: MenuItem[], value?: string | null): MenuItem[] {
  const unconfigured = [...items, {
    labelKey: 'navBankPortal', href: '/bank',
  }];
  if (!value || value.length > 500 || /[\s\u0000-\u001f\u007f]/.test(value)) return unconfigured;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return unconfigured;
    return [...items, { labelKey: 'navBankPortal', href: value, isExternal: true }];
  } catch {
    return unconfigured;
  }
}
