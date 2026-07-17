import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import {
  buildContractPriceAuthority,
  resolveContractExecutionPrice,
  type ContractExecutionBookInput,
  type ContractKlineReferenceInput,
  type ContractTickerReferenceInput,
  type ContractTradeReferenceInput,
} from './contractPriceAuthority';

const SYMBOL = 'XAUUSDT_PERP';
const NOW = 1_720_000_000_000;

function realTrade(
  overrides: Partial<ContractTradeReferenceInput> = {},
): ContractTradeReferenceInput {
  return {
    symbol: SYMBOL,
    price: '2400.5',
    time: NOW,
    source: 'OKX_SWAP',
    freshness: 'LIVE',
    priceSource: 'TRADE_TICK',
    synthetic: false,
    ...overrides,
  };
}

function providerKline(
  overrides: Partial<ContractKlineReferenceInput> = {},
): ContractKlineReferenceInput {
  return {
    symbol: SYMBOL,
    close: '2399.5',
    time: NOW,
    freshness: 'RECENT',
    priceSource: 'KLINE_CLOSE',
    klineMode: 'PROVIDER_KLINE',
    ...overrides,
  };
}

function closedTicker(
  overrides: Partial<ContractTickerReferenceInput> = {},
): ContractTickerReferenceInput {
  return {
    symbol: SYMBOL,
    price: '2398.5',
    time: NOW,
    source: 'ITICK_QUOTE',
    freshness: 'LAST_VALID',
    marketStatus: 'CLOSED',
    marketSessionType: 'OFF_HOURS',
    ...overrides,
  };
}

function liveBbo(
  overrides: Partial<ContractExecutionBookInput> = {},
): ContractExecutionBookInput {
  return {
    symbol: SYMBOL,
    bid: '2400',
    ask: '2401',
    executable: true,
    mode: 'LIVE_BBO',
    freshness: 'LIVE',
    source: 'OKX_SWAP',
    time: NOW,
    ...overrides,
  };
}

test('real trade is the Contract chart reference price', () => {
  const authority = buildContractPriceAuthority({
    symbol: SYMBOL,
    trade: realTrade(),
    kline: providerKline(),
    execution: liveBbo(),
  });

  assert.deepEqual(
    {
      role: authority.reference_price.role,
      domain: authority.reference_price.domain,
      value: authority.reference_price.value,
      source: authority.reference_price.source,
      provider: authority.reference_price.provider,
      freshness: authority.reference_price.freshness,
      eventTimeMs: authority.reference_price.eventTimeMs,
      usable: authority.reference_price.usable,
    },
    {
      role: 'LAST_TRADE',
      domain: 'TRADES',
      value: 2400.5,
      source: 'TRADE_TICK',
      provider: 'OKX_SWAP',
      freshness: 'LIVE',
      eventTimeMs: NOW,
      usable: true,
    },
  );
});

test('synthetic quote trade is rejected and provider KLINE_CLOSE is the only fallback', () => {
  const withFallback = buildContractPriceAuthority({
    symbol: SYMBOL,
    trade: realTrade({ priceSource: 'SYNTHETIC_FROM_QUOTE', synthetic: true }),
    kline: providerKline(),
  });
  const withoutFallback = buildContractPriceAuthority({
    symbol: SYMBOL,
    trade: realTrade({ priceSource: 'SYNTHETIC_FROM_QUOTE', synthetic: true }),
  });

  assert.deepEqual(
    {
      role: withFallback.reference_price.role,
      domain: withFallback.reference_price.domain,
      value: withFallback.reference_price.value,
      provider: withFallback.reference_price.provider,
    },
    {
      role: 'KLINE_CLOSE',
      domain: 'KLINE',
      value: 2399.5,
      provider: 'PROVIDER_KLINE',
    },
  );
  assert.equal(withoutFallback.reference_price.role, 'UNAVAILABLE');
  assert.equal(withoutFallback.reference_price.usable, false);
  assert.equal(withoutFallback.reference_price.rejectReason, 'SYNTHETIC_TRADE');
});

test('closed-market ticker last price is a shared reference fallback with explicit provenance', () => {
  const authority = buildContractPriceAuthority({
    symbol: SYMBOL,
    ticker: closedTicker(),
  });

  assert.deepEqual(
    {
      role: authority.reference_price.role,
      domain: authority.reference_price.domain,
      value: authority.reference_price.value,
      source: authority.reference_price.source,
      provider: authority.reference_price.provider,
      freshness: authority.reference_price.freshness,
      eventTimeMs: authority.reference_price.eventTimeMs,
      usable: authority.reference_price.usable,
    },
    {
      role: 'LAST_PRICE',
      domain: 'TICKER',
      value: 2398.5,
      source: 'LAST_PRICE',
      provider: 'ITICK_QUOTE',
      freshness: 'LAST_VALID',
      eventTimeMs: NOW,
      usable: true,
    },
  );
});

test('live-session ticker is a reference only when trade and kline evidence are absent', () => {
  const liveTickerOnly = buildContractPriceAuthority({
    symbol: SYMBOL,
    ticker: closedTicker({
      freshness: 'LIVE',
      marketStatus: 'OPEN',
      marketSessionType: 'REGULAR',
    }),
  });
  const withTrade = buildContractPriceAuthority({
    symbol: SYMBOL,
    trade: realTrade(),
    kline: providerKline(),
    ticker: closedTicker({
      freshness: 'LIVE',
      marketStatus: 'OPEN',
      marketSessionType: 'REGULAR',
    }),
  });

  assert.equal(liveTickerOnly.reference_price.role, 'LAST_PRICE');
  assert.equal(liveTickerOnly.reference_price.domain, 'TICKER');
  assert.equal(liveTickerOnly.reference_price.usable, true);
  assert.equal(withTrade.reference_price.role, 'LAST_TRADE');
  assert.equal(withTrade.reference_price.domain, 'TRADES');
});

test('stale live-session ticker fails closed', () => {
  const authority = buildContractPriceAuthority({
    symbol: SYMBOL,
    ticker: closedTicker({
      freshness: 'STALE',
      marketStatus: 'OPEN',
      marketSessionType: 'REGULAR',
    }),
  });

  assert.equal(authority.reference_price.role, 'UNAVAILABLE');
  assert.equal(authority.reference_price.rejectReason, 'STALE');
});

test('reference price is structured unavailable when no permitted evidence exists', () => {
  const authority = buildContractPriceAuthority({ symbol: SYMBOL });

  assert.deepEqual(
    {
      role: authority.reference_price.role,
      domain: authority.reference_price.domain,
      value: authority.reference_price.value,
      usable: authority.reference_price.usable,
      rejectReason: authority.reference_price.rejectReason,
      symbol: authority.reference_price.symbol,
    },
    {
      role: 'UNAVAILABLE',
      domain: 'UNAVAILABLE',
      value: null,
      usable: false,
      rejectReason: 'REFERENCE_PRICE_UNAVAILABLE',
      symbol: SYMBOL,
    },
  );
});

test.each([
  ['missing event time', { time: null }, 'TRADE_TIME_MISSING'],
  ['missing source', { source: null }, 'TRADE_SOURCE_MISSING'],
  ['missing freshness', { freshness: null }, 'FRESHNESS_UNUSABLE'],
  ['wrong price provenance', { priceSource: 'KLINE_CLOSE' }, 'TRADE_PROVENANCE_INVALID'],
] as const)('%s is not borrowed from another trade snapshot', (_label, overrides, rejectReason) => {
  const authority = buildContractPriceAuthority({
    symbol: SYMBOL,
    trade: realTrade(overrides),
  });

  assert.equal(authority.reference_price.role, 'UNAVAILABLE');
  assert.equal(authority.reference_price.value, null);
  assert.equal(authority.reference_price.rejectReason, rejectReason);
});

test('wrong-symbol reference and execution evidence fail closed', () => {
  const referenceAuthority = buildContractPriceAuthority({
    symbol: SYMBOL,
    trade: realTrade({ symbol: 'BTCUSDT_PERP' }),
  });
  const executionAuthority = buildContractPriceAuthority({
    symbol: SYMBOL,
    execution: liveBbo({ symbol: 'BTCUSDT_PERP' }),
  });
  const execution = resolveContractExecutionPrice({
    authority: executionAuthority,
    intent: 'OPEN_LONG',
    expectedSymbol: SYMBOL,
  });

  assert.equal(referenceAuthority.reference_price.role, 'UNAVAILABLE');
  assert.equal(referenceAuthority.reference_price.rejectReason, 'SYMBOL_MISMATCH');
  assert.equal(execution.price, null);
  assert.equal(execution.executable, false);
  assert.equal(execution.rejectReason, 'SYMBOL_MISMATCH');
});

test.each([
  ['OPEN_LONG', 2401, 'EXECUTION_ASK'],
  ['OPEN_SHORT', 2400, 'EXECUTION_BID'],
  ['CLOSE_LONG', 2400, 'EXECUTION_BID'],
  ['CLOSE_SHORT', 2401, 'EXECUTION_ASK'],
] as const)('%s resolves the required BBO side', (intent, price, basis) => {
  const authority = buildContractPriceAuthority({
    symbol: SYMBOL,
    execution: liveBbo(),
  });
  const resolved = resolveContractExecutionPrice({
    authority,
    intent,
    expectedSymbol: SYMBOL,
  });

  assert.deepEqual(
    {
      price: resolved.price,
      basis: resolved.basis,
      executable: resolved.executable,
      rejectReason: resolved.rejectReason,
    },
    { price, basis, executable: true, rejectReason: null },
  );
});

test.each([
  ['missing bid', { bid: null }, 'BBO_MISSING'],
  ['missing ask', { ask: null }, 'BBO_MISSING'],
  ['crossed BBO', { bid: '2402', ask: '2401' }, 'BBO_CROSSED'],
  ['stale BBO', { freshness: 'STALE' }, 'STALE'],
  ['disabled BBO', { executable: false }, 'MARKET_NOT_EXECUTABLE'],
  ['unsupported mode', { mode: 'LAST_GOOD_BBO' }, 'EXECUTION_MODE_NOT_ALLOWED'],
] as const)('%s disables both execution sides atomically', (_label, overrides, rejectReason) => {
  const authority = buildContractPriceAuthority({
    symbol: SYMBOL,
    execution: liveBbo(overrides),
  });

  assert.equal(authority.executable, false);
  assert.deepEqual(
    {
      bid: authority.execution_bid.value,
      bidUsable: authority.execution_bid.usable,
      bidReason: authority.execution_bid.rejectReason,
      ask: authority.execution_ask.value,
      askUsable: authority.execution_ask.usable,
      askReason: authority.execution_ask.rejectReason,
    },
    {
      bid: null,
      bidUsable: false,
      bidReason: rejectReason,
      ask: null,
      askUsable: false,
      askReason: rejectReason,
    },
  );
});
