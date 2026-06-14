"use client";

import { useLocaleContext } from "@/contexts/LocaleContext";

type AffiliateCtaProps = {
  loading?: boolean;
  onApply: () => void;
};

export default function AffiliateCta({ loading, onApply }: AffiliateCtaProps) {
  const { t } = useLocaleContext();

  return (
    <section className="relative overflow-hidden rounded-[2rem] border border-[#f0b90b]/25 bg-[#f0b90b] p-6 text-black md:p-8">
      <div className="absolute -right-20 -top-24 h-72 w-72 rounded-full bg-white/35 blur-3xl" />
      <div className="relative flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
        <div>
          <div className="text-sm font-bold uppercase tracking-[0.22em] text-black/55">
            Start Now
          </div>
          <h2 className="mt-2 text-3xl font-black md:text-4xl">{t("affiliateCtaTitle", "user")}</h2>
          <p className="mt-3 max-w-2xl text-sm leading-7 text-black/65">
            {t("affiliateCtaDesc", "user")}
          </p>
        </div>
        <button
          type="button"
          onClick={onApply}
          disabled={loading}
          className="rounded-2xl bg-black px-6 py-3 text-sm font-bold text-white transition hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {t("affiliateActionApply", "user")}
        </button>
      </div>
    </section>
  );
}
