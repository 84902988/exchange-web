import { describe, expect, it } from "@jest/globals";

import { buildAssetValuationDistribution } from "./assetDistribution";


const assets = [
  { symbol: "USDT", total: 100, displayPrecision: 2 },
  { symbol: "BTC", total: 0.01, displayPrecision: 6 },
];


describe("buildAssetValuationDistribution", () => {
  it("calculates distribution from USDT valuation instead of asset quantity", () => {
    const result = buildAssetValuationDistribution(assets, [
      { symbol: "BTCUSDT", last_price: "10000" },
    ]);

    expect(result.map((item) => item.percent)).toEqual([50, 50]);
    expect(result.map((item) => item.usdtValue)).toEqual([100, 100]);
  });

  it("fails the whole distribution closed when a held asset has no price", () => {
    const result = buildAssetValuationDistribution(assets, []);

    expect(result).toHaveLength(2);
    expect(result.map((item) => item.percent)).toEqual([null, null]);
    expect(result.map((item) => item.usdtValue)).toEqual([100, null]);
  });

  it.each(["0", "-1", "invalid"])(
    "rejects an invalid ticker price of %s",
    (lastPrice) => {
      const result = buildAssetValuationDistribution(assets, [
        { symbol: "BTCUSDT", last_price: lastPrice },
      ]);

      expect(result.map((item) => item.percent)).toEqual([null, null]);
    },
  );

  it("uses base_asset metadata when the provider symbol is not a plain USDT pair", () => {
    const result = buildAssetValuationDistribution(assets, [
      { symbol: "provider-btc", base_asset: "btc", price: 10000 },
    ]);

    expect(result.map((item) => item.percent)).toEqual([50, 50]);
  });

  it("reports a USDT-only portfolio as one hundred percent", () => {
    const result = buildAssetValuationDistribution([assets[0]], []);

    expect(result[0].percent).toBe(100);
  });
});
