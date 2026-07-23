import { describe, expect, it } from '@jest/globals';
import { contractMarketStore } from '../../lib/realtime/contractMarketStore';
import {
  activateContractMarketShadowSymbol,
  restartContractMarketShadowSession,
  selectContractTradesStoreSnapshot,
  subscribeContractTradesStore,
  writeContractMarketShadowDomain,
} from './hooks/contractMarketStoreAdapter';

type TradeInput = {
  id?: string;
  trade_id?: string;
  price: string;
  qty: string;
  time: number;
  synthetic?: boolean;
  price_source?: string;
};

function writeTrades(params: {
  symbol?: string;
  trades: TradeInput[];
  eventTimeMs: number;
  generation?: number;
}) {
  const symbol = params.symbol || 'BTCUSDT_PERP';
  return writeContractMarketShadowDomain({
    symbol,
    domain: 'trades',
    data: params.trades,
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

function selectTrades() {
  return selectContractTradesStoreSnapshot(contractMarketStore.getState());
}

describe('Contract Trades realtime store adapter', () => {
  it('switches Trades authority with the active symbol and rejects the retired symbol', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeTrades({
      trades: [{ id: 'btc-1', price: '64000', qty: '1', time: 1_720_000_000_100 }],
      eventTimeMs: 1_720_000_000_100,
    });

    activateContractMarketShadowSymbol('ETHUSDT_PERP');
    const retired = writeTrades({
      symbol: 'BTCUSDT_PERP',
      trades: [{ id: 'btc-2', price: '64001', qty: '1', time: 1_720_000_000_200 }],
      eventTimeMs: 1_720_000_000_200,
    });
    writeTrades({
      symbol: 'ETHUSDT_PERP',
      trades: [{ id: 'eth-1', price: '3500', qty: '2', time: 1_720_000_000_200 }],
      eventTimeMs: 1_720_000_000_200,
    });

    expect(retired).toMatchObject({ accepted: false, reason: 'OLD_SYMBOL' });
    expect(selectTrades()).toMatchObject({
      symbol: 'ETHUSDT_PERP',
      trades: [{ id: 'eth-1', price: '3500' }],
    });
  });

  it('rejects stale trades without replacing the accepted snapshot', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeTrades({
      trades: [{ id: 'newer', price: '64000', qty: '1', time: 1_720_000_000_200 }],
      eventTimeMs: 1_720_000_000_200,
    });
    const stale = writeTrades({
      trades: [{ id: 'older', price: '63000', qty: '1', time: 1_720_000_000_100 }],
      eventTimeMs: 1_720_000_000_100,
    });

    expect(stale).toMatchObject({ accepted: false, reason: 'STALE_EVENT' });
    expect(selectTrades()?.trades.map((trade) => trade.id)).toEqual(['newer']);
  });

  it('rejects trades generation rollback even when its event time is newer', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeTrades({
      trades: [{ id: 'generation-12', price: '64000', qty: '1', time: 1_720_000_000_100 }],
      eventTimeMs: 1_720_000_000_100,
      generation: 12,
    });
    const rollback = writeTrades({
      trades: [{ id: 'generation-11', price: '65000', qty: '1', time: 1_720_000_000_300 }],
      eventTimeMs: 1_720_000_000_300,
      generation: 11,
    });

    expect(rollback).toMatchObject({ accepted: false, reason: 'GENERATION_ROLLBACK' });
    expect(selectTrades()).toMatchObject({
      providerGeneration: 12,
      trades: [{ id: 'generation-12' }],
    });
  });

  it('deduplicates by provider trade id, sorts newest first, and excludes synthetic rows', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeTrades({
      trades: [
        { id: 'old', price: '63990', qty: '1', time: 1_720_000_000_100 },
        { id: 'duplicate', price: '64000', qty: '1', time: 1_720_000_000_200 },
        { id: 'new', price: '64010', qty: '2', time: 1_720_000_000_400 },
        { id: 'duplicate', price: '64005', qty: '3', time: 1_720_000_000_300 },
        {
          id: 'synthetic-flag',
          price: '64020',
          qty: '1',
          time: 1_720_000_000_500,
          synthetic: true,
        },
        {
          id: 'synthetic-source',
          price: '64030',
          qty: '1',
          time: 1_720_000_000_600,
          price_source: 'SYNTHETIC_FROM_QUOTE',
        },
        { price: '64040', qty: '1', time: 1_720_000_000_700 },
      ],
      eventTimeMs: 1_720_000_000_700,
    });

    expect(selectTrades()?.trades).toEqual([
      expect.objectContaining({ id: 'new', price: '64010' }),
      expect.objectContaining({ id: 'duplicate', price: '64005' }),
      expect.objectContaining({ id: 'old', price: '63990' }),
    ]);
  });

  it('keeps an empty trades snapshot authoritative and ignores non-trades domains', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeTrades({ trades: [], eventTimeMs: 1_720_000_000_100 });
    const emptySnapshot = selectTrades();
    let tradesNotifications = 0;
    const unsubscribe = subscribeContractTradesStore(() => {
      tradesNotifications += 1;
    });

    writeContractMarketShadowDomain({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: { last_price: '64000' },
      transport: 'WS',
      metadata: { provider_event_time_ms: 1_720_000_000_200 },
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
      domain: 'kline',
      interval: '1m',
      data: { close: '64000', open_time: 1_720_000_000_000 },
      transport: 'WS',
      metadata: { provider_event_time_ms: 1_720_000_000_200 },
    });

    expect(tradesNotifications).toBe(0);
    expect(emptySnapshot).toMatchObject({ symbol: 'BTCUSDT_PERP', trades: [] });
    expect(selectTrades()).toBe(emptySnapshot);

    writeTrades({
      trades: [{ id: 'real-1', price: '64000', qty: '1', time: 1_720_000_000_300 }],
      eventTimeMs: 1_720_000_000_300,
    });
    expect(tradesNotifications).toBe(1);
    unsubscribe();
  });

  it('replaces pre-restart trades with the first accepted trade from the new generation', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('NAS100USDT_PERP');
    writeTrades({
      symbol: 'NAS100USDT_PERP',
      trades: [{ id: 'before-restart', price: '28936.24', qty: '1', time: 1_720_000_000_100 }],
      eventTimeMs: 1_720_000_000_100,
      generation: 7,
    });

    restartContractMarketShadowSession('NAS100USDT_PERP');
    expect(selectTrades()).toBeNull();

    writeTrades({
      symbol: 'NAS100USDT_PERP',
      trades: [{ id: 'after-restart', price: '28900.36', qty: '2', time: 1_720_000_010_100 }],
      eventTimeMs: 1_720_000_010_100,
      generation: 8,
    });

    expect(selectTrades()).toMatchObject({
      symbol: 'NAS100USDT_PERP',
      providerGeneration: 8,
      trades: [{ id: 'after-restart', price: '28900.36' }],
    });
  });
});
