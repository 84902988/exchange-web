import { withBankPortal } from './bankPortal';
import type { MenuItem } from '@/config/menuConfig';

const items: MenuItem[] = [{ labelKey: 'navHelpCenter', href: '/help' }];

test.each([null, undefined, '', 'http://bank.example.com', 'javascript:alert(1)', '//bank.example.com', 'https://user:pass@bank.example.com', 'https://bank.example.com/\nportal'])('keeps an unconfigured or invalid portal visible as a coming-soon page link: %s', (value) => {
  expect(withBankPortal(items, value)).toEqual([
    ...items,
    { labelKey: 'navBankPortal', href: '/bank' },
  ]);
});

test('appends the configured external portal and preserves the public menu', () => {
  expect(withBankPortal(items, 'https://bank.example.com/portal')).toEqual([
    ...items,
    { labelKey: 'navBankPortal', href: 'https://bank.example.com/portal', isExternal: true },
  ]);
  expect(items).toHaveLength(1);
});
