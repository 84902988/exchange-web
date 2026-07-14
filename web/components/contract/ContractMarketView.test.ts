import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ContractMarketViewDetail } from '@/lib/api/modules/contract';
import {
  readContractMarketViewAuthority,
  resolveContractMarketViewAuthorityPresentation,
  shouldExposeContractMarketDepth,
} from './contractMarketView.utils';

function createMarketView(
  overrides: Partial<ContractMarketViewDetail> = {},
): ContractMarketViewDetail {
  return {
    symbol: 'BTCUSDT_PERP',
    display_symbol: 'BTC/USDT',
    market_type: 'CONTRACT',
    category: 'CRYPTO',
    market_status: 'OPEN',
    display_state: 'LIVE_TRADABLE',
    display_price: '100',
    display_price_source: 'LIVE_MID',
    current_price_source: 'LIVE_MID',
    ticker_source: 'LIVE_WS',
    ticker_freshness: 'LIVE',
    depth_source: 'LIVE_WS',
    depth_freshness: 'LIVE',
    trades_source: 'LIVE_WS',
    trades_freshness: 'LIVE',
    kline_source: 'PROVIDER_KLINE',
    kline_freshness: 'LIVE',
    last_trade_price: '120',
    last_trade_time: '2026-07-13T10:00:00Z',
    best_bid: '99',
    best_ask: '101',
    spread: '2',
    executable: true,
    execution_bid: '99',
    execution_ask: '101',
    execution_mode: 'LIVE_BBO',
    last_good_bbo_valid: true,
    reason_code: 'LIVE_BBO',
    warnings: [],
    kline_current_candle: {
      time: 1_752_400_000,
      open: '80',
      high: '90',
      low: '70',
      close: '85',
      volume: '10',
      kline_mode: 'PROVIDER_KLINE',
    },
    raw_source_summary: {},
    ...overrides,
  };
}

const hookSource = readFileSync(
  fileURLToPath(new URL('./hooks/useContractMarketView.ts', import.meta.url)),
  'utf8',
);
const formSource = readFileSync(
  fileURLToPath(new URL('./ContractTradingForm.tsx', import.meta.url)),
  'utf8',
);
const orderBookSource = readFileSync(
  fileURLToPath(new URL('./ContractFuturesOrderBook.tsx', import.meta.url)),
  'utf8',
);
const headerSource = readFileSync(
  fileURLToPath(new URL('./ContractMarketHeader.tsx', import.meta.url)),
  'utf8',
);

test('MarketView display_price wins over trade tick, depth BBO, and chart close data', () => {
  const authority = readContractMarketViewAuthority(createMarketView({
    display_price: '100',
    last_trade_price: '120',
    best_bid: '109',
    best_ask: '111',
    kline_current_candle: {
      open: '80',
      high: '90',
      low: '70',
      close: '85',
      volume: '10',
    },
  }));

  assert.equal(authority.displayPrice, 100);
  assert.match(hookSource, /const displayPrice = marketViewAuthority\.displayPrice;/);
  assert.doesNotMatch(hookSource, /chartLastClose|localChartLastClose|liveDepthMidPrice/);
  assert.doesNotMatch(hookSource, /const displayPrice\s*=\s*(?:latestTrade|tradeTick|depth|chart)/);
});

test('Chart close remains isolated from MarketView display authority', () => {
  const authority = readContractMarketViewAuthority(createMarketView({
    display_price: '64000',
    kline_current_candle: {
      open: '63000',
      high: '65000',
      low: '62000',
      close: '63900',
      volume: '50',
    },
  }));

  assert.equal(authority.displayPrice, 64000);
  assert.match(hookSource, /const handleLatestKlineCloseChange = useCallback\(\(value: string \| null\) => \{\s*void value;/);
});

test('execution bid and ask remain independent MarketView authority fields', () => {
  const marketView = createMarketView({
    display_price: '100',
    execution_bid: '98',
    execution_ask: '102',
  });
  const authority = readContractMarketViewAuthority(marketView);
  const presentation = resolveContractMarketViewAuthorityPresentation({ marketView });

  assert.equal(authority.executionBid, 98);
  assert.equal(authority.executionAsk, 102);
  assert.equal(presentation.isTradable, true);
  assert.match(formSource, /const resolvedExecutionBid = marketViewAuthority\.executionBid \?\? 0;/);
  assert.match(formSource, /const resolvedExecutionAsk = marketViewAuthority\.executionAsk \?\? 0;/);
  assert.match(formSource, /closeSide === 'LONG' \? resolvedExecutionBid : resolvedExecutionAsk/);
  assert.match(formSource, /positionSide === 'LONG' \? resolvedExecutionAsk : resolvedExecutionBid/);
  assert.doesNotMatch(formSource, /getPositivePriceValue\(executionBid|getPositivePriceValue\(executionAsk/);
});

test('executable=false disables trading even when display and BBO values exist', () => {
  const marketView = createMarketView({ executable: false });
  const presentation = resolveContractMarketViewAuthorityPresentation({ marketView });

  assert.equal(presentation.state, 'unavailable');
  assert.equal(presentation.status, 'UNAVAILABLE');
  assert.equal(presentation.isTradable, false);
  assert.equal(presentation.isRealtime, false);
  assert.equal(shouldExposeContractMarketDepth(presentation), false);
  assert.match(formSource, /const quoteUnavailable = !marketViewPresentation\.isTradable/);
});

test('STALE and FALLBACK display states never become realtime UI states', () => {
  for (const displayState of ['STALE', 'FALLBACK', 'LAST_GOOD_BBO']) {
    const marketView = createMarketView({ display_state: displayState });
    const presentation = resolveContractMarketViewAuthorityPresentation({ marketView });

    assert.equal(presentation.state, 'unavailable');
    assert.equal(presentation.status, 'UNAVAILABLE');
    assert.equal(presentation.isRealtime, false);
    assert.equal(presentation.isTradable, false);
  }

  const closedPresentation = resolveContractMarketViewAuthorityPresentation({
    marketView: createMarketView({ display_state: 'CLOSED', executable: false }),
  });
  assert.equal(shouldExposeContractMarketDepth(closedPresentation), false);
});

test('leaf components do not rebuild display price, freshness, or session authority', () => {
  assert.doesNotMatch(orderBookSource, /isContractDepthUnavailable|getContractMarketSourceTone|getContractMarketSourceLabel/);
  assert.doesNotMatch(orderBookSource, /const\s+\w*mid\w*Price/i);
  assert.doesNotMatch(headerSource, /getContractTickerDomainStatusLabel/);
  assert.doesNotMatch(headerSource, /status === 'PRE_MARKET'|session === 'PRE_MARKET'/);
  assert.doesNotMatch(formSource, /quote\?\.executable|getContractQuoteDisplayStatus|isExpiredLastGoodBboQuote/);
  assert.doesNotMatch(formSource, /marketUiState\?\./);
  assert.doesNotMatch(hookSource, /lastFullDepthSnapshot/);
});
