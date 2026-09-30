import {expect, it} from '@jest/globals';
import {normalizeUsdValuationRate, toUsd} from './usdValuationRate';

const now = 1_800_000_000_000;
const payload = {base: 'USDT', quote: 'USD', rate: 0.99982, as_of: now - 4000, stale: false};

it('converts portfolio values using the live rate, without a fixed fallback', () => {
  expect(toUsd(184, normalizeUsdValuationRate(payload, now))).toBeCloseTo(183.96688, 8);
  expect(toUsd(184, null)).toBeNull();
});

it.each([{stale: true}, {quote: 'USDC'}, {rate: 0}, {rate: Infinity}, {as_of: now - 121_000}, {as_of: now + 31_000}])('rejects unavailable or expired rates %j', patch => {
  expect(normalizeUsdValuationRate({...payload, ...patch}, now)).toBeNull();
});
