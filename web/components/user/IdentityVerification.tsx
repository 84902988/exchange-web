import useLocale from '@/hooks/useLocale';

export default function IdentityVerification() {
  const { t } = useLocale();

  return (
    <div className="bg-[#0a0a0d] rounded-lg p-6 mb-6">
      <h3 className="text-xl font-bold text-white mb-4">
        {t('identityVerification', 'user')}
      </h3>
      
      <div className="space-y-4">
        <div className="bg-black rounded p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-white font-semibold">
                {t('realNameVerification', 'user')}
              </div>
              <div className="text-sm text-white/60 mt-1">
                {t('realNameDesc', 'user')}
              </div>
            </div>
            <button className="bg-amber-500 hover:bg-amber-600 text-white py-2 px-4 rounded transition-colors duration-200 text-sm">
              {t('verifyNow', 'user')}
            </button>
          </div>
        </div>

        <div className="bg-black rounded p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-white font-semibold">
                {t('advancedVerification', 'user')}
              </div>
              <div className="text-sm text-white/60 mt-1">
                {t('advancedDesc', 'user')}
              </div>
            </div>
            <button className="bg-[#1a1f2e] hover:bg-[#222837] text-white py-2 px-4 rounded transition-colors duration-200 text-sm">
              {t('notVerified', 'user')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}