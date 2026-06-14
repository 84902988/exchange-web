import useLocale from '@/hooks/useLocale';

export default function SecurityCenter() {
  const { t } = useLocale();

  return (
    <div className="bg-[#0a0a0d] rounded-lg p-6 mb-6">
      <h3 className="text-xl font-bold text-white mb-4">
        {t('securityCenter', 'user')}
      </h3>
      
      <div className="space-y-4">
        <div className="bg-black rounded p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-white font-semibold">
                {t('loginPassword', 'user')}
              </div>
              <div className="text-sm text-white/60 mt-1">
                {t('passwordDesc', 'user')}
              </div>
            </div>
            <button className="bg-amber-500 hover:bg-amber-600 text-white py-2 px-4 rounded transition-colors duration-200 text-sm">
              {t('changePassword', 'user')}
            </button>
          </div>
        </div>

        <div className="bg-black rounded p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-white font-semibold">
                {t('googleAuthenticator', 'user')}
              </div>
              <div className="text-sm text-white/60 mt-1">
                {t('enableGoogleAuth', 'user')}
              </div>
            </div>
            <button className="bg-[#1a1f2e] hover:bg-[#222837] text-white py-2 px-4 rounded transition-colors duration-200 text-sm">
              {t('notSupported', 'user')}
            </button>
          </div>
        </div>

        <div className="bg-black rounded p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-white font-semibold">
                {t('passkey', 'user')}
              </div>
              <div className="text-sm text-white/60 mt-1">
                {t('passkeyDesc', 'user')}
              </div>
            </div>
            <button className="bg-[#1a1f2e] hover:bg-[#222837] text-white py-2 px-4 rounded transition-colors duration-200 text-sm">
              {t('notSupported', 'user')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}