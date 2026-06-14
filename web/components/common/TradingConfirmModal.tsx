'use client';

import { useEffect, type MouseEvent, type ReactNode } from 'react';
import { useLocaleContext } from '@/contexts/LocaleContext';

export type TradingConfirmDetail = {
  label: string;
  value: ReactNode;
};

type TradingConfirmModalProps = {
  open: boolean;
  title: string;
  description: string;
  details?: TradingConfirmDetail[];
  confirmText: string;
  cancelText?: string;
  suppressLabel?: string;
  suppressChecked?: boolean;
  danger?: boolean;
  loading?: boolean;
  error?: string;
  onCancel: () => void;
  onConfirm: () => void;
  onSuppressChange?: (checked: boolean) => void;
};

export default function TradingConfirmModal({
  open,
  title,
  description,
  details = [],
  confirmText,
  cancelText,
  suppressLabel,
  suppressChecked = false,
  danger = false,
  loading = false,
  error,
  onCancel,
  onConfirm,
  onSuppressChange,
}: TradingConfirmModalProps) {
  const { t } = useLocaleContext();

  useEffect(() => {
    if (!open) return undefined;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || loading) return;
      onCancel();
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [loading, onCancel, open]);

  if (!open) return null;

  const confirmClassName = danger
    ? 'bg-[#f6465d] text-white hover:bg-[#ff5c70]'
    : 'bg-[#f0b90b] text-black hover:bg-[#f8c945]';
  const resolvedCancelText = cancelText ?? t('cancel', 'common');
  const resolvedSuppressLabel = suppressLabel ?? t('suppressTradingConfirm', 'common');

  function handleBackdropClick(event: MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget || loading) return;
    onCancel();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-3 backdrop-blur-sm sm:items-center"
      onMouseDown={handleBackdropClick}
      role="dialog"
      aria-modal="true"
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-white/10 bg-[#111820] text-white shadow-2xl">
        <div className="border-b border-white/10 px-4 py-3">
          <div className="text-[16px] font-semibold">{title}</div>
          <div className="mt-1 text-[12px] leading-5 text-white/55">{description}</div>
        </div>

        {details.length > 0 ? (
          <div className="space-y-2 px-4 py-3">
            {details.map((item) => (
              <div key={item.label} className="flex items-center justify-between gap-4 text-[12px]">
                <span className="shrink-0 text-white/42">{item.label}</span>
                <span className="min-w-0 truncate text-right font-mono text-white/86">{item.value}</span>
              </div>
            ))}
          </div>
        ) : null}

        <div className="border-t border-white/10 bg-black/10 px-4 py-3">
          {error ? (
            <div className="mb-3 rounded-lg border border-[#f6465d]/25 bg-[#f6465d]/10 px-3 py-2 text-[12px] leading-5 text-[#ff7a8c]">
              {error}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            {onSuppressChange ? (
              <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-white/55">
                <input
                  type="checkbox"
                  checked={suppressChecked}
                  onChange={(event) => onSuppressChange(event.target.checked)}
                  className="h-3.5 w-3.5 accent-[#f0b90b]"
                  disabled={loading}
                />
                {resolvedSuppressLabel}
              </label>
            ) : (
              <span />
            )}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={loading}
                onClick={onCancel}
                className="h-9 rounded-md border border-white/10 px-4 text-[12px] font-semibold text-white/70 transition-colors hover:border-white/25 hover:text-white disabled:cursor-not-allowed disabled:opacity-45"
              >
                {resolvedCancelText}
              </button>
              <button
                type="button"
                disabled={loading}
                onClick={onConfirm}
                className={`h-9 rounded-md px-4 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${confirmClassName}`}
              >
                {loading ? t('processing', 'common') : confirmText}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
