"use client";

import { useLocaleContext } from "@/contexts/LocaleContext";

type AffiliateHeroProps = {
  loading?: boolean;
  onApply: () => void;
};

export default function AffiliateHero({ loading, onApply }: AffiliateHeroProps) {
  const { t } = useLocaleContext();

  return (
    <section className="relative overflow-hidden rounded-[2rem] border border-[#f0b90b]/20 bg-[#090b10] p-6 shadow-2xl shadow-black/30 md:p-8">
      <div className="absolute -right-24 -top-28 h-72 w-72 rounded-full bg-[#f0b90b]/20 blur-3xl" />
      <div className="absolute bottom-0 left-1/3 h-48 w-48 rounded-full bg-cyan-400/10 blur-3xl" />
      <div className="relative grid gap-8 lg:grid-cols-[1.15fr_0.85fr] lg:items-center">
        <div>
          <div className="inline-flex rounded-full border border-[#f0b90b]/25 bg-[#f0b90b]/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-[#f0b90b]">
            {t("affiliateHeroEyebrow", "user")}
          </div>
          <h1 className="mt-5 max-w-3xl text-4xl font-black leading-tight text-white md:text-6xl">
            {t("affiliateHeroTitle", "user")}
            <span className="block text-[#f0b90b]">{t("affiliateHeroHighlight", "user")}</span>
          </h1>
          <p className="mt-5 max-w-2xl text-sm leading-7 text-white/62 md:text-base">
            {t("affiliateHeroDesc", "user")}
          </p>

          <div className="mt-7 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={onApply}
              disabled={loading}
              className="rounded-2xl bg-[#f0b90b] px-6 py-3 text-sm font-bold text-black transition hover:bg-[#ffd55a] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t("affiliateActionApply", "user")}
            </button>
            <a
              href="#affiliate-calculator"
              className="rounded-2xl border border-white/12 bg-white/[0.04] px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/[0.08]"
            >
              {t("affiliateActionCalculate", "user")}
            </a>
          </div>
        </div>

        <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.045] p-5 backdrop-blur">
          <div className="text-sm text-white/50">{t("affiliateRightsTitle", "user")}</div>
          <div className="mt-4 grid gap-3">
            <InfoRow label={t("affiliateRightLevel", "user")} value="BD1 / BD2 / BD3" />
            <InfoRow label={t("affiliateRightRate", "user")} value={t("affiliateRightRateValue", "user")} highlight />
            <InfoRow label={t("affiliateRightPayout", "user")} value={t("affiliateRightPayoutValue", "user")} />
            <InfoRow label={t("affiliateRightTools", "user")} value={t("affiliateRightToolsValue", "user")} />
            <p className="pt-2 text-xs leading-6 text-white/45">
              {t("affiliateRightDesc", "user")}
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function InfoRow({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl bg-black/25 px-4 py-3">
      <span className="text-sm text-white/48">{label}</span>
      <span className={`text-right text-sm font-semibold ${highlight ? "text-[#f0b90b]" : "text-white"}`}>
        {value}
      </span>
    </div>
  );
}
