'use client';

import { useLocaleContext } from '@/contexts/LocaleContext';

const FAQ_CATEGORIES = [
  { key: 'all', labelKey: 'faqCategoryAll', active: true },
  { key: 'account', labelKey: 'faqCategoryAccount' },
  { key: 'trading', labelKey: 'faqCategoryTrading' },
  { key: 'asset', labelKey: 'faqCategoryAsset' },
  { key: 'security', labelKey: 'faqCategorySecurity' },
];

const FAQ_ITEMS = [
  {
    questionKey: 'faqRegisterQuestion',
    answerKeys: [
      'faqRegisterAnswer1',
      'faqRegisterAnswer2',
      'faqRegisterAnswer3',
      'faqRegisterAnswer4',
      'faqRegisterAnswer5',
    ],
  },
  {
    questionKey: 'faqDepositQuestion',
    answerKeys: [
      'faqDepositAnswer1',
      'faqDepositAnswer2',
      'faqDepositAnswer3',
      'faqDepositAnswer4',
      'faqDepositAnswer5',
    ],
  },
  {
    questionKey: 'faqWithdrawQuestion',
    answerKeys: [
      'faqWithdrawAnswer1',
      'faqWithdrawAnswer2',
      'faqWithdrawAnswer3',
      'faqWithdrawAnswer4',
      'faqWithdrawAnswer5',
      'faqWithdrawAnswer6',
    ],
  },
  {
    questionKey: 'faqForgotPasswordQuestion',
    answerKeys: [
      'faqForgotPasswordAnswer1',
      'faqForgotPasswordAnswer2',
      'faqForgotPasswordAnswer3',
      'faqForgotPasswordAnswer4',
    ],
  },
];

export default function FaqPage() {
  const { t } = useLocaleContext();

  return (
    <main className="min-h-screen py-8">
      <div className="container mx-auto px-4">
        <h1 className="text-2xl font-bold text-white mb-6">{t('faqPageTitle', 'common')}</h1>

        <div className="bg-[#0e1117] rounded-xl p-5 border border-white/10 shadow-xl mb-6">
          <div className="flex">
            <input
              type="text"
              placeholder={t('faqSearchPlaceholder', 'common')}
              className="flex-1 bg-[#1a1f2e] border border-white/10 rounded-l p-3 text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all duration-300"
            />
            <button className="bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white rounded-r px-4 transition-all duration-200">
              {t('search', 'common')}
            </button>
          </div>
        </div>

        <div className="bg-[#0e1117] rounded-xl p-5 border border-white/10 shadow-xl mb-6">
          <div className="flex flex-wrap gap-2">
            {FAQ_CATEGORIES.map((category) => (
              <button
                key={category.key}
                className={
                  category.active
                    ? 'bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white rounded px-3 py-1 text-sm transition-all duration-200'
                    : 'bg-[#1a1f2e] text-white/50 rounded px-3 py-1 text-sm border border-white/10 hover:bg-white/10 transition-colors duration-200'
                }
              >
                {t(category.labelKey, 'common')}
              </button>
            ))}
          </div>
        </div>

        <div className="bg-[#0e1117] rounded-xl p-5 border border-white/10 shadow-xl">
          <div className="space-y-4">
            {FAQ_ITEMS.map((item) => (
              <div key={item.questionKey} className="border-b border-white/10 pb-4">
                <div className="text-white font-semibold mb-2">{t(item.questionKey, 'common')}</div>
                <div className="text-sm text-white/70">
                  {item.answerKeys.map((key, index) => (
                    <div key={key}>{index + 1}. {t(key, 'common')}</div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 flex justify-center">
            <div className="flex space-x-2">
              <button className="bg-[#1a1f2e] text-white/50 rounded px-3 py-1 border border-white/10 hover:bg-white/10 transition-colors duration-200">
                {t('faqPreviousPage', 'common')}
              </button>
              <button className="bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white rounded px-3 py-1 transition-all duration-200">1</button>
              <button className="bg-[#1a1f2e] text-white rounded px-3 py-1 border border-white/10 hover:bg-white/10 transition-colors duration-200">2</button>
              <button className="bg-[#1a1f2e] text-white rounded px-3 py-1 border border-white/10 hover:bg-white/10 transition-colors duration-200">3</button>
              <button className="bg-[#1a1f2e] text-white/50 rounded px-3 py-1 border border-white/10 hover:bg-white/10 transition-colors duration-200">
                {t('faqNextPage', 'common')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
