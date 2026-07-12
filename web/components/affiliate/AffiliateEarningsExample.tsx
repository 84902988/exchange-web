"use client";

import { useLocaleContext } from "@/contexts/LocaleContext";

type AffiliateEarningsExampleProps = {
  loading?: boolean;
  onApply: () => void;
};

const rows = [
  ["affiliateExampleUsers", "10"],
  ["affiliateExampleDailyFee", "100 USDT"],
  ["affiliateExampleLevel", "BD2"],
  ["affiliateExampleRate", "40%"],
];

export default function AffiliateEarningsExample({
  loading,
  onApply,
}: AffiliateEarningsExampleProps) {
  const { t } = useLocaleContext();

  return (
    <section className="rounded-[1.8rem] border border-[#f0b90b]/20 bg-gradient-to-br from-[#f0b90b]/12 via-white/[0.04] to-white/[0.02] p-6 md:p-8">
      <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
        <div>
          <div className="text-sm font-semibold uppercase tracking-[0.22em] text-[#f0b90b]">
            Earnings Example
          </div>
          <h2 className="mt-3 text-3xl font-black text-white">{t("affiliateExampleTitle", "user")}</h2>
          <p className="mt-3 text-sm leading-7 text-white/58">
            {t("affiliateExampleDesc", "user")}
          </p>
          <button
            type="button"
            onClick={onApply}
            disabled={loading}
            className="mt-6 rounded-2xl bg-[#f0b90b] px-5 py-3 text-sm font-bold text-black transition hover:bg-[#ffd55a] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {t("affiliateActionApply", "user")}
          </button>
        </div>

        <div className="rounded-[1.5rem] border border-white/10 bg-black/25 p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            {rows.map(([labelKey, value]) => (
              <div key={labelKey} className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
                <div className="text-xs text-white/42">{t(labelKey, "user")}</div>
                <div className="mt-2 text-[20px] font-semibold tabular-nums text-white">{value}</div>
              </div>
            ))}
          </div>
          <div className="mt-4 rounded-2xl border border-[#f0b90b]/25 bg-[#f0b90b]/12 p-5">
            <div className="text-sm text-[#f8d878]">{t("affiliateExampleDailyCommission", "user")}</div>
            <div className="mt-2 text-[30px] font-bold tabular-nums text-[#f0b90b]">400 USDT</div>
          </div>
        </div>
      </div>
    </section>
  );
}
