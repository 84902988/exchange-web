'use client';

import { motion } from 'framer-motion';
import { useLocaleContext } from '@/contexts/LocaleContext';

interface Service {
  id: number;
  titleKey: string;
  descriptionKey: string;
  icon: string;
}

interface Advantage {
  id: number;
  titleKey: string;
  descriptionKey: string;
  icon: string;
}

interface Step {
  id: number;
  titleKey: string;
  descriptionKey: string;
}

const SERVICES: Service[] = [
  { id: 1, titleKey: 'institutionServiceTradingTitle', descriptionKey: 'institutionServiceTradingDesc', icon: '⚙' },
  { id: 2, titleKey: 'institutionServiceFeeTitle', descriptionKey: 'institutionServiceFeeDesc', icon: '💵' },
  { id: 3, titleKey: 'institutionServiceApiTitle', descriptionKey: 'institutionServiceApiDesc', icon: '🔌' },
  { id: 4, titleKey: 'institutionServiceManagerTitle', descriptionKey: 'institutionServiceManagerDesc', icon: '👤' },
  { id: 5, titleKey: 'institutionServiceRiskTitle', descriptionKey: 'institutionServiceRiskDesc', icon: '🛡' },
  { id: 6, titleKey: 'institutionServiceLiquidityTitle', descriptionKey: 'institutionServiceLiquidityDesc', icon: '💧' },
];

const ADVANTAGES: Advantage[] = [
  { id: 1, titleKey: 'institutionAdvantageSecurityTitle', descriptionKey: 'institutionAdvantageSecurityDesc', icon: '🔐' },
  { id: 2, titleKey: 'institutionAdvantagePerformanceTitle', descriptionKey: 'institutionAdvantagePerformanceDesc', icon: '🚀' },
  { id: 3, titleKey: 'institutionAdvantageTeamTitle', descriptionKey: 'institutionAdvantageTeamDesc', icon: '👥' },
  { id: 4, titleKey: 'institutionAdvantageGlobalTitle', descriptionKey: 'institutionAdvantageGlobalDesc', icon: '🌐' },
];

const STEPS: Step[] = [
  { id: 1, titleKey: 'institutionStepApplyTitle', descriptionKey: 'institutionStepApplyDesc' },
  { id: 2, titleKey: 'institutionStepReviewTitle', descriptionKey: 'institutionStepReviewDesc' },
  { id: 3, titleKey: 'institutionStepOnboardingTitle', descriptionKey: 'institutionStepOnboardingDesc' },
  { id: 4, titleKey: 'institutionStepTradeTitle', descriptionKey: 'institutionStepTradeDesc' },
];

export default function InstitutionPage() {
  const { t } = useLocaleContext();

  return (
    <div className="min-h-screen bg-[#0b0b0f] text-white">
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="bg-gradient-to-r from-amber-600/20 via-transparent to-amber-600/20 border-b border-white/10"
      >
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-16">
          <div className="text-center">
            <motion.h1
              initial={{ opacity: 0, scale: 0.9 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="text-4xl md:text-6xl font-bold mb-4 bg-clip-text text-transparent bg-gradient-to-r from-amber-400 to-white"
            >
              {t('institutionTitle', 'common')}
            </motion.h1>
            <motion.p
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.5, delay: 0.4 }}
              className="text-xl md:text-2xl text-gray-300 max-w-3xl mx-auto"
            >
              {t('institutionSubtitle', 'common')}
            </motion.p>
          </div>
        </div>
      </motion.div>

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="mb-20"
        >
          <div className="bg-gradient-to-br from-[#121217] via-[#1a1a2e] to-[#121217] rounded-xl border border-white/10 p-8 md:p-12 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-amber-500 to-transparent" />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-12 relative z-10">
              <div className="space-y-6">
                <motion.h2
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.5, delay: 0.2 }}
                  className="text-3xl md:text-4xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-amber-400 to-white"
                >
                  {t('institutionIntroTitle', 'common')}
                </motion.h2>
                <motion.p
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.5, delay: 0.3 }}
                  className="text-lg text-gray-300"
                >
                  {t('institutionIntroDesc1', 'common')}
                </motion.p>
                <motion.p
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.5, delay: 0.4 }}
                  className="text-lg text-gray-300"
                >
                  {t('institutionIntroDesc2', 'common')}
                </motion.p>
                <motion.div
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.5 }}
                  className="pt-4"
                >
                  <button className="inline-flex items-center gap-2 px-8 py-3 bg-gradient-to-r from-amber-500 to-amber-600 text-white font-bold rounded-lg shadow-lg shadow-amber-500/30 hover:shadow-amber-500/50 transition-all duration-300 transform hover:scale-105">
                    {t('institutionApplyNow', 'common')}
                    <span className="text-xl">→</span>
                  </button>
                </motion.div>
              </div>
              <div className="space-y-6">
                {ADVANTAGES.map((advantage, index) => (
                  <motion.div
                    key={advantage.id}
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.5, delay: 0.2 + index * 0.1 }}
                    className="flex items-start gap-4 p-4 rounded-lg bg-white/5 hover:bg-white/10 transition-all duration-300"
                  >
                    <div className="w-12 h-12 bg-amber-600/20 rounded-lg flex items-center justify-center text-amber-400 font-bold text-xl mt-0.5 flex-shrink-0">
                      {advantage.icon}
                    </div>
                    <div>
                      <h3 className="text-xl font-semibold text-white mb-1">{t(advantage.titleKey, 'common')}</h3>
                      <p className="text-gray-400">{t(advantage.descriptionKey, 'common')}</p>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          </div>
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="mb-20"
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-12 text-center bg-clip-text text-transparent bg-gradient-to-r from-amber-400 to-white">
            {t('institutionServicesTitle', 'common')}
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
            {SERVICES.map((service, index) => (
              <motion.div
                key={service.id}
                initial={{ opacity: 0, y: 30 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.1 * index }}
                whileHover={{ y: -5, boxShadow: '0 20px 40px rgba(245, 158, 11, 0.15)' }}
                className="bg-gradient-to-br from-[#121217] via-[#1a1a2e] to-[#121217] rounded-xl border border-white/10 p-8 transition-all duration-300 hover:border-amber-500/30"
              >
                <div className="w-16 h-16 bg-amber-600/20 rounded-lg flex items-center justify-center text-amber-400 font-bold text-2xl mb-6">
                  {service.icon}
                </div>
                <h3 className="text-2xl font-bold text-white mb-4">{t(service.titleKey, 'common')}</h3>
                <p className="text-gray-400">{t(service.descriptionKey, 'common')}</p>
              </motion.div>
            ))}
          </div>
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="mb-20"
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-12 text-center bg-clip-text text-transparent bg-gradient-to-r from-amber-400 to-white">
            {t('institutionProcessTitle', 'common')}
          </h2>

          <div className="bg-gradient-to-br from-[#121217] via-[#1a1a2e] to-[#121217] rounded-xl border border-white/10 p-8 md:p-12">
            <div className="relative">
              <div className="absolute left-1/2 top-0 bottom-0 w-1 bg-gradient-to-b from-amber-500 to-transparent transform -translate-x-1/2 hidden md:block" />

              <div className="space-y-12">
                {STEPS.map((step, index) => (
                  <motion.div
                    key={step.id}
                    initial={{ opacity: 0, y: 20 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, delay: 0.1 * index }}
                    className={`flex flex-col ${index % 2 === 0 ? 'md:flex-row' : 'md:flex-row-reverse'} items-center gap-8`}
                  >
                    <div className={`w-full md:w-1/2 ${index % 2 === 0 ? 'md:text-right' : 'md:text-left'}`}>
                      <div className="space-y-3">
                        <div className={`inline-block px-4 py-2 bg-gradient-to-r from-amber-500 to-amber-600 text-white rounded-full text-sm font-medium shadow-lg shadow-amber-500/30 ${index % 2 === 0 ? 'md:ml-auto' : 'md:mr-auto'}`}>
                          {t('institutionStepLabel', 'common')} {step.id}
                        </div>
                        <h3 className="text-2xl font-bold text-white">{t(step.titleKey, 'common')}</h3>
                        <p className="text-gray-400">{t(step.descriptionKey, 'common')}</p>
                      </div>
                    </div>

                    <div className="w-16 h-16 bg-amber-600 rounded-full flex items-center justify-center text-white font-bold text-2xl shadow-lg shadow-amber-500/50 z-10">
                      {step.id}
                    </div>

                    <div className="w-full md:w-1/2" />
                  </motion.div>
                ))}
              </div>
            </div>
          </div>
        </motion.section>

        <motion.section
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.4 }}
        >
          <div className="bg-gradient-to-br from-[#121217] via-[#1a1a2e] to-[#121217] rounded-xl border border-white/10 p-8 md:p-12 text-center relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-amber-500 to-transparent" />

            <div className="max-w-3xl mx-auto relative z-10">
              <motion.h2
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5 }}
                className="text-3xl md:text-4xl font-bold mb-6 bg-clip-text text-transparent bg-gradient-to-r from-amber-400 to-white"
              >
                {t('institutionCtaTitle', 'common')}
              </motion.h2>
              <motion.p
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.1 }}
                className="text-lg text-gray-300 mb-8"
              >
                {t('institutionCtaDesc', 'common')}
              </motion.p>
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.5, delay: 0.2 }}
                className="flex flex-col sm:flex-row gap-4 justify-center"
              >
                <button className="inline-flex items-center justify-center gap-2 px-8 py-3 bg-gradient-to-r from-amber-500 to-amber-600 text-white font-bold rounded-lg shadow-lg shadow-amber-500/30 hover:shadow-amber-500/50 transition-all duration-300 transform hover:scale-105">
                  {t('institutionApplyNow', 'common')}
                  <span className="text-xl">→</span>
                </button>
                <button className="inline-flex items-center justify-center gap-2 px-8 py-3 bg-white/10 text-white font-bold rounded-lg border border-white/20 hover:bg-white/20 transition-all duration-300">
                  {t('institutionContactSupport', 'common')}
                  <span className="text-xl">💬</span>
                </button>
              </motion.div>
            </div>
          </div>
        </motion.section>
      </div>
    </div>
  );
}
