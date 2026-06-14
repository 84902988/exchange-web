import useLocale from '@/hooks/useLocale';

export default function FeeSection() {
  const { t } = useLocale();

  return (
    <div className="bg-[#0a0a0d] rounded-lg p-6 mb-6">
      <h3 className="text-xl font-bold text-white mb-4">
        {t('fees', 'user')}
      </h3>
      
      <div className="space-y-4">
        <div className="bg-black rounded p-4">
          <div className="flex items-center justify-between mb-4">
            <div className="text-white font-semibold">
              {t('spotTradingFee', 'user')}
            </div>
            <div className="text-green-400 font-bold">
              0.10%
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div className="text-white font-semibold">
              {t('contractTradingFee', 'user')}
            </div>
            <div className="text-green-400 font-bold">
              0.05%
            </div>
          </div>
        </div>

        <div className="bg-black rounded p-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-white font-semibold">
                {t('vipLevel', 'user')}
              </div>
              <div className="text-sm text-white/60 mt-1">
                {t('vipDesc', 'user')}
              </div>
            </div>
            <div className="bg-amber-500/20 border border-amber-500/50 text-amber-400 py-2 px-4 rounded">
              {t('regularUser', 'user')}
            </div>
          </div>
          <button className="w-full bg-amber-500 hover:bg-amber-600 text-white py-2 px-4 rounded transition-colors duration-200 text-sm">
            {t('viewVipBenefits', 'user')}
          </button>
        </div>
      </div>
    </div>
  );
}