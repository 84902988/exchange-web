'use client';

import { useEffect, useMemo, useState } from 'react';

import { useLocaleContext } from '@/contexts/LocaleContext';

type ContractLeverageModalProps = {
  open: boolean;
  symbol: string;
  marginModeLabel: string;
  value: number;
  maxLeverage: number;
  onCancel: () => void;
  onConfirm: (value: number) => void;
};

function clampLeverage(value: number, maxLeverage: number) {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(maxLeverage, Math.floor(value)));
}

export default function ContractLeverageModal({
  open,
  symbol,
  marginModeLabel,
  value,
  maxLeverage,
  onCancel,
  onConfirm,
}: ContractLeverageModalProps) {
  const { t } = useLocaleContext();
  const [draft, setDraft] = useState(() => clampLeverage(value, maxLeverage));

  const marks = useMemo(() => {
    const base = [1, 30, 60, 90, 120, 150, maxLeverage]
      .filter((item) => item >= 1 && item <= maxLeverage);
    return Array.from(new Set(base)).sort((a, b) => a - b);
  }, [maxLeverage]);

  useEffect(() => {
    setDraft(clampLeverage(value, maxLeverage));
  }, [value, maxLeverage]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/65 px-4">
      <div className="w-full max-w-[360px] rounded-xl border border-white/10 bg-[#151a21] p-4 text-white shadow-2xl">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-[16px] font-semibold">{t('adjustLeverageTitle', 'contracts')}</h3>
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md px-2 py-1 text-[12px] text-white/50 hover:bg-white/[0.06] hover:text-white"
          >
            {t('close', 'common')}
          </button>
        </div>

        <div className="mb-3 rounded-lg bg-[#0b0e11] px-3 py-2 text-[12px] text-white/60">
          {t('currentTradingPair', 'contracts')}<span className="font-semibold text-white">{symbol}</span>
          <span className="mx-1 text-white/30">·</span>
          {marginModeLabel}
        </div>

        <label className="block">
          <span className="mb-1.5 block text-[12px] text-white/50">{t('leverageMultiplier', 'contracts')}</span>
          <div className="flex h-10 items-center rounded-lg border border-white/[0.08] bg-[#0d1218] px-3">
            <input
              type="number"
              min={1}
              max={maxLeverage}
              value={draft}
              onChange={(event) => setDraft(clampLeverage(Number(event.target.value), maxLeverage))}
              className="min-w-0 flex-1 bg-transparent font-mono text-[15px] text-white outline-none"
            />
            <span className="text-[13px] text-white/45">x</span>
          </div>
        </label>

        <div className="mt-4">
          <input
            type="range"
            min={1}
            max={maxLeverage}
            value={draft}
            onChange={(event) => setDraft(clampLeverage(Number(event.target.value), maxLeverage))}
            className="w-full accent-white"
          />
          <div className="mt-1.5 flex justify-between text-[10px] text-white/42">
            {marks.map((mark) => (
              <button
                key={mark}
                type="button"
                onClick={() => setDraft(mark)}
                className="rounded px-1 py-0.5 hover:bg-white/[0.06] hover:text-white"
              >
                {mark}x
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-yellow-500/20 bg-yellow-500/10 px-3 py-2 text-[12px] leading-5 text-yellow-200">
          {t('adjustLeverageMarginWarning', 'contracts')}
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="h-10 rounded-lg border border-white/10 text-[14px] font-semibold text-white/75 hover:bg-white/[0.06] hover:text-white"
          >
            {t('cancel', 'contracts')}
          </button>
          <button
            type="button"
            onClick={() => onConfirm(clampLeverage(draft, maxLeverage))}
            className="h-10 rounded-lg bg-white text-[14px] font-semibold text-black"
          >
            {t('confirm', 'contracts')}
          </button>
        </div>
      </div>
    </div>
  );
}
