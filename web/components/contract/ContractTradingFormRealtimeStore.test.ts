import { describe, expect, it } from '@jest/globals';
import { contractMarketStore } from '../../lib/realtime/contractMarketStore';
import {
  activateContractMarketShadowSymbol,
  selectContractTradingFormStoreSnapshot,
  subscribeContractTradingFormStore,
  writeContractMarketShadowDomain,
} from './hooks/contractMarketStoreAdapter';

function writeTicker(params: {
  symbol?: string;
  displayPrice?: string;
  markPrice?: string;
  indexPrice?: string;
  marketStatus?: string;
  executable?: boolean;
  eventTimeMs: number;
  generation?: number;
}) {
  const symbol = params.symbol || 'BTCUSDT_PERP';
  return writeContractMarketShadowDomain({
    symbol,
    domain: 'ticker',
    data: {
      symbol,
      display_price: params.displayPrice ?? '64000',
      display_price_source: 'TRADE_TICK',
      mark_price: params.markPrice ?? '63990',
      index_price: params.indexPrice ?? '63980',
      market_status: params.marketStatus ?? 'OPEN',
      display_state: params.marketStatus === 'CLOSED' ? 'CLOSED' : 'LIVE_TRADABLE',
      executable: params.executable ?? true,
      reason_code: params.executable === false ? 'NON_TRADING_SESSION' : 'LIVE_BBO',
    },
    transport: 'WS',
    metadata: {
      source: 'LIVE_WS',
      freshness: 'LIVE',
      provider: 'BINANCE_USDM',
      provider_generation: params.generation,
      provider_event_time_ms: params.eventTimeMs,
    },
  });
}

function selectTradingForm(symbol = 'BTCUSDT_PERP') {
  return selectContractTradingFormStoreSnapshot(contractMarketStore.getState(), symbol);
}

describe('Contract TradingForm realtime Store adapter', () => {
  it('rejects a stale quote without rolling back display, mark, or index prices', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeTicker({
      displayPrice: '64000',
      markPrice: '63990',
      indexPrice: '63980',
      eventTimeMs: 1_720_000_000_200,
    });
    const stale = writeTicker({
      displayPrice: '63000',
      markPrice: '62990',
      indexPrice: '62980',
      eventTimeMs: 1_720_000_000_100,
    });

    expect(stale).toMatchObject({ accepted: false, reason: 'STALE_EVENT' });
    expect(selectTradingForm()).toMatchObject({
      displayPrice: '64000',
      markPrice: '63990',
      indexPrice: '63980',
    });
  });

  it('rejects provider generation rollback even when the quote arrives later', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeTicker({
      displayPrice: '64000',
      eventTimeMs: 1_720_000_000_100,
      generation: 12,
    });
    const rollback = writeTicker({
      displayPrice: '65000',
      eventTimeMs: 1_720_000_000_300,
      generation: 11,
    });

    expect(rollback).toMatchObject({ accepted: false, reason: 'GENERATION_ROLLBACK' });
    expect(selectTradingForm()).toMatchObject({
      displayPrice: '64000',
      providerGeneration: 12,
    });
  });

  it('synchronizes closed-market and executable display state from ticker Store', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeTicker({
      marketStatus: 'CLOSED',
      executable: false,
      eventTimeMs: 1_720_000_000_100,
      generation: 3,
    });

    expect(selectTradingForm()).toMatchObject({
      marketStatus: 'CLOSED',
      displayState: 'CLOSED',
      executable: false,
      reasonCode: 'NON_TRADING_SESSION',
    });
  });

  it('isolates symbol sessions and never revives a prior-session ticker', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeTicker({ eventTimeMs: 1_720_000_000_100 });
    expect(selectTradingForm('BTCUSDT_PERP')?.displayPrice).toBe('64000');

    activateContractMarketShadowSymbol('ETHUSDT_PERP');
    const retired = writeTicker({
      symbol: 'BTCUSDT_PERP',
      displayPrice: '65000',
      eventTimeMs: 1_720_000_000_200,
    });
    expect(retired).toMatchObject({ accepted: false, reason: 'OLD_SYMBOL' });
    expect(selectTradingForm('BTCUSDT_PERP')).toBeNull();
    expect(selectTradingForm('ETHUSDT_PERP')).toBeNull();

    writeTicker({
      symbol: 'ETHUSDT_PERP',
      displayPrice: '3500',
      markPrice: '3499',
      indexPrice: '3498',
      eventTimeMs: 1_720_000_000_200,
    });
    expect(selectTradingForm('ETHUSDT_PERP')).toMatchObject({
      symbol: 'ETHUSDT_PERP',
      displayPrice: '3500',
    });

    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    expect(selectTradingForm('BTCUSDT_PERP')).toBeNull();
  });

  it('subscribes TradingForm display only to its ticker domain', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeTicker({ eventTimeMs: 1_720_000_000_100 });
    let notifications = 0;
    const unsubscribe = subscribeContractTradingFormStore('BTCUSDT_PERP', () => {
      notifications += 1;
    });

    writeContractMarketShadowDomain({
      symbol: 'BTCUSDT_PERP',
      domain: 'depth',
      data: { bids: [['64000', '1']], asks: [['64001', '1']] },
      transport: 'WS',
      metadata: { provider_event_time_ms: 1_720_000_000_200 },
    });
    writeContractMarketShadowDomain({
      symbol: 'BTCUSDT_PERP',
      domain: 'trades',
      data: [{ id: 'trade-1', price: '64000', qty: '1', time: 1_720_000_000_200 }],
      transport: 'WS',
      metadata: { provider_event_time_ms: 1_720_000_000_200 },
    });
    writeContractMarketShadowDomain({
      symbol: 'BTCUSDT_PERP',
      domain: 'kline',
      interval: '1m',
      data: { close: '64000', open_time: 1_720_000_000_000 },
      transport: 'WS',
      metadata: { provider_event_time_ms: 1_720_000_000_200 },
    });

    expect(notifications).toBe(0);
    writeTicker({ displayPrice: '64010', eventTimeMs: 1_720_000_000_300 });
    expect(notifications).toBe(1);
    unsubscribe();
  });
});
