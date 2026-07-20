import { expect, test } from '@jest/globals';
import type { ContractQuote } from '@/lib/api/modules/contract';
import { resolveLiveContractPositionValuation } from './contractPositionValuation';

function makeQuote(overrides: Partial<ContractQuote> = {}): ContractQuote {
  return {
    symbol: 'XAUUSDT_PERP',
    provider: 'ITICK',
    provider_symbol: 'XAUUSD',
    bid_price: '100',
    ask_price: '102',
    last_price: '101.5',
    mark_price: '101.25',
    quote_freshness: 'LIVE',
    quote_source: 'ITICK_QUOTE',
    executable: true,
    source: 'ITICK_QUOTE',
    ts: '2026-07-20T12:00:00Z',
    ...overrides,
  } as ContractQuote;
}

test('TradFi position display uses the live BBO midpoint', () => {
  expect(resolveLiveContractPositionValuation({
    positionSymbol: 'XAUUSDT_PERP',
    currentSymbol: 'XAUUSDT_PERP',
    side: 'LONG',
    quantity: '2',
    entryPrice: '100',
    marginAmount: '10',
    quote: makeQuote(),
    liveBestBid: '99',
    liveBestAsk: '101',
    liveMarketUsable: true,
    useBboMidpoint: true,
  })).toEqual({
    price: 100,
    unrealizedPnl: 0,
    roe: 0,
  });
});

test('crypto position display prefers the live quote mark price', () => {
  expect(resolveLiveContractPositionValuation({
    positionSymbol: 'XAUUSDT_PERP',
    currentSymbol: 'XAUUSDT_PERP',
    side: 'SHORT',
    quantity: '2',
    entryPrice: '102',
    marginAmount: '3',
    quote: makeQuote(),
    liveBestBid: null,
    liveBestAsk: null,
    liveMarketUsable: true,
    useBboMidpoint: false,
  })).toEqual({
    price: 101.25,
    unrealizedPnl: 1.5,
    roe: 50,
  });
});

test.each([
  ['different symbol', makeQuote({ symbol: 'BTCUSDT_PERP' })],
  ['stale quote', makeQuote({ quote_freshness: 'STALE' })],
  ['non executable quote', makeQuote({ executable: false })],
  ['crossed BBO for TradFi', makeQuote({ bid_price: '103', ask_price: '102' })],
])('does not overlay the private position snapshot for %s', (_label, quote) => {
  expect(resolveLiveContractPositionValuation({
    positionSymbol: 'XAUUSDT_PERP',
    currentSymbol: 'XAUUSDT_PERP',
    side: 'LONG',
    quantity: '2',
    entryPrice: '100',
    marginAmount: '10',
    quote,
    liveBestBid: null,
    liveBestAsk: null,
    liveMarketUsable: true,
    useBboMidpoint: true,
  })).toBeNull();
});
