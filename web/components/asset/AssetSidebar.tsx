'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { useLocaleContext } from '@/contexts/LocaleContext';

const groups = [
  {
    key: 'asset',
    labelKey: 'assetManagement',
    items: [
      { href: '/asset', labelKey: 'assetOverview' },
      { href: '/asset/deposit', labelKey: 'assetDepositDeposit' },
      { href: '/asset/withdraw', labelKey: 'withdraw' },
      { href: '/asset/history', labelKey: 'balanceLogs' },
      { href: '/asset/rcb-locks', labelKey: 'rcbLockRecords' },
      { href: '/asset/stock-token-locks', labelKey: 'stockTokenLocksTitle' },
      { href: '/asset/stock-token-converts', labelKey: 'stockTokenConvertHistory' },
    ],
  },
  {
    key: 'account',
    labelKey: 'accountInformation',
    items: [
      { href: '/asset/spot', labelKey: 'spotAccount' },
      { href: '/asset/contract', labelKey: 'contractAccount' },
    ],
  },
  {
    key: 'orders',
    labelKey: 'orderInformation',
    items: [
      { href: '/asset/orders/spot', labelKey: 'spotOrders' },
      { href: '/asset/orders/contract', labelKey: 'contractOrders' },
      { href: '/asset/orders/history', labelKey: 'historyOrders' },
    ],
  },
  {
    key: 'export',
    labelKey: 'dataExport',
    items: [
      { href: '/asset/export/trades', labelKey: 'tradeExport' },
      { href: '/asset/export/orders', labelKey: 'orderExport' },
      { href: '/asset/export/finance', labelKey: 'financeExport' },
    ],
  },
];

const visibleGroups = groups
  .filter((group) => group.key !== 'export')
  .map((group) => ({
    ...group,
    items: group.items.filter((item) => item.href !== '/asset/orders/history'),
  }));

const defaultOpen = visibleGroups.reduce<Record<string, boolean>>((acc, group) => {
  acc[group.key] = true;
  return acc;
}, {});

function isActivePath(pathname: string, href: string) {
  if (href === '/asset') return pathname === href;
  return pathname === href || pathname.startsWith(`${href}/`);
}

export default function AssetSidebar({
  isCollapsed,
  onToggle,
}: {
  isCollapsed: boolean;
  onToggle: () => void;
}) {
  const pathname = usePathname();
  const { t } = useLocaleContext();
  const [openGroups, setOpenGroups] = useState(defaultOpen);

  return (
    <aside
      className={`w-full shrink-0 p-5 transition-all duration-300 ${
        isCollapsed ? 'lg:w-16' : 'lg:w-80'
      } lg:sticky lg:top-0 lg:h-full border-r border-white/10`}
    >
      <div className="mb-6 flex items-center justify-between">
        {!isCollapsed ? (
          <div className="text-sm text-white/70">
            {t('assetSidebarTagline', 'asset')}
          </div>
        ) : null}

        <button
          className="flex h-7 w-7 items-center justify-center rounded hover:bg-white/10"
          onClick={onToggle}
          aria-label={isCollapsed ? t('expandSidebar', 'asset') : t('collapseSidebar', 'asset')}
        >
          <svg
            className={`h-4 w-4 text-white/70 transition-transform duration-300 ${
              isCollapsed ? 'rotate-180' : ''
            }`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {visibleGroups.map((group) => {
        const isOpen = openGroups[group.key];
        return (
          <div key={group.key} className="mb-6">
            <button
              type="button"
              className={`mb-4 flex w-full items-center text-sm font-semibold uppercase tracking-wider text-white/90 ${
                isCollapsed ? 'justify-center' : 'justify-between'
              }`}
              onClick={() => setOpenGroups((state) => ({ ...state, [group.key]: !state[group.key] }))}
            >
              {!isCollapsed ? (
                <span>{t(group.labelKey, 'asset')}</span>
              ) : (
                <span className="h-1.5 w-1.5 rounded-full bg-white/45" />
              )}
              {!isCollapsed ? (
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded transition-transform ${
                    isOpen ? 'rotate-180' : ''
                  }`}
                >
                  <svg className="h-3 w-3 text-white/70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                  </svg>
                </span>
              ) : null}
            </button>

            {isOpen && !isCollapsed ? (
              <ul className="space-y-3">
                {group.items.map((item) => {
                  const active = isActivePath(pathname, item.href);
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className={[
                          'block rounded px-3 py-2 text-sm transition-colors',
                          active
                            ? 'bg-[#f0b90b]/15 text-[#f0b90b]'
                            : 'text-white/70 hover:bg-white/10 hover:text-white',
                        ].join(' ')}
                      >
                        {t(item.labelKey, 'asset')}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </div>
        );
      })}
    </aside>
  );
}
