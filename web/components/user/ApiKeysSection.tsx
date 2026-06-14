import useLocale from '@/hooks/useLocale';

export default function ApiKeysSection() {
  const { t } = useLocale();

  return (
    <div className="bg-[#0a0a0d] rounded-lg p-6 mb-6">
      <h3 className="text-xl font-bold text-white mb-4">
        {t('apiKeys', 'user')}
      </h3>
      
      <div className="space-y-4">
        <div className="bg-black rounded p-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-white font-semibold">
                {t('apiKeyManagement', 'user')}
              </div>
              <div className="text-sm text-white/60 mt-1">
                {t('apiKeyDesc', 'user')}
              </div>
            </div>
            <button className="bg-green-500 hover:bg-green-600 text-white py-2 px-4 rounded transition-colors duration-200 text-sm">
              {t('createNewKey', 'user')}
            </button>
          </div>
          
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <div>
                <div className="text-sm text-white/50 mb-1">
                  {t('activeKeys', 'user')}
                </div>
                <div className="text-white font-semibold">
                  0
                </div>
              </div>
              <div>
                <div className="text-sm text-white/50 mb-1">
                  {t('totalKeys', 'user')}
                </div>
                <div className="text-white font-semibold">
                  0
                </div>
              </div>
            </div>
            <button className="bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded transition-colors duration-200 text-sm">
              {t('manageKeys', 'user')}
            </button>
          </div>
        </div>

        <div className="bg-black rounded p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-white font-semibold">
                {t('apiDocumentation', 'user')}
              </div>
              <div className="text-sm text-white/60 mt-1">
                {t('apiDocDesc', 'user')}
              </div>
            </div>
            <button className="bg-blue-500 hover:bg-blue-600 text-white py-2 px-4 rounded transition-colors duration-200 text-sm">
              {t('viewDocumentation', 'user')}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}