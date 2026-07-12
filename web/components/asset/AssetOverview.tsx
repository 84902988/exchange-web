'use client';

import { useState } from 'react';
import { useLocaleContext } from '@/contexts/LocaleContext';
import type { Language } from '@/types';

type FiatCurrency = 'CNY' | 'USD' | 'EUR' | 'RUB';

interface FiatRate {
  rate: number;
  symbol: string;
  nameKey: string;
}

export interface AssetOverviewData {
  total: number;
  available: number;
  frozen: number;
  cnyRate?: number;
  todayProfit?: number;
  todayProfitRate?: number;
}

interface AssetOverviewProps {
  data: AssetOverviewData;
  isLoading?: boolean;
  currentLanguage: Language;
}

export default function AssetOverview({
  data,
  isLoading = false,
  currentLanguage: _currentLanguage,
}: AssetOverviewProps) {
  void _currentLanguage;
  const { t } = useLocaleContext();
  const [selectedFiat, setSelectedFiat] = useState<FiatCurrency>('USD');
  const [showFiatDropdown, setShowFiatDropdown] = useState(false);

  const fiatRates: Record<FiatCurrency, FiatRate> = {
    CNY: { rate: data.cnyRate || 7.0, symbol: '\u00a5', nameKey: 'fiatChineseYuan' },
    USD: { rate: 1.0, symbol: '$', nameKey: 'fiatUsDollar' },
    EUR: { rate: 0.92, symbol: '\u20ac', nameKey: 'fiatEuro' },
    RUB: { rate: 95.0, symbol: '\u20bd', nameKey: 'fiatRussianRuble' },
  };

  const formatNumber = (num: number): string => {
    return num.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const calculateFiatValue = (usdt: number): string => {
    const fiat = fiatRates[selectedFiat];
    const value = usdt * fiat.rate;
    return value.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  };

  const toggleFiatDropdown = () => {
    setShowFiatDropdown(!showFiatDropdown);
  };

  const selectFiat = (fiat: FiatCurrency) => {
    setSelectedFiat(fiat);
    setShowFiatDropdown(false);
  };

  return (
    <div className="mb-6 grid grid-cols-1 gap-6 tabular-nums md:grid-cols-2 lg:grid-cols-4">
      <div className="bg-[#0e1117] rounded-xl p-5 border border-white/10 hover:border-white/20 transition-all duration-300 shadow-xl hover:shadow-2xl">
        <div className="flex items-center justify-between text-sm text-white/50 mb-2">
          <span>{t('totalAssetsUsdt', 'asset')}</span>
          <div className="relative inline-block">
            <button
              onClick={toggleFiatDropdown}
              className="flex items-center gap-1.5 bg-white/5 hover:bg-white/10 px-2.5 py-1 rounded text-xs transition-colors duration-200"
            >
              <span>{selectedFiat}</span>
              <svg className="w-3 h-3 transition-transform duration-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            {showFiatDropdown && (
              <div className="absolute right-0 mt-1 w-36 bg-[#0e1117] border border-white/10 rounded-lg shadow-xl z-10">
                {Object.entries(fiatRates).map(([code, fiat]) => (
                  <button
                    key={code}
                    onClick={() => selectFiat(code as FiatCurrency)}
                    className={`w-full text-left px-3 py-2 text-xs transition-colors duration-200 hover:bg-white/5 ${selectedFiat === code ? 'bg-white/10 text-amber-400' : 'text-white/80'}`}
                  >
                    <div className="flex items-center justify-between">
                      <span>{code}</span>
                      <span className="text-xs text-white/50">{t(fiat.nameKey, 'asset')}</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="text-[30px] font-semibold leading-none text-white">
          {isLoading ? '...' : `$${formatNumber(data.total)}`}
        </div>
        <div className="text-xs text-white/50 mt-2">
          {isLoading ? '...' : `\u2248 ${calculateFiatValue(data.total)} ${selectedFiat}`}
        </div>
      </div>

      <div className="bg-[#0e1117] rounded-xl p-5 border border-white/10 hover:border-white/20 transition-all duration-300 shadow-xl hover:shadow-2xl">
        <div className="text-sm text-white/50 mb-2">{t('availableBalanceUsdt', 'asset')}</div>
        <div className="text-[30px] font-semibold leading-none text-white">
          {isLoading ? '...' : `$${formatNumber(data.available)}`}
        </div>
        <div className="text-xs text-white/50 mt-2">
          {isLoading ? '...' : `${t('availableForTrading', 'asset')} | \u2248 ${calculateFiatValue(data.available)} ${selectedFiat}`}
        </div>
      </div>

      <div className="bg-[#0e1117] rounded-xl p-5 border border-white/10 hover:border-white/20 transition-all duration-300 shadow-xl hover:shadow-2xl">
        <div className="text-sm text-white/50 mb-2">{t('frozenBalanceUsdt', 'asset')}</div>
        <div className="text-[30px] font-semibold leading-none text-white">
          {isLoading ? '...' : `$${formatNumber(data.frozen)}`}
        </div>
        <div className="text-xs text-white/50 mt-2">
          {isLoading ? '...' : `${t('forUnfinishedOrders', 'asset')} | \u2248 ${calculateFiatValue(data.frozen)} ${selectedFiat}`}
        </div>
      </div>

      <div className="bg-[#0e1117] rounded-xl p-5 border border-white/10 hover:border-white/20 transition-all duration-300 shadow-xl hover:shadow-2xl">
        <div className="text-sm text-white/50 mb-2">{t('todayProfitUsdt', 'asset')}</div>
        <div className={`text-[30px] font-semibold leading-none ${data.todayProfit && data.todayProfit > 0 ? 'text-green-400' : 'text-red-400'}`}>
          {isLoading ? '...' : data.todayProfit ? `$${formatNumber(data.todayProfit)}` : '--'}
        </div>
        <div className={`text-xs mt-2 ${data.todayProfitRate && data.todayProfitRate > 0 ? 'text-green-400' : 'text-red-400'}`}>
          {isLoading ? '...' : data.todayProfitRate ? `${data.todayProfitRate > 0 ? '+' : ''}${data.todayProfitRate.toFixed(2)}% 24h` : '--'}
        </div>
      </div>
    </div>
  );
}
