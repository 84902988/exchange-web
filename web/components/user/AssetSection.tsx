import useLocale from '@/hooks/useLocale';

export default function AssetSection() {
  const { t } = useLocale();

  return (
    <div className="bg-[#0a0a0d] rounded-lg p-6 mb-6">
      <h3 className="text-xl font-bold text-white mb-4">
        {t('assets', 'user')}
      </h3>
      
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 mb-6">
        {/* 总资产 */}
        <div className="bg-black rounded p-4">
          <div className="text-sm text-white/50 mb-1">
            {t('totalAssets', 'user')}
          </div>
          <div className="text-white text-2xl font-bold">
            0.00 USD
          </div>
        </div>

        {/* 可用资产 */}
        <div className="bg-black rounded p-4">
          <div className="text-sm text-white/50 mb-1">
            {t('availableAssets', 'user')}
          </div>
          <div className="text-white text-2xl font-bold">
            0.00 USD
          </div>
        </div>

        {/* 冻结资产 */}
        <div className="bg-black rounded p-4">
          <div className="text-sm text-white/50 mb-1">
            {t('frozenAssets', 'user')}
          </div>
          <div className="text-white text-2xl font-bold">
            0.00 USD
          </div>
        </div>

        {/* 待结算 */}
        <div className="bg-black rounded p-4">
          <div className="text-sm text-white/50 mb-1">
            {t('pendingSettlement', 'user')}
          </div>
          <div className="text-white text-2xl font-bold">
            0.00 USD
          </div>
        </div>
      </div>

      {/* 资产操作按钮 */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <button className="bg-amber-500 hover:bg-amber-600 text-white py-3 rounded transition-colors duration-200">
          {t('deposit', 'user')}
        </button>
        <button className="bg-red-500 hover:bg-red-600 text-white py-3 rounded transition-colors duration-200">
          {t('withdraw', 'user')}
        </button>
        <button className="bg-green-500 hover:bg-green-600 text-white py-3 rounded transition-colors duration-200">
          {t('transfer', 'user')}
        </button>
        <button className="bg-blue-500 hover:bg-blue-600 text-white py-3 rounded transition-colors duration-200">
          {t('assetDetails', 'user')}
        </button>
      </div>
    </div>
  );
}