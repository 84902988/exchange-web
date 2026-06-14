"use client";

import AffiliateActions from "@/components/affiliate/AffiliateActions";
import { useLocaleContext } from "@/contexts/LocaleContext";

const levelCards = [
  {
    level: "BD1",
    rate: "30%",
    titleKey: "affiliateLevelPersonalTitle",
    descKey: "affiliateLevelPersonalDesc",
  },
  {
    level: "BD2",
    rate: "40%",
    titleKey: "affiliateLevelTeamTitle",
    descKey: "affiliateLevelTeamDesc",
  },
  {
    level: "BD3",
    rate: "50%",
    titleKey: "affiliateLevelInstitutionTitle",
    descKey: "affiliateLevelInstitutionDesc",
  },
];

const benefitCards = [
  {
    titleKey: "affiliateBenefitPublicTitle",
    descKey: "affiliateBenefitPublicDesc",
  },
  {
    titleKey: "affiliateBenefitCommissionTitle",
    descKey: "affiliateBenefitCommissionDesc",
  },
  {
    titleKey: "affiliateBenefitReviewTitle",
    descKey: "affiliateBenefitReviewDesc",
  },
];

const flowKeys = [
  "affiliateFlowLearn",
  "affiliateFlowLogin",
  "affiliateFlowSubmit",
  "affiliateFlowApprove",
];

export default function AffiliatePage() {
  const { t } = useLocaleContext();

  return (
    <main className="min-h-screen overflow-hidden bg-[#05070b] text-white">
      <div className="relative px-4 py-8 lg:px-8">
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(240,185,11,0.16),transparent_34%),radial-gradient(circle_at_16%_36%,rgba(34,211,238,0.1),transparent_30%)]" />
        <div className="relative mx-auto max-w-7xl space-y-6">
          <section className="relative overflow-hidden rounded-[2rem] border border-[#f0b90b]/20 bg-[#090b10] p-6 shadow-2xl shadow-black/30 md:p-10">
            <div className="absolute -right-24 -top-28 h-72 w-72 rounded-full bg-[#f0b90b]/20 blur-3xl" />
            <div className="absolute bottom-0 left-1/3 h-48 w-48 rounded-full bg-cyan-400/10 blur-3xl" />
            <div className="relative max-w-3xl">
              <div className="inline-flex rounded-full border border-[#f0b90b]/25 bg-[#f0b90b]/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.24em] text-[#f0b90b]">
                BD Agency
              </div>
              <h1 className="mt-5 text-4xl font-black leading-tight md:text-6xl">
                {t("affiliatePageTitle", "user")}
                <span className="block text-[#f0b90b]">{t("affiliatePageHighlight", "user")}</span>
              </h1>
              <p className="mt-5 max-w-2xl text-sm leading-7 text-white/62 md:text-base">
                {t("affiliatePageDesc", "user")}
              </p>
              <AffiliateActions />
            </div>
          </section>

          <section className="grid gap-4 md:grid-cols-3">
            {benefitCards.map((item) => (
              <div
                key={item.titleKey}
                className="rounded-[1.4rem] border border-white/10 bg-white/[0.035] p-5 backdrop-blur transition hover:border-[#f0b90b]/30 hover:bg-white/[0.055]"
              >
                <div className="text-lg font-bold text-white">{t(item.titleKey, "user")}</div>
                <p className="mt-3 text-sm leading-7 text-white/52">{t(item.descKey, "user")}</p>
              </div>
            ))}
          </section>

          <section className="rounded-[1.8rem] border border-white/10 bg-[#0d1118] p-6 md:p-8">
            <div>
              <div className="text-sm font-semibold uppercase tracking-[0.22em] text-[#f0b90b]">
                Agency Level
              </div>
              <h2 className="mt-3 text-3xl font-black text-white">{t("affiliateLevelSectionTitle", "user")}</h2>
              <p className="mt-3 max-w-2xl text-sm leading-7 text-white/55">
                {t("affiliateLevelSectionDesc", "user")}
              </p>
            </div>

            <div className="mt-6 grid gap-4 md:grid-cols-3">
              {levelCards.map((item) => (
                <div
                  key={item.level}
                  className="rounded-[1.35rem] border border-white/10 bg-black/25 p-5 transition hover:border-[#f0b90b]/30"
                >
                  <div className="text-sm text-white/45">{t(item.titleKey, "user")}</div>
                  <div className="mt-3 flex items-end gap-3">
                    <div className="text-3xl font-black text-[#f0b90b]">{item.level}</div>
                    <div className="pb-1 text-sm font-semibold text-white/70">{item.rate} {t("affiliateCommissionSuffix", "user")}</div>
                  </div>
                  <p className="mt-3 text-sm leading-7 text-white/55">{t(item.descKey, "user")}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-[0.8fr_1.2fr]">
            <div className="rounded-[1.5rem] border border-[#f0b90b]/20 bg-[#f0b90b]/10 p-6">
              <div className="text-sm font-semibold uppercase tracking-[0.2em] text-[#f0b90b]">
                Deposit
              </div>
              <h2 className="mt-3 text-2xl font-bold text-white">{t("affiliateDepositTitle", "user")}</h2>
              <p className="mt-3 text-sm leading-7 text-[#f8d878]">
                {t("affiliateDepositDesc", "user")}
              </p>
            </div>

            <div className="rounded-[1.5rem] border border-white/10 bg-white/[0.035] p-6">
              <h2 className="text-2xl font-bold text-white">{t("affiliateFlowTitle", "user")}</h2>
              <div className="mt-5 grid gap-3 md:grid-cols-4">
                {flowKeys.map((key, index) => (
                  <div key={key} className="rounded-2xl border border-white/10 bg-black/25 p-4">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#f0b90b]/15 text-sm font-bold text-[#f0b90b]">
                      {index + 1}
                    </div>
                    <div className="mt-3 text-sm font-semibold text-white">{t(key, "user")}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
