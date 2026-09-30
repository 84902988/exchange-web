import type { SpotMarketTickerItem } from "../api/modules/spot";
import {assetPrices} from "./portfolioValuation";


export type AssetValuationInput = {
  symbol: string;
  total: number;
  displayPrecision: number;
};

export type AssetValuationDistributionItem = {
  symbol: string;
  amount: number;
  precision: number;
  usdtValue: number | null;
  percent: number | null;
};

export function buildAssetValuationDistribution(
  assets: AssetValuationInput[],
  tickers: SpotMarketTickerItem[],
): AssetValuationDistributionItem[] {
  const priceByAsset = assetPrices(tickers);

  const valuations = assets.map((asset) => {
    const symbol = String(asset.symbol || "").trim().toUpperCase();
    const amount = Number.isFinite(asset.total) && asset.total > 0 ? asset.total : 0;
    const price = symbol === "USDT" ? 1 : priceByAsset.get(symbol) ?? null;
    return {
      symbol,
      amount,
      precision: asset.displayPrecision,
      usdtValue: amount === 0 ? 0 : price === null || !Number.isFinite(amount * price) ? null : amount * price,
    };
  });

  const hasMissingValuation = valuations.some((item) => item.usdtValue === null);
  const valueTotal = hasMissingValuation
    ? null
    : valuations.reduce((sum, item) => sum + (item.usdtValue || 0), 0);

  return valuations.map(({ symbol, amount, precision, usdtValue }) => ({
    symbol,
    amount,
    precision,
    usdtValue,
    percent:
      valueTotal !== null && valueTotal > 0 && usdtValue !== null
        ? (usdtValue / valueTotal) * 100
        : null,
  }));
}
