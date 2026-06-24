'use client';

import { useLocaleContext } from '@/contexts/LocaleContext';
import { AssetItem } from './AssetTable';
import { Language } from '@/types';

interface AssetTableRowProps {
  asset: AssetItem;
  onRecharge?: (symbol: string) => void;
  onWithdraw?: (symbol: string) => void;
  onTrade?: (symbol: string) => void;
  currentLanguage: Language;
}

export default function AssetTableRow({
  asset,
  onRecharge,
  onWithdraw,
  onTrade,
}: AssetTableRowProps) {
  const { t } = useLocaleContext();
  void onTrade;

  const formatBalance = (balance: number): string => {
    const precision = Number.isFinite(Number(asset.displayPrecision))
      ? Math.max(0, Number(asset.displayPrecision))
      : 4;

    return balance.toLocaleString('en-US', {
      minimumFractionDigits: precision,
      maximumFractionDigits: precision,
    });
  };

  const getSymbolColor = (symbol: string): string => {
    const colors: Record<string, string> = {
      BTC: 'bg-yellow-500',
      ETH: 'bg-blue-500',
      USDT: 'bg-green-500',
      BNB: 'bg-yellow-600',
      SOL: 'bg-purple-500',
      ADA: 'bg-blue-600',
      XRP: 'bg-green-600',
      DOT: 'bg-blue-400',
    };
    return colors[symbol] || 'bg-gray-500';
  };

  return (
    <tr className="border-b border-white/10 transition-colors duration-150 hover:bg-[#0f1319]">
      <td className="px-4 py-3">
        <div className="flex items-center">
          <div className={`mr-2 h-6 w-6 rounded ${getSymbolColor(asset.symbol)}`} />
          <span className="font-semibold text-white">{asset.symbol}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-right text-white">{formatBalance(asset.available)}</td>
      <td className="px-4 py-3 text-right text-white">{formatBalance(asset.frozen)}</td>
      <td className="px-4 py-3 text-right text-white">{formatBalance(asset.total)}</td>
      <td className="px-4 py-3 text-right">
        <div className="flex justify-end space-x-2">
          <button
            className="rounded-lg bg-gradient-to-r from-amber-500 to-amber-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-all duration-300 hover:from-amber-600 hover:to-amber-700"
            onClick={() => onRecharge?.(asset.symbol)}
          >
            {t('recharge', 'asset')}
          </button>
          <button
            className="rounded-lg bg-gradient-to-r from-amber-500 to-amber-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm transition-all duration-300 hover:from-amber-600 hover:to-amber-700"
            onClick={() => onWithdraw?.(asset.symbol)}
          >
            {t('withdraw', 'asset')}
          </button>
        </div>
      </td>
    </tr>
  );
}
