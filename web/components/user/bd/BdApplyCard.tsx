'use client';

import { useLocaleContext } from "@/contexts/LocaleContext";
import type { BdApplication } from "@/lib/api/modules/bd";

type BdApplyCardProps = {
  application: BdApplication | null;
  applyLevel: string;
  depositCoinSymbol: string;
  depositAmount: string;
  remark: string;
  submitting: boolean;
  message: string;
  error: string;
  onApplyLevelChange: (value: string) => void;
  onDepositCoinSymbolChange: (value: string) => void;
  onDepositAmountChange: (value: string) => void;
  onRemarkChange: (value: string) => void;
  onSubmit: () => void;
};

const statusClass: Record<string, string> = {
  PENDING: "border-amber-300/20 bg-amber-300/10 text-amber-200",
  APPROVED: "border-emerald-300/20 bg-emerald-300/10 text-emerald-200",
  REJECTED: "border-red-300/20 bg-red-300/10 text-red-200",
  CANCELED: "border-white/10 bg-white/5 text-white/50",
};

const levelOptions = [
  {
    value: "BD1",
    title: "BD1",
    descKey: "bdLevelBd1Desc",
  },
  {
    value: "BD2",
    title: "BD2",
    descKey: "bdLevelBd2Desc",
  },
  {
    value: "BD3",
    title: "BD3",
    descKey: "bdLevelBd3Desc",
  },
];

const statusLabelKeys: Record<string, string> = {
  PENDING: "bdStatusPending",
  APPROVED: "bdStatusApproved",
  REJECTED: "bdStatusRejected",
  CANCELED: "bdStatusCanceled",
};

const statusHintKeys: Record<string, string> = {
  PENDING: "bdStatusPendingHint",
  APPROVED: "bdStatusApprovedHint",
  REJECTED: "bdStatusRejectedHint",
  CANCELED: "bdStatusCanceledHint",
};

export default function BdApplyCard({
  application,
  applyLevel,
  depositCoinSymbol,
  depositAmount,
  remark,
  submitting,
  message,
  error,
  onApplyLevelChange,
  onDepositCoinSymbolChange,
  onDepositAmountChange,
  onRemarkChange,
  onSubmit,
}: BdApplyCardProps) {
  const { t } = useLocaleContext();
  const normalizedStatus = (application?.status || "").toUpperCase();
  const hasPending = normalizedStatus === "PENDING";

  return (
    <section id="bd-apply" className="grid gap-5 lg:grid-cols-[0.95fr_1.05fr]">
      <div className="rounded-[1.5rem] border border-white/10 bg-[#0d1118] p-6">
        <div className="text-sm font-semibold uppercase tracking-[0.2em] text-[#f0b90b]">
          {t('bdApplyEyebrow', 'user')}
        </div>
        <h2 className="mt-3 text-2xl font-bold text-white">{t('bdApplyTitle', 'user')}</h2>
        <p className="mt-3 text-sm leading-7 text-white/55">
          {t('bdApplyDesc', 'user')}
        </p>

        <div className="mt-6 grid gap-3">
          {['bdApplyStepSubmit', 'bdApplyStepReview', 'bdApplyStepDeposit', 'bdApplyStepActivate'].map((labelKey, index) => (
            <div key={labelKey} className="flex items-center gap-3 rounded-2xl bg-white/[0.035] p-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-[#f0b90b]/15 text-sm font-bold text-[#f0b90b]">
                {index + 1}
              </span>
              <span className="text-sm text-white/70">{t(labelKey, 'user')}</span>
            </div>
          ))}
        </div>

        {application ? (
          <div className="mt-6 rounded-2xl border border-white/10 bg-black/25 p-4">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-white/50">{t('bdRecentApplyStatus', 'user')}</span>
              <span
                className={`rounded-full border px-3 py-1 text-xs ${
                  statusClass[normalizedStatus] || "border-white/10 bg-white/5 text-white/60"
                }`}
              >
                {statusLabelKeys[normalizedStatus] ? t(statusLabelKeys[normalizedStatus], 'user') : normalizedStatus}
              </span>
            </div>
            <div className="mt-3 text-[14px] font-medium tabular-nums text-white/70">
              {application.apply_level} / {application.deposit_amount} {application.deposit_coin_symbol}
            </div>
            {statusHintKeys[normalizedStatus] ? (
              <div className="mt-3 rounded-2xl border border-white/10 bg-white/[0.035] px-4 py-3 text-xs leading-6 text-white/55">
                {t(statusHintKeys[normalizedStatus], 'user')}
              </div>
            ) : null}
            {application.admin_remark ? (
              <div className="mt-2 text-xs text-white/45">{t('bdReviewRemark', 'user')}: {application.admin_remark}</div>
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="rounded-[1.5rem] border border-[#f0b90b]/15 bg-gradient-to-br from-[#f0b90b]/10 to-white/[0.03] p-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="block sm:col-span-2">
            <span className="text-sm text-white/55">{t('bdSelectLevel', 'user')}</span>
            <div className="mt-2 grid gap-3 lg:grid-cols-3">
              {levelOptions.map((level) => {
                const selected = applyLevel === level.value;
                return (
                  <button
                    key={level.value}
                    type="button"
                    disabled={submitting || hasPending}
                    onClick={() => onApplyLevelChange(level.value)}
                    className={`rounded-2xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-55 ${
                      selected
                        ? "border-[#f0b90b]/70 bg-[#f0b90b]/15"
                        : "border-white/10 bg-black/25 hover:border-[#f0b90b]/35 hover:bg-white/[0.04]"
                    }`}
                  >
                    <div className="text-[20px] font-semibold tabular-nums text-white">{level.title}</div>
                    <div className="mt-2 text-xs leading-5 text-white/48">{t(level.descKey, 'user')}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <label className="block">
            <span className="text-sm text-white/55">{t('bdDepositCoin', 'user')}</span>
            <select
              value={depositCoinSymbol}
              disabled={submitting || hasPending}
              onChange={(event) => onDepositCoinSymbolChange(event.target.value)}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none focus:border-[#f0b90b]/60"
            >
              <option value="USDT">USDT</option>
              <option value="RCB">RCB</option>
            </select>
          </label>

          <label className="block">
            <span className="text-sm text-white/55">{t('bdEstimatedDeposit', 'user')}</span>
            <input
              value={depositAmount}
              disabled={submitting || hasPending}
              onChange={(event) => onDepositAmountChange(event.target.value)}
              inputMode="decimal"
              placeholder={t('bdDepositAmountPlaceholder', 'user')}
              className="mt-2 w-full rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-[14px] font-medium tabular-nums text-white outline-none placeholder:text-white/25 focus:border-[#f0b90b]/60"
            />
          </label>

          <div className="rounded-2xl border border-[#f0b90b]/15 bg-[#f0b90b]/10 p-4 text-xs leading-6 text-[#f8d878] sm:col-span-2">
            {t('bdDepositNotice', 'user')}
          </div>

          <label className="block sm:col-span-2">
            <span className="text-sm text-white/55">{t('bdApplyRemark', 'user')}</span>
            <textarea
              value={remark}
              disabled={submitting || hasPending}
              onChange={(event) => onRemarkChange(event.target.value)}
              rows={4}
              placeholder={t('bdApplyRemarkPlaceholder', 'user')}
              className="mt-2 w-full resize-none rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-[#f0b90b]/60"
            />
          </label>
        </div>

        <button
          type="button"
          disabled={submitting || hasPending}
          onClick={onSubmit}
          className="mt-5 w-full rounded-2xl bg-[#f0b90b] px-5 py-3 text-sm font-bold text-black transition hover:bg-[#ffd55a] disabled:cursor-not-allowed disabled:opacity-55"
        >
          {hasPending ? t('bdApplyPendingButton', 'user') : submitting ? t('submitting', 'common') : t('bdSubmitApply', 'user')}
        </button>

        {message ? <div className="mt-3 text-sm text-emerald-300">{message}</div> : null}
        {error ? <div className="mt-3 text-sm text-red-300">{error}</div> : null}
      </div>
    </section>
  );
}
