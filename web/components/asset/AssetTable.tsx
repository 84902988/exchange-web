'use client';

import { useLocaleContext } from '@/contexts/LocaleContext';
import AssetTableRow from './AssetTableRow';
import { Language } from '@/types';

export interface AssetItem {
  id: string;
  symbol: string;
  name: string;
  available: number;
  frozen: number;
  total: number;
  price?: number;
  change24h?: number;
  displayPrecision?: number;
}

interface AssetTableProps {
  data: AssetItem[];
  isLoading?: boolean;
  onRecharge?: (symbol: string) => void;
  onWithdraw?: (symbol: string) => void;
  onTrade?: (symbol: string) => void;
  currentLanguage: Language;
}

export default function AssetTable({ data, isLoading = false, onRecharge, onWithdraw, onTrade, currentLanguage }: AssetTableProps) {
  const { t } = useLocaleContext();

  return (
    <div className="overflow-x-auto tabular-nums">
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-white/10">
            <th className="px-4 py-2.5 text-left text-[12px] font-medium text-white/50">{t('currency', 'asset')}</th>
            <th className="px-4 py-2.5 text-right text-[12px] font-medium text-white/50">{t('available', 'asset')}</th>
            <th className="px-4 py-2.5 text-right text-[12px] font-medium text-white/50">{t('frozen', 'asset')}</th>
            <th className="px-4 py-2.5 text-right text-[12px] font-medium text-white/50">{t('total', 'asset')}</th>
            <th className="px-4 py-2.5 text-right text-[12px] font-medium text-white/50">{t('action', 'asset')}</th>
          </tr>
        </thead>
        <tbody>
          {isLoading ? (
            Array.from({ length: 3 }).map((_, index) => (
              <tr key={index} className="border-b border-white/10">
                <td className="px-4 py-2.5">
                  <div className="flex items-center">
                    <div className="w-6 h-6 bg-gray-700 rounded mr-2 animate-pulse"></div>
                    <div className="w-16 h-4 bg-gray-700 rounded animate-pulse"></div>
                  </div>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="w-20 h-4 bg-gray-700 rounded animate-pulse"></div>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="w-20 h-4 bg-gray-700 rounded animate-pulse"></div>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="w-20 h-4 bg-gray-700 rounded animate-pulse"></div>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex justify-end space-x-2">
                    <div className="w-12 h-6 bg-gray-700 rounded animate-pulse"></div>
                    <div className="w-12 h-6 bg-gray-700 rounded animate-pulse"></div>
                  </div>
                </td>
              </tr>
            ))
          ) : data.length === 0 ? (
            <tr>
              <td colSpan={5} className="text-center py-8 text-white/50">
                {t('noAssets', 'asset')}
              </td>
            </tr>
          ) : (
            data.map((asset) => (
              <AssetTableRow
                key={asset.id}
                asset={asset}
                onRecharge={onRecharge}
                onWithdraw={onWithdraw}
                onTrade={onTrade}
                currentLanguage={currentLanguage}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
