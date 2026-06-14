'use client';

import { useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { useLocaleContext } from '@/contexts/LocaleContext';

interface HelpCategory {
  id: string;
  titleKey: string;
  icon: string;
  items: {
    id: string;
    titleKey: string;
    contentKey: string;
  }[];
}

const HELP_CATEGORIES: HelpCategory[] = [
  {
    id: 'account',
    titleKey: 'helpCategoryAccount',
    icon: '👤',
    items: [
      { id: 'account-create', titleKey: 'helpAccountCreateTitle', contentKey: 'helpAccountCreateContent' },
      { id: 'account-login', titleKey: 'helpAccountLoginTitle', contentKey: 'helpAccountLoginContent' },
      { id: 'account-security', titleKey: 'helpAccountSecurityTitle', contentKey: 'helpAccountSecurityContent' },
      { id: 'account-kyc', titleKey: 'helpAccountKycTitle', contentKey: 'helpAccountKycContent' },
    ],
  },
  {
    id: 'trading',
    titleKey: 'helpCategoryTrading',
    icon: '📊',
    items: [
      { id: 'trading-spot', titleKey: 'helpTradingSpotTitle', contentKey: 'helpTradingSpotContent' },
      { id: 'trading-futures', titleKey: 'helpTradingFuturesTitle', contentKey: 'helpTradingFuturesContent' },
      { id: 'trading-order', titleKey: 'helpTradingOrderTitle', contentKey: 'helpTradingOrderContent' },
      { id: 'trading-fees', titleKey: 'helpTradingFeesTitle', contentKey: 'helpTradingFeesContent' },
    ],
  },
  {
    id: 'deposit-withdraw',
    titleKey: 'helpCategoryDepositWithdraw',
    icon: '💳',
    items: [
      { id: 'deposit-crypto', titleKey: 'helpDepositCryptoTitle', contentKey: 'helpDepositCryptoContent' },
      { id: 'withdraw-crypto', titleKey: 'helpWithdrawCryptoTitle', contentKey: 'helpWithdrawCryptoContent' },
      { id: 'deposit-fiat', titleKey: 'helpDepositFiatTitle', contentKey: 'helpDepositFiatContent' },
      { id: 'withdraw-fiat', titleKey: 'helpWithdrawFiatTitle', contentKey: 'helpWithdrawFiatContent' },
    ],
  },
  {
    id: 'security',
    titleKey: 'helpCategorySecurity',
    icon: '🔐',
    items: [
      { id: 'security-2fa', titleKey: 'helpSecurity2faTitle', contentKey: 'helpSecurity2faContent' },
      { id: 'security-password', titleKey: 'helpSecurityPasswordTitle', contentKey: 'helpSecurityPasswordContent' },
      { id: 'security-phishing', titleKey: 'helpSecurityPhishingTitle', contentKey: 'helpSecurityPhishingContent' },
      { id: 'security-alert', titleKey: 'helpSecurityAlertTitle', contentKey: 'helpSecurityAlertContent' },
    ],
  },
  {
    id: 'api',
    titleKey: 'helpCategoryApi',
    icon: '🔌',
    items: [
      { id: 'api-create', titleKey: 'helpApiCreateTitle', contentKey: 'helpApiCreateContent' },
      { id: 'api-docs', titleKey: 'helpApiDocsTitle', contentKey: 'helpApiDocsContent' },
      { id: 'api-security', titleKey: 'helpApiSecurityTitle', contentKey: 'helpApiSecurityContent' },
      { id: 'api-limit', titleKey: 'helpApiLimitTitle', contentKey: 'helpApiLimitContent' },
    ],
  },
  {
    id: 'platform',
    titleKey: 'helpCategoryPlatform',
    icon: '📋',
    items: [
      { id: 'platform-risk', titleKey: 'helpPlatformRiskTitle', contentKey: 'helpPlatformRiskContent' },
      { id: 'platform-terms', titleKey: 'helpPlatformTermsTitle', contentKey: 'helpPlatformTermsContent' },
      { id: 'platform-privacy', titleKey: 'helpPlatformPrivacyTitle', contentKey: 'helpPlatformPrivacyContent' },
      { id: 'platform-compliance', titleKey: 'helpPlatformComplianceTitle', contentKey: 'helpPlatformComplianceContent' },
      { id: 'platform-fees', titleKey: 'helpPlatformFeesTitle', contentKey: 'helpPlatformFeesContent' },
    ],
  },
];

const QUICK_LINKS = [
  { href: '/help/faq', icon: '❓', labelKey: 'helpQuickFaq' },
  { href: '#', icon: '💬', labelKey: 'helpQuickSupport' },
  { href: '#', icon: '📝', labelKey: 'helpQuickTicket' },
  { href: '#', icon: '📋', labelKey: 'helpQuickTerms' },
];

const HOT_QUESTIONS = [
  'helpHotResetPassword',
  'helpHotWithdrawTime',
  'helpHotEnable2fa',
  'helpHotTradingFees',
];

export default function HelpPage() {
  const { t } = useLocaleContext();
  const [expandedCategory, setExpandedCategory] = useState<string>(HELP_CATEGORIES[0].id);
  const [selectedItem, setSelectedItem] = useState<string>(HELP_CATEGORIES[0].items[0].id);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(false);

  const currentContent = useMemo(() => {
    const category = HELP_CATEGORIES.find((item) => item.id === expandedCategory) || HELP_CATEGORIES[0];
    return category.items.find((item) => item.id === selectedItem) || category.items[0];
  }, [expandedCategory, selectedItem]);

  const toggleCategory = (categoryId: string) => {
    const nextCategory = HELP_CATEGORIES.find((item) => item.id === categoryId) || HELP_CATEGORIES[0];
    setExpandedCategory(expandedCategory === categoryId ? '' : categoryId);
    setSelectedItem(nextCategory.items[0].id);
  };

  return (
    <div className="min-h-screen bg-[#0b0b0f] text-white flex flex-col">
      <div className="border-b border-white/10 z-10">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            <div className="flex items-center">
              <h1 className="text-xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-amber-400 to-white">
                {t('helpCenterTitle', 'common')}
              </h1>
            </div>
            <div className="flex items-center space-x-4">
              <button className="px-4 py-2 bg-blue-600/20 hover:bg-blue-600/30 rounded-lg text-sm font-medium transition-colors">
                {t('helpContactSupport', 'common')}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.5 }}
          className={`bg-[#121217] border-r border-white/10 flex-shrink-0 transition-all duration-300 overflow-hidden ${isSidebarCollapsed ? 'w-16' : 'w-64'}`}
        >
          <div className="flex justify-end p-4">
            <button
              onClick={() => setIsSidebarCollapsed(!isSidebarCollapsed)}
              className="p-2 text-gray-500 hover:text-gray-300 transition-colors"
              aria-label={isSidebarCollapsed ? t('helpExpandSidebar', 'common') : t('helpCollapseSidebar', 'common')}
            >
              {isSidebarCollapsed ? '>' : '<'}
            </button>
          </div>

          <nav className="space-y-2 px-2">
            {HELP_CATEGORIES.map((category) => (
              <div key={category.id} className="space-y-1">
                <button
                  onClick={() => toggleCategory(category.id)}
                  className={`w-full flex items-center justify-between p-3 rounded-lg text-left transition-colors ${expandedCategory === category.id ? 'bg-amber-600/20 text-amber-400' : 'hover:bg-white/10 text-gray-300'}`}
                >
                  <div className="flex items-center space-x-3">
                    <span>{category.icon}</span>
                    {!isSidebarCollapsed && <span className="font-medium">{t(category.titleKey, 'common')}</span>}
                  </div>
                  {!isSidebarCollapsed && (
                    <span className={`transform transition-transform ${expandedCategory === category.id ? 'rotate-90' : ''}`}>
                      &gt;
                    </span>
                  )}
                </button>

                {!isSidebarCollapsed && expandedCategory === category.id && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    transition={{ duration: 0.3 }}
                    className="pl-12 space-y-1"
                  >
                    {category.items.map((item) => (
                      <button
                        key={item.id}
                        onClick={() => setSelectedItem(item.id)}
                        className={`w-full text-left p-2.5 rounded-lg transition-colors text-sm ${selectedItem === item.id ? 'bg-amber-600/20 text-amber-400' : 'text-gray-400 hover:text-white hover:bg-white/5'}`}
                      >
                        {t(item.titleKey, 'common')}
                      </button>
                    ))}
                  </motion.div>
                )}
              </div>
            ))}
          </nav>
        </motion.div>

        <div className="flex-1 overflow-y-auto p-8">
          <div className="max-w-6xl mx-auto">
            <div className="flex flex-col lg:flex-row gap-8">
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.2 }}
                className="flex-1"
              >
                <div className="p-4 md:p-0">
                  <h2 className="text-2xl font-bold mb-6 text-white">{t(currentContent.titleKey, 'common')}</h2>
                  <div className="prose prose-invert max-w-none">
                    <p className="text-gray-300 leading-relaxed">{t(currentContent.contentKey, 'common')}</p>

                    <div className="mt-8 bg-white/5 p-6 rounded-lg">
                      <h3 className="text-lg font-semibold mb-3 text-white">{t('helpRelatedSteps', 'common')}</h3>
                      <ol className="list-decimal pl-5 space-y-2 text-gray-300">
                        <li>{t('helpRelatedStepLogin', 'common')}</li>
                        <li>{t('helpRelatedStepOpenPage', 'common')}</li>
                        <li>{t('helpRelatedStepFollowPrompt', 'common')}</li>
                        <li>{t('helpRelatedStepConfirm', 'common')}</li>
                      </ol>
                    </div>

                    <div className="mt-8 bg-amber-600/10 p-6 rounded-lg border border-amber-600/30">
                      <h3 className="text-lg font-semibold mb-3 text-amber-400">{t('helpWarmTips', 'common')}</h3>
                      <p className="text-gray-300">{t('helpWarmTipsContent', 'common')}</p>
                    </div>
                  </div>
                </div>
              </motion.div>

              <motion.div
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.5, delay: 0.4 }}
                className="lg:w-64 flex-shrink-0"
              >
                <div className="bg-[#121217] rounded-lg border border-white/10 p-6 mb-6">
                  <h3 className="text-lg font-semibold mb-4 text-white">{t('helpQuickLinks', 'common')}</h3>
                  <ul className="space-y-3">
                    {QUICK_LINKS.map((link) => (
                      <li key={link.labelKey}>
                        <a href={link.href} className="flex items-center space-x-2 text-gray-400 hover:text-white transition-colors">
                          <span>{link.icon}</span>
                          <span>{t(link.labelKey, 'common')}</span>
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>

                <div className="bg-[#121217] rounded-lg border border-white/10 p-6">
                  <h3 className="text-lg font-semibold mb-4 text-white">{t('helpHotQuestions', 'common')}</h3>
                  <ul className="space-y-3">
                    {HOT_QUESTIONS.map((key) => (
                      <li key={key}>
                        <a href="#" className="text-sm text-gray-400 hover:text-white transition-colors line-clamp-2">
                          {t(key, 'common')}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              </motion.div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
