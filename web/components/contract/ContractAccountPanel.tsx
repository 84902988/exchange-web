'use client';

import { useState } from 'react';
import Link from 'next/link';
import AssetTransferModal from '@/components/asset/AssetTransferModal';
import { useLocaleContext } from '@/contexts/LocaleContext';
import type { ContractAccountSummary } from '@/lib/api/modules/contract';
import { formatNumber, toNumber } from './contractFormat';

type ContractAccountPanelProps = {
  account: ContractAccountSummary | null;
  fundingAvailable?: string | null;
  isLoggedIn: boolean;
  loading?: boolean;
  error?: string | null;
  onSuccess: () => Promise<void> | void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
};

export default function ContractAccountPanel({
  account,
  isLoggedIn,
  loading = false,
  error = null,
  onSuccess,
}: ContractAccountPanelProps) {
  const { t } = useLocaleContext();
  const [transferOpen, setTransferOpen] = useState(false);

  return (
    <div className="tabular-nums text-sm text-white">
      <div className="border-b border-white/10 px-2.5 py-2">
        <div className="flex items-center justify-between">
          <div className="text-[14px] font-semibold text-white">{t('contractAccount', 'contracts')}</div>
          <div className="text-[12px] text-white/45">
            {loading ? t('loading', 'common') : account?.margin_asset || 'USDT'}
          </div>
        </div>
      </div>

      {!isLoggedIn ? (
        <div className="px-3 py-8 text-center text-sm text-white/50">
          {t('loginToViewContractAccount', 'contracts')}
        </div>
      ) : error ? (
        <div className="px-3 py-8 text-center text-sm text-[#f6465d]">
          {t('contractAccountLoadFailed', 'contracts')}
        </div>
      ) : (
        <div className="space-y-2 p-2">
          <div className="rounded-lg bg-[#0b0e11] p-2">
            <AccountRow label={t('availableMargin', 'contracts')} value={account?.available_margin} strong />
            <AccountRow label={t('positionMargin', 'contracts')} value={account?.used_margin || account?.position_margin} />
            <AccountRow label={t('frozenMargin', 'contracts')} value={account?.frozen_margin} />
            <AccountRow label={t('accountEquity', 'contracts')} value={account?.equity} strong />
            <AccountRow label={t('realizedPnl', 'contracts')} value={account?.realized_pnl} colored />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <Link
              href="/asset/deposit?coin=USDT"
              className="h-9 rounded-lg border border-white/10 bg-white/5 py-2 text-center text-[13px] font-semibold text-white transition-colors hover:bg-white/10"
            >
              {t('deposit', 'common')}
            </Link>
            <button
              type="button"
              onClick={() => setTransferOpen(true)}
              className="h-9 rounded-lg bg-white text-center text-[13px] font-semibold text-black transition-colors hover:bg-white/90"
            >
              {t('transfer', 'user')}
            </button>
          </div>
        </div>
      )}

      <AssetTransferModal
        open={transferOpen}
        onClose={() => setTransferOpen(false)}
        defaultFrom="funding"
        defaultTo="contract"
        defaultCoin="USDT"
        onSuccess={onSuccess}
      />
    </div>
  );
}

function AccountRow({
  label,
  value,
  strong = false,
  colored = false,
}: {
  label: string;
  value?: string | null;
  strong?: boolean;
  colored?: boolean;
}) {
  const num = toNumber(value);
  const colorClass = colored
    ? num > 0
      ? 'text-[#00c087]'
      : num < 0
        ? 'text-[#f6465d]'
        : 'text-white/85'
    : strong
      ? 'text-white'
      : 'text-white/85';

  return (
    <div className="flex items-center justify-between gap-2 py-1 text-[12px]">
      <span className="min-w-0 text-white/42">{label}</span>
      <span className={`min-w-0 truncate text-right font-mono font-semibold ${colorClass}`}>
        {formatNumber(value, 4)} USDT
      </span>
    </div>
  );
}
