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

test('TradingForm wires symbol amountPrecision', () => {
  assert.match(pageSource, /amountPrecision=\{currentContractPair\?\.amountPrecision\}/);
  assert.match(formSource, /amountPrecision\?: number \| null;/);
  assert.match(formSource, /normalizeContractDecimalInput\(value\)/);
  assert.match(formSource, /formatContractAmountOnBlur\(quantity, safeAmountPrecision\)/);
  assert.match(formSource, /calculateContractSliderAmount\(maximumQuantity, percent, safeAmountPrecision\)/);
});

test('page adds Price Authority without removing legacy Contract form inputs', () => {
  assert.match(pageSource, /priceAuthority,\s*\n\s*referencePrice,/);
  assert.match(pageSource, /<ContractTradingForm[\s\S]*?bestBid=\{hookBestBid\}/);
  assert.match(pageSource, /<ContractTradingForm[\s\S]*?executionBid=\{executionBid\}/);
  assert.match(pageSource, /<ContractTradingForm[\s\S]*?executionAsk=\{executionAsk\}/);
  assert.match(pageSource, /<ContractTradingForm[\s\S]*?priceAuthority=\{priceAuthority\}/);
  assert.match(formSource, /priceAuthority: ContractPriceAuthorityV1;/);
});

test('TradingForm resolves all four execution directions through Price Authority', () => {
  for (const intent of ['OPEN_LONG', 'OPEN_SHORT', 'CLOSE_LONG', 'CLOSE_SHORT']) {
    assert.match(formSource, new RegExp(`intent: '${intent}'`));
  }
  assert.match(
    formSource,
    /closeSide === 'LONG' \? executionPrices\.closeLong : executionPrices\.closeShort/,
  );
  assert.match(
    formSource,
    /positionSide === 'LONG' \? executionPrices\.openLong : executionPrices\.openShort/,
  );
  assert.match(formSource, /return currentActionExecution\.price;/);
});

test('MARKET and LIMIT crossing estimates use directional execution evidence', () => {
  assert.match(
    formSource,
    /if \(!currentActionExecution\.executable \|\| currentActionExecution\.price === null\)/,
  );
  assert.match(formSource, /if \(orderType === 'MARKET'\) \{\s*return currentActionExecution\.price;/);
  assert.match(formSource, /limitPriceNumber <= executionPrices\.closeLong\.price/);
  assert.match(formSource, /limitPriceNumber >= executionPrices\.closeShort\.price/);
  assert.match(formSource, /limitPriceNumber >= executionPrices\.openLong\.price/);
  assert.match(formSource, /limitPriceNumber <= executionPrices\.openShort\.price/);
});

test('BBO, execution validation, and MARKET margin reference fail closed', () => {
  assert.match(formSource, /const executionPriceMissing = !currentActionExecution\.executable/);
  assert.match(formSource, /bboDisabled=\{currentBboPrice\(\) === null\}/);
  assert.match(
    formSource,
    /const longOpenPrice = orderType === 'LIMIT' \? toNumber\(price\) : executionPrices\.openLong\.price \?\? 0;/,
  );
  assert.match(
    formSource,
    /const shortOpenPrice = orderType === 'LIMIT' \? toNumber\(price\) : executionPrices\.openShort\.price \?\? 0;/,
  );
  assert.match(formSource, /!execution\.executable \|\| execution\.price === null/);
  assert.doesNotMatch(formSource, /currentActionExecution[^;]*(?:display_price|mark_price|last_price)/);
});

test('TP/SL references remain outside Price Authority scope', () => {
  assert.match(formSource, /const quoteMarkPrice = toNumber\(quote\?\.mark_price\);/);
  assert.match(formSource, /const quoteLastPrice = toNumber\(quote\?\.last_price\);/);
  assert.match(formSource, /legacyTpSlExecutionAsk/);
  assert.match(formSource, /legacyTpSlExecutionBid/);
  assert.doesNotMatch(formSource, /priceAuthority\.(?:reference_price|mark_price|last_trade_price|index_price)/);
});

test('backend order payload is unchanged and never accepts a client execution price', () => {
  assert.match(formSource, /await openContractOrder\(\{\s*symbol,\s*position_side: side,\s*order_type: orderType,/);
  assert.match(formSource, /price: orderType === 'LIMIT' \? price : null,\s*quantity: quantityForOrder,\s*leverage,/);
  assert.match(formSource, /take_profit_price: tpSlEnabled && takeProfitPrice \? takeProfitPrice : null,/);
  assert.match(formSource, /stop_loss_price: tpSlEnabled && stopLossPrice \? stopLossPrice : null,/);
  assert.match(formSource, /await closeContractSummaryOrder\(\{\s*symbol,\s*side,\s*order_type: orderType,/);
  assert.match(formSource, /await closeContractOrder\(\{\s*position_id: position!\.id,\s*order_type: orderType,/);
  assert.doesNotMatch(formSource, /\bexecution_price\s*:/);
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
  assert.match(formSource, /resolveContractExecutionPrice\(\{/);
  assert.match(formSource, /\[contract-trading-form-market-diff\]/);
  assert.doesNotMatch(formSource, /executionPrices\s*=\s*displayMarketRead/);
  assert.match(formSource, /data-display-price=\{displayMarketRead\.displayPrice/);
  assert.match(formSource, /data-mark-price=\{displayMarketRead\.markPrice/);
  assert.match(formSource, /data-index-price=\{displayMarketRead\.indexPrice/);
});
