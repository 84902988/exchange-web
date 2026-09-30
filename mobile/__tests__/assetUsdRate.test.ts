import {normalizeAssetUsdRate, usdtToUsd} from '../src/services/assetUsdRate';
import {calculateAssetSnapshot} from '../src/services/assetSnapshot';

const now = 1_800_000_000_000;
const payload = {base: 'USDT', quote: 'USD', rate: 0.99982, as_of: now - 4000, stale: false};

it('uses the real conversion for the total, each account and each coin without changing balances', () => {
  const rate = normalizeAssetUsdRate(payload, now)!;
  const result = calculateAssetSnapshot({userId: 1, fetchedAt: now, pricesUsdt: {TOKEN: 2}, usdRate: rate,
    balances: [{accountKey: 'spot', symbol: 'TOKEN', available: 90, frozen: 2}]});
  expect(result.totalUsdt).toBe(184);
  expect(result.totalUsd).toBeCloseTo(183.96688, 8);
  expect(result.accounts[0].totalUsd).toEqual(result.totalUsd);
  expect(result.rows[0].valueUsd).toEqual(result.totalUsd);
  expect(result.rows[0].available).toBe(90);
  expect(result.usdValuationComplete).toBe(true);
});

it.each([{stale: true}, {quote: 'USDC'}, {rate: 0}, {rate: Infinity}, {as_of: now - 121_000}, {as_of: now + 31_000}])('rejects unavailable or expired rates %j', patch => {
  expect(normalizeAssetUsdRate({...payload, ...patch}, now)).toBeNull();
});

it('does not substitute 1:1 when USD data is missing', () => {
  expect(usdtToUsd(100, null)).toBeNull();
  const result = calculateAssetSnapshot({userId: 1, fetchedAt: now, pricesUsdt: {},
    balances: [{accountKey: 'funding', symbol: 'USDT', available: 100, frozen: 0}]});
  expect(result.totalUsdt).toBe(100);
  expect(result.totalUsd).toBeNull();
  expect(result.usdValuationComplete).toBe(false);
});
