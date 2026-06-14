'use client';

import { useState } from 'react';
import { usePathname } from 'next/navigation';

import { useLocaleContext } from '@/contexts/LocaleContext';

type UserSidebarProps = {
  isCollapsed: boolean;
  onToggle: () => void;
};

type SidebarGroup = {
  key: 'profile' | 'security' | 'notifications' | 'help';
  titleKey: string;
  items: Array<{ href: string; labelKey: string }>;
};

const SIDEBAR_GROUPS: SidebarGroup[] = [
  {
    key: 'profile',
    titleKey: 'currentUserManagement',
    items: [
      { href: '/user', labelKey: 'userOverview' },
      { href: '/user/profile', labelKey: 'personalProfile' },
      { href: '/user/kyc', labelKey: 'kycVerification' },
      { href: '/user/dividends', labelKey: 'myDividends' },
      { href: '/user/bd-team', labelKey: 'bdTeam' },
      { href: '/user/security-questions', labelKey: 'securityQuestions' },
    ],
  },
  {
    key: 'security',
    titleKey: 'securitySettings',
    items: [
      { href: '/user/security/password', labelKey: 'passwordSettings' },
      { href: '/user/security/login-logs', labelKey: 'accessLogs' },
      { href: '/user/security/devices', labelKey: 'deviceManagement' },
    ],
  },
  {
    key: 'notifications',
    titleKey: 'notificationSettings',
    items: [
      { href: '/user/push-notifications', labelKey: 'pushNotifications' },
    ],
  },
  {
    key: 'help',
    titleKey: 'helpSupport',
    items: [
      { href: '/help', labelKey: 'helpCenter' },
      { href: '/user/support-tickets', labelKey: 'supportTickets' },
    ],
  },
];

export default function UserSidebar({ isCollapsed, onToggle }: UserSidebarProps) {
  const { t } = useLocaleContext();
  const pathname = usePathname();
  const [openGroups, setOpenGroups] = useState<Record<SidebarGroup['key'], boolean>>({
    profile: true,
    security: true,
    notifications: true,
    help: true,
  });

  const isActive = (href: string) => {
    if (href === '/user') return pathname === href;
    return pathname === href || pathname.startsWith(`${href}/`);
  };

  const navLinkClass = (href: string) =>
    [
      'text-sm transition-colors duration-200 block py-2 px-3 rounded',
      isActive(href)
        ? 'bg-[#f0b90b]/15 text-[#f0b90b]'
        : 'text-white/70 hover:text-white hover:bg-white/10',
    ].join(' ');

  const toggleGroup = (key: SidebarGroup['key']) => {
    setOpenGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className={`w-full shrink-0 p-5 transition-all duration-300 ${isCollapsed ? 'lg:w-16' : 'lg:w-80'} lg:sticky lg:top-0 lg:h-full border-r border-white/10`}>
      <div className="mb-6 flex items-center justify-between">
        {!isCollapsed ? (
          <div className="text-sm text-white/70">{t('sidebarTagline', 'user')}</div>
        ) : null}

        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded transition-colors duration-200 hover:bg-white/10"
          onClick={onToggle}
          aria-label={isCollapsed ? t('expandSidebar', 'user') : t('collapseSidebar', 'user')}
        >
          <svg className={`h-4 w-4 text-white/70 transition-transform duration-300 ${isCollapsed ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 19l-7-7 7-7" />
          </svg>
        </button>
      </div>

      {SIDEBAR_GROUPS.map((group) => (
        <div key={group.key} className="mb-6 last:mb-0">
          <h3
            className={`mb-4 flex cursor-pointer items-center text-sm font-semibold uppercase tracking-wider text-white/90 transition-all duration-300 ${isCollapsed ? 'justify-center' : 'justify-between'}`}
            onClick={() => toggleGroup(group.key)}
          >
            {!isCollapsed ? <span>{t(group.titleKey, 'user')}</span> : null}
            {!isCollapsed ? (
              <button type="button" className="flex h-5 w-5 items-center justify-center rounded transition-transform duration-200 hover:bg-white/10">
                <svg className={`h-3 w-3 text-white/70 transition-transform duration-200 ${openGroups[group.key] ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7" />
                </svg>
              </button>
            ) : null}
          </h3>

          {openGroups[group.key] && !isCollapsed ? (
            <ul className="space-y-3">
              {group.items.map((item) => (
                <li key={item.href}>
                  <a href={item.href} className={navLinkClass(item.href)}>
                    {t(item.labelKey, 'user')}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ))}
    </div>
  );
}
