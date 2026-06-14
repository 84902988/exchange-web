'use client';

import { useLocaleContext } from "@/contexts/LocaleContext";
import type { AssetTotals, MyBdTeamOverview } from "@/lib/api/modules/bd";

type BdStatsCardsProps = {
  data: MyBdTeamOverview;
};

type CardKey =
  | "bound_user_count"
  | "total_commission_by_asset"
  | "pending_commission_by_asset"
  | "paid_commission_by_asset"
  | "paid_amounts_by_asset";

type AssetCardKey = Exclude<CardKey, "bound_user_count">;

const ASSET_ORDER = ["RCB", "USDT"] as const;

type AssetTotalLine = {
  symbol: string;
  value: string;
};

const cards: Array<{
  key: CardKey;
  labelKey: string;
  hintKey: string;
}> = [
  {
    key: "bound_user_count",
    labelKey: "bdStatsTeamUsers",
    hintKey: "bdStatsTeamUsersHint",
  },
  {
    key: "total_commission_by_asset",
    labelKey: "bdStatsTotalCommission",
    hintKey: "bdStatsTotalCommissionHint",
  },
  {
    key: "pending_commission_by_asset",
    labelKey: "bdStatsPendingCommission",
    hintKey: "bdStatsPendingCommissionHint",
  },
  {
    key: "paid_commission_by_asset",
    labelKey: "bdStatsPaidCommission",
    hintKey: "bdStatsPaidCommissionHint",
  },
  {
    key: "paid_amounts_by_asset",
    labelKey: "bdStatsPaidAmounts",
    hintKey: "bdStatsPaidAmountsHint",
  },
];

function formatAmount(value: string | number | null | undefined): string {
  const amount = Number(value || 0);
  return Number.isFinite(amount) ? amount.toFixed(2) : "0.00";
}

function getAssetAmount(totals: AssetTotals, symbol: string): string | undefined {
  return totals[symbol] ?? totals[symbol.toUpperCase()] ?? totals[symbol.toLowerCase()];
}

function formatAssetTotals(totals?: AssetTotals | null): AssetTotalLine[] {
  const assetTotals = totals && typeof totals === "object" ? totals : {};

  const orderedSymbols = [
    ...ASSET_ORDER,
    ...Object.keys(assetTotals)
      .map((symbol) => symbol.toUpperCase())
      .filter((symbol) => !ASSET_ORDER.includes(symbol as (typeof ASSET_ORDER)[number])),
  ];

  return orderedSymbols.map((symbol) => ({
    symbol,
    value: formatAmount(getAssetAmount(assetTotals, symbol)),
  }));
}

export default function BdStatsCards({ data }: BdStatsCardsProps) {
  const { t } = useLocaleContext();

  return (
    <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
      {cards.map((card) => {
        const isCountCard = card.key === "bound_user_count";
        const countValue = String(data.summary.bound_user_count ?? 0);
        const assetLines = isCountCard
          ? []
          : formatAssetTotals(data.summary[card.key as AssetCardKey]);

        return (
          <div
            key={card.key}
            className="group rounded-[1.35rem] border border-white/10 bg-[#0d1118] p-5 transition hover:-translate-y-0.5 hover:border-[#f0b90b]/30 hover:bg-[#111721]"
          >
            <div className="text-sm text-white/45">{t(card.labelKey, 'user')}</div>
            <div
              className={
                isCountCard
                  ? "mt-3 whitespace-nowrap text-2xl font-black tabular-nums text-white"
                  : "mt-3 min-w-0 space-y-1 text-lg font-black leading-tight tabular-nums text-white"
              }
            >
              {isCountCard
                ? countValue
                : assetLines.map((line) => (
                    <span key={line.symbol} className="block break-words">
                      {line.value} {line.symbol}
                    </span>
                  ))}
            </div>
            <div className="mt-2 text-xs leading-5 text-white/35">{t(card.hintKey, 'user')}</div>
          </div>
        );
      })}
    </section>
  );
}
