"use client";

import { useMemo, useState } from "react";

import { useLocaleContext } from "@/contexts/LocaleContext";

const rateMap = {
  BD1: 0.3,
  BD2: 0.4,
  BD3: 0.5,
} as const;

type Level = keyof typeof rateMap;

function formatAmount(value: number) {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  });
}

export default function AffiliateCalculator() {
  const { t } = useLocaleContext();
  const [userCount, setUserCount] = useState("10");
  const [dailyFee, setDailyFee] = useState("100");
  const [level, setLevel] = useState<Level>("BD2");

  const result = useMemo(() => {
    const users = Math.max(Number(userCount) || 0, 0);
    const fee = Math.max(Number(dailyFee) || 0, 0);
    const daily = users * fee * rateMap[level];
    return {
      daily,
      monthly: daily * 30,
      yearly: daily * 365,
      rate: rateMap[level] * 100,
    };
  }, [dailyFee, level, userCount]);

  return (
    <section id="affiliate-calculator" className="rounded-[1.8rem] border border-white/10 bg-[#0d1118] p-6 md:p-8">
      <div className="grid gap-8 lg:grid-cols-[0.9fr_1.1fr]">
        <div>
          <div className="text-sm font-semibold uppercase tracking-[0.22em] text-[#f0b90b]">
            Calculator
          </div>
          <h2 className="mt-3 text-3xl font-black text-white">{t("affiliateCalculatorTitle", "user")}</h2>
          <p className="mt-3 text-sm leading-7 text-white/55">
            {t("affiliateCalculatorDesc", "user")}
          </p>

          <div className="mt-6 grid gap-4">
            <label className="block">
              <span className="text-sm text-white/55">{t("affiliateCalculatorUsers", "user")}</span>
              <input
                value={userCount}
                onChange={(event) => setUserCount(event.target.value)}
                inputMode="numeric"
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-[#f0b90b]/60"
              />
            </label>

            <label className="block">
              <span className="text-sm text-white/55">{t("affiliateCalculatorDailyFee", "user")}</span>
              <input
                value={dailyFee}
                onChange={(event) => setDailyFee(event.target.value)}
                inputMode="decimal"
                className="mt-2 w-full rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none placeholder:text-white/25 focus:border-[#f0b90b]/60"
              />
            </label>

            <div>
              <span className="text-sm text-white/55">{t("affiliateCalculatorLevel", "user")}</span>
              <div className="mt-2 grid grid-cols-3 gap-3">
                {(Object.keys(rateMap) as Level[]).map((item) => (
                  <button
                    key={item}
                    type="button"
                    onClick={() => setLevel(item)}
                    className={`rounded-2xl border px-4 py-3 text-sm font-bold transition ${
                      level === item
                        ? "border-[#f0b90b]/70 bg-[#f0b90b]/15 text-[#f0b90b]"
                        : "border-white/10 bg-black/25 text-white/75 hover:border-[#f0b90b]/35"
                    }`}
                  >
                    {item}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="grid gap-4">
          <ResultCard label={t("affiliateCalculatorRate", "user")} value={`${result.rate}%`} />
          <ResultCard label={t("affiliateCalculatorDailyCommission", "user")} value={`${formatAmount(result.daily)} USDT`} highlight />
          <ResultCard label={t("affiliateCalculatorMonthlyCommission", "user")} value={`${formatAmount(result.monthly)} USDT`} />
          <ResultCard label={t("affiliateCalculatorYearlyCommission", "user")} value={`${formatAmount(result.yearly)} USDT`} />
        </div>
      </div>
    </section>
  );
}

function ResultCard({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div className={`rounded-[1.35rem] border p-5 ${highlight ? "border-[#f0b90b]/25 bg-[#f0b90b]/12" : "border-white/10 bg-black/25"}`}>
      <div className="text-sm text-white/45">{label}</div>
      <div className={`mt-3 text-3xl font-black tabular-nums ${highlight ? "text-[#f0b90b]" : "text-white"}`}>
        {value}
      </div>
    </div>
  );
}
