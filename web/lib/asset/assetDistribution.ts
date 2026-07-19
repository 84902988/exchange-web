import type { SpotMarketTickerItem } from "../api/modules/spot";


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

function positiveFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : null;
}

function tickerAssetSymbol(ticker: SpotMarketTickerItem): string {
  const baseAsset = String(ticker.base_asset || "").trim().toUpperCase();
  if (baseAsset) return baseAsset;

  const symbol = String(ticker.symbol || "").trim().toUpperCase();
  return symbol.endsWith("USDT") ? symbol.slice(0, -4) : symbol;
}

function tickerLastPrice(ticker: SpotMarketTickerItem): number | null {
  return positiveFiniteNumber(
    ticker.last_price ?? ticker.price ?? ticker.last ?? ticker.close,
  );
}

export function buildAssetValuationDistribution(
  assets: AssetValuationInput[],
  tickers: SpotMarketTickerItem[],
): AssetValuationDistributionItem[] {
  const priceByAsset = new Map<string, number>();
  for (const ticker of tickers) {
    const assetSymbol = tickerAssetSymbol(ticker);
    const price = tickerLastPrice(ticker);
    if (assetSymbol && price !== null) {
      priceByAsset.set(assetSymbol, price);
    }
  }

  const valuations = assets.map((asset) => {
    const symbol = String(asset.symbol || "").trim().toUpperCase();
    const amount = Number.isFinite(asset.total) && asset.total > 0 ? asset.total : 0;
    const price = symbol === "USDT" ? 1 : priceByAsset.get(symbol) ?? null;
    return {
      symbol,
      amount,
      precision: asset.displayPrecision,
      usdtValue: price === null ? null : amount * price,
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
