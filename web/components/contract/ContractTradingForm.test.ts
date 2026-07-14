import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  calculateContractSliderAmount,
  formatContractAmountOnBlur,
  isPositiveContractAmountAtPrecision,
  normalizeContractAmountPrecision,
  normalizeContractDecimalInput,
} from './contractTradingForm.utils';
import {
  buildContractTradingFormLegacyMarketRead,
  getContractTradingFormMarketDifferences,
  resolveContractTradingFormMarketRead,
  resolveContractTradingFormMarketState,
} from './ContractTradingFormMarketRead';

const formSource = readFileSync(
  resolve(process.cwd(), 'components/contract/ContractTradingForm.tsx'),
  'utf8',
);
const pageSource = readFileSync(
  resolve(process.cwd(), 'app/contract/page.tsx'),
  'utf8',
);

test('amount input remains editable while typing and rejects invalid characters', () => {
  for (const value of ['', '0', '0.1', '1.25', '1.', '.5']) {
    assert.equal(normalizeContractDecimalInput(value), value);
  }

  for (const value of ['1a', '1..2', '-1', '1 2', '1,2']) {
    assert.equal(normalizeContractDecimalInput(value), null);
  }
});

test('amount blur rounds to the configured symbol precision', () => {
  assert.equal(formatContractAmountOnBlur('1.23456', 3), '1.235');
  assert.equal(formatContractAmountOnBlur('1.', 3), '1.000');
  assert.equal(formatContractAmountOnBlur('1.6', 0), '2');
  assert.equal(formatContractAmountOnBlur('1.4', 0), '1');
  assert.equal(formatContractAmountOnBlur('.', 3), '');
  assert.equal(normalizeContractAmountPrecision(null), 6);
});

test('slider floors 25/50/75/100 percent quantities to amountPrecision', () => {
  const maximumQuantity = 0.493827;

  assert.equal(calculateContractSliderAmount(maximumQuantity, 25, 3), '0.123');
  assert.equal(calculateContractSliderAmount(maximumQuantity, 50, 3), '0.246');
  assert.equal(calculateContractSliderAmount(maximumQuantity, 75, 3), '0.370');
  assert.equal(calculateContractSliderAmount(maximumQuantity, 100, 3), '0.493');
  assert.equal(calculateContractSliderAmount(3.9, 50, 0), '1');
});

test('precision-adjusted zero remains non-submittable', () => {
  const adjustedAmount = calculateContractSliderAmount(0.001, 25, 3);

  assert.equal(adjustedAmount, '0.000');
  assert.equal(isPositiveContractAmountAtPrecision(adjustedAmount, 3), false);
  assert.equal(isPositiveContractAmountAtPrecision('0.001', 3), true);
});

test('TradingForm wires symbol amountPrecision without changing execution direction', () => {
  assert.match(pageSource, /amountPrecision=\{currentContractPair\?\.amountPrecision\}/);
  assert.match(formSource, /amountPrecision\?: number \| null;/);
  assert.match(formSource, /normalizeContractDecimalInput\(value\)/);
  assert.match(formSource, /formatContractAmountOnBlur\(quantity, safeAmountPrecision\)/);
  assert.match(formSource, /calculateContractSliderAmount\(maximumQuantity, percent, safeAmountPrecision\)/);

  assert.match(
    formSource,
    /closeSide === 'LONG' \? resolvedExecutionBid : resolvedExecutionAsk/,
  );
  assert.match(
    formSource,
    /positionSide === 'LONG' \? resolvedExecutionAsk : resolvedExecutionBid/,
  );
  assert.match(
    formSource,
    /const longOpenPrice = orderType === 'LIMIT' \? toNumber\(price\) : resolvedExecutionAsk;/,
  );
  assert.match(
    formSource,
    /const shortOpenPrice = orderType === 'LIMIT' \? toNumber\(price\) : resolvedExecutionBid;/,
  );
  assert.doesNotMatch(formSource, /currentActionExecutionPrice[^;]*(?:displayPrice|markPrice|chartClose)/);
});

test('TradingForm market read keeps display, mark, and index prices separate with Store priority', () => {
  const legacy = buildContractTradingFormLegacyMarketRead({
    quote: {
      last_price: '64000',
      mark_price: '63990',
      index_price: '63980',
      market_status: 'OPEN',
      executable: true,
      source: 'LEGACY_QUOTE',
      quote_freshness: 'LIVE',
    } as never,
    marketView: {
      display_price: '64000',
      display_price_source: 'TRADE_TICK',
      market_status: 'OPEN',
      display_state: 'LIVE_TRADABLE',
      executable: true,
      ticker_source: 'LEGACY_VIEW',
      ticker_freshness: 'LIVE',
      reason_code: 'LIVE_BBO',
    } as never,
  });
  const store = {
    symbol: 'BTCUSDT_PERP',
    displayPrice: '65000',
    displayPriceSource: 'KLINE_CLOSE',
    markPrice: '64990',
    indexPrice: '64980',
    marketStatus: 'OPEN',
    displayState: 'LIVE_TRADABLE',
    executable: true,
    reasonCode: 'LIVE_BBO',
    source: 'LIVE_WS',
    freshness: 'LIVE',
    provider: 'BINANCE_USDM',
    providerGeneration: 9,
    revision: null,
    stale: false,
    observedAtMs: 1_720_000_000_200,
  };

  const resolved = resolveContractTradingFormMarketRead(store, legacy);
  assert.equal(resolved.authority, 'STORE');
  assert.equal(resolved.displayPrice, '65000');
  assert.equal(resolved.markPrice, '64990');
  assert.equal(resolved.indexPrice, '64980');
  assert.deepEqual(
    getContractTradingFormMarketDifferences(store, legacy).map((item) => item.field),
    ['display_price', 'mark_price', 'index_price', 'source'],
  );
});

test('TradingForm falls back to legacy only when Store is missing', () => {
  const legacy = buildContractTradingFormLegacyMarketRead({
    quote: {
      last_price: '64000',
      mark_price: '63990',
      index_price: '63980',
      market_status: 'OPEN',
      executable: true,
    } as never,
  });

  assert.deepEqual(resolveContractTradingFormMarketRead(null, legacy), {
    ...legacy,
    authority: 'LEGACY_FALLBACK',
    symbol: null,
  });
});

test('TradingForm display state synchronizes closed market without replacing execution authority', () => {
  const legacy = buildContractTradingFormLegacyMarketRead({ quote: null });
  const displayRead = resolveContractTradingFormMarketRead({
    symbol: 'BTCUSDT_PERP',
    displayPrice: '64000',
    displayPriceSource: 'KLINE_CLOSE',
    markPrice: '63990',
    indexPrice: '63980',
    marketStatus: 'CLOSED',
    displayState: 'CLOSED',
    executable: false,
    reasonCode: 'NON_TRADING_SESSION',
    source: 'LIVE_WS',
    freshness: 'LIVE',
    provider: 'BINANCE_USDM',
    providerGeneration: 10,
    revision: null,
    stale: false,
    observedAtMs: 1_720_000_000_300,
  }, legacy);

  assert.equal(resolveContractTradingFormMarketState(displayRead), 'closed');
  assert.equal(resolveContractTradingFormMarketState({
    ...displayRead,
    marketStatus: 'OPEN',
    displayState: 'LIVE_TRADABLE',
    executable: true,
    stale: true,
  }), 'unavailable');
  assert.match(formSource, /const resolvedExecutionBid = marketViewAuthority\.executionBid \?\? 0;/);
  assert.match(formSource, /const resolvedExecutionAsk = marketViewAuthority\.executionAsk \?\? 0;/);
  assert.doesNotMatch(formSource, /resolvedExecution(?:Bid|Ask)\s*=\s*displayMarketRead/);
  assert.match(formSource, /\[contract-trading-form-market-diff\]/);
  assert.match(formSource, /data-display-price=\{displayMarketRead\.displayPrice/);
  assert.match(formSource, /data-mark-price=\{displayMarketRead\.markPrice/);
  assert.match(formSource, /data-index-price=\{displayMarketRead\.indexPrice/);
});
