import type { MenuAuth } from '@/lib/auth/permission';

export type Language = 'en' | 'zh' | 'zh-TW' | 'ja';

export interface TranslatedLabel {
  en: string;
  zh: string;
  'zh-TW'?: string;
  ja?: string;
  [key: string]: string | undefined;
}

export interface MenuItem {
  labelKey: string;
  href: string;
  isExternal?: boolean;
  megaMenu?: MegaMenu;
  auth?: MenuAuth;
  group?: string;
}

export interface MegaMenuGroup {
  titleKey: string;
  items: MenuItem[];
}

export interface MegaMenu {
  labelKey: string;
  groups: MegaMenuGroup[];
}

export interface NavMenuConfig {
  items: MenuItem[];
}

export const menuConfig: NavMenuConfig = {
  items: [
    {
      labelKey: 'trade',
      href: '/trade/spot',
      megaMenu: {
        labelKey: 'trade',
        groups: [
          {
            titleKey: 'spot',
            items: [
              { labelKey: 'navSpotTrading', href: '/trade/spot' },
              { labelKey: 'navRwaTrading', href: '/trade/spot?category=rwa' },
            ],
          },
          {
            titleKey: 'futures',
            items: [
              { labelKey: 'navUsdtFutures', href: '/contract?category=usdt' },
              { labelKey: 'navStockFutures', href: '/contract?category=stock' },
              { labelKey: 'navCfd', href: '/contract?category=cfd' },
            ],
          },
        ],
      },
    },
    {
      labelKey: 'futures',
      href: '/contract?category=usdt',
      megaMenu: {
        labelKey: 'futures',
        groups: [
          {
            titleKey: 'futures',
            items: [
              { labelKey: 'navUsdtFutures', href: '/contract?category=usdt' },
              { labelKey: 'navStockFutures', href: '/contract?category=stock' },
              { labelKey: 'navCfd', href: '/contract?category=cfd' },
            ],
          },
        ],
      },
    },
    { labelKey: 'markets', href: '/markets' },
    { labelKey: 'activity', href: '/activity' },
    { labelKey: 'invite', href: '/invite' },
    { labelKey: 'navAgency', href: '/affiliate' },
    { labelKey: 'vip', href: '/vip' },
    {
      labelKey: 'navMore',
      href: '/about/who-we-are',
      megaMenu: {
        labelKey: 'navMore',
        groups: [
          {
            titleKey: 'navAboutUs',
            items: [
              { labelKey: 'navWhoWeAre', href: '/about/who-we-are' },
              { labelKey: 'navPlatformStatement', href: '/about/platform-statement' },
              { labelKey: 'navAboutDigitalFinance', href: '/about/digital-finance' },
            ],
          },
        ],
      },
    },
    { labelKey: 'navCommittee', href: '/committee' },
    { labelKey: 'navHelpCenter', href: '/help' },
  ],
};

export const noticeMenuConfig = [
  { labelKey: 'navLatestNotices', href: '/notice?type=latest' },
  { labelKey: 'navPlatformNotices', href: '/notice?type=platform' },
  { labelKey: 'navActivityNotices', href: '/notice?type=activity' },
  { labelKey: 'navSystemNotices', href: '/notice?type=system' },
];

export const mobileMenuConfig = {
  primary: [
    { labelKey: 'trade', href: '/trade/spot' },
    { labelKey: 'markets', href: '/markets' },
    { labelKey: 'assets', href: '/asset' },
  ],
  secondary: [
    { labelKey: 'activity', href: '/activity' },
    { labelKey: 'navFinance', href: '/finance' },
    { labelKey: 'navHelpCenter', href: '/help' },
    { labelKey: 'invite', href: '/invite' },
    { labelKey: 'navFeedback', href: '/feedback' },
    { labelKey: 'vip', href: '/vip' },
  ],
};
