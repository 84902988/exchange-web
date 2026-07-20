import { describe, expect, it } from '@jest/globals';
import { contractMarketStore } from '../../lib/realtime/contractMarketStore';
import {
  activateContractMarketShadowSymbol,
  ingestContractMarketWsDomain,
  selectContractMarketViewStoreAuthoritySnapshot,
  selectContractOrderBookStoreSnapshot,
  subscribeContractOrderBookStore,
  writeContractMarketShadowDomain,
} from './hooks/contractMarketStoreAdapter';

function writeDepth(params: {
  symbol?: string;
  bids?: unknown[];
  asks?: unknown[];
  eventTimeMs?: number;
  generation?: number;
  sequence?: number;
}) {
  const symbol = params.symbol || 'BTCUSDT_PERP';
  return writeContractMarketShadowDomain({
    symbol,
    domain: 'depth',
    data: {
      symbol,
      bids: params.bids ?? [['64000', '1'], ['63999', '2']],
      asks: params.asks ?? [['64001', '1.5'], ['64002', '3']],
      depth_mode: 'FULL_DEPTH',
      source: 'LIVE_WS',
      freshness: 'LIVE',
      provider: 'BINANCE_USDM',
      provider_generation: params.generation,
      revision: params.sequence === undefined
        ? null
        : { epoch: params.generation ?? null, sequence: params.sequence },
      provider_event_time_ms: params.eventTimeMs ?? 1_720_000_000_100,
    },
    transport: 'WS',
  });
}

function selectOrderBook() {
  return selectContractOrderBookStoreSnapshot(contractMarketStore.getState());
}

describe('Contract OrderBook realtime store adapter', () => {
  it('switches OrderBook authority with the active symbol', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeDepth({});
    expect(selectOrderBook()?.symbol).toBe('BTCUSDT_PERP');

    activateContractMarketShadowSymbol('ETHUSDT_PERP');
    expect(selectOrderBook()).toBeNull();
    const retired = writeDepth({
      symbol: 'BTCUSDT_PERP',
      eventTimeMs: 1_720_000_000_200,
    });
    writeDepth({
      symbol: 'ETHUSDT_PERP',
      bids: [['3500', '5']],
      asks: [['3501', '6']],
      eventTimeMs: 1_720_000_000_200,
    });

    expect(retired).toMatchObject({ accepted: false, reason: 'OLD_SYMBOL' });
    expect(selectOrderBook()).toMatchObject({
      symbol: 'ETHUSDT_PERP',
      bestBid: '3500',
      bestAsk: '3501',
      midpoint: '3500.5',
    });
  });

  it('rejects stale depth without replacing accepted bid/ask', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeDepth({ eventTimeMs: 1_720_000_000_200 });
    const stale = writeDepth({
      bids: [['63000', '1']],
      asks: [['63001', '1']],
      eventTimeMs: 1_720_000_000_100,
    });

    expect(stale).toMatchObject({ accepted: false, reason: 'STALE_EVENT' });
    expect(selectOrderBook()).toMatchObject({ bestBid: '64000', bestAsk: '64001' });
  });

  it('rejects depth generation rollback even when its event time is newer', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeDepth({ generation: 12, sequence: 8, eventTimeMs: 1_720_000_000_100 });
    const rollback = writeDepth({
      generation: 11,
      sequence: 99,
      bids: [['65000', '1']],
      asks: [['65001', '1']],
      eventTimeMs: 1_720_000_000_300,
    });

    expect(rollback).toMatchObject({ accepted: false, reason: 'GENERATION_ROLLBACK' });
    expect(selectOrderBook()).toMatchObject({
      bestBid: '64000',
      bestAsk: '64001',
      providerGeneration: 12,
      revision: { epoch: 12, sequence: 8 },
    });
  });

  it('derives best bid, best ask, midpoint, and spread from the same depth book', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeDepth({
      bids: [['99', '1'], ['100', '2']],
      asks: [['103', '1'], ['102', '2']],
    });

    expect(selectOrderBook()).toMatchObject({
      bestBid: '100',
      bestAsk: '102',
      midpoint: '101',
      spread: '2',
    });
  });

  it('keeps an empty depth snapshot authoritative and ignores non-depth domains', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeDepth({ bids: [], asks: [] });
    const emptySnapshot = selectOrderBook();
    let depthNotifications = 0;
    const unsubscribe = subscribeContractOrderBookStore(() => {
      depthNotifications += 1;
    });

    writeContractMarketShadowDomain({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: { last_price: '64000', provider_event_time_ms: 1_720_000_000_200 },
      transport: 'WS',
    });
    writeContractMarketShadowDomain({
      symbol: 'BTCUSDT_PERP',
      domain: 'trades',
      data: [{ id: 'trade-1', price: '64000', time: 1_720_000_000_200 }],
      transport: 'WS',
    });
    writeContractMarketShadowDomain({
      symbol: 'BTCUSDT_PERP',
      domain: 'kline',
      interval: '1m',
      data: { close: '64000', open_time: 1_720_000_000_000 },
      transport: 'WS',
    });

    expect(depthNotifications).toBe(0);
    expect(emptySnapshot).toMatchObject({
      bids: [],
      asks: [],
      bestBid: null,
      bestAsk: null,
      spread: null,
    });
    expect(selectOrderBook()).toBe(emptySnapshot);

    writeDepth({
      bids: [['64010', '1']],
      asks: [['64011', '1']],
      eventTimeMs: 1_720_000_000_300,
    });
    expect(depthNotifications).toBe(1);
    unsubscribe();
  });

  it('publishes each accepted WS depth frame to OrderBook subscribers synchronously', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    const order: string[] = [];
    const unsubscribe = subscribeContractOrderBookStore(() => {
      order.push('notified');
    });

    const accepted = ingestContractMarketWsDomain({
      domain: 'depth',
      message: {
        type: 'contract_depth',
        symbol: 'BTCUSDT_PERP',
        depth: {
          symbol: 'BTCUSDT_PERP',
          bids: [['64100', '4'], ['64099', '1']],
          asks: [['64101', '2'], ['64102', '3']],
          depth_mode: 'FULL_DEPTH',
          source: 'LIVE_WS',
          quote_freshness: 'LIVE',
          provider: 'BINANCE_USDM',
          provider_generation: 17,
          revision: { epoch: 17, sequence: 41 },
          provider_event_time_ms: 1_720_000_000_400,
        },
      },
    });
    order.push('returned');

    expect(accepted).toMatchObject({ accepted: true });
    expect(order).toEqual(['notified', 'returned']);
    expect(selectOrderBook()).toMatchObject({
      bestBid: '64100',
      bestAsk: '64101',
      providerGeneration: 17,
      revision: { epoch: 17, sequence: 41 },
    });
    unsubscribe();
  });

  it('advances real BBO-only prices when the provider does not publish quantity', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('XAUUSDT_PERP');

    const first = ingestContractMarketWsDomain({
      domain: 'depth',
      message: {
        type: 'contract_depth',
        symbol: 'XAUUSDT_PERP',
        depth: {
          symbol: 'XAUUSDT_PERP',
          bids: [['4010.33', '0']],
          asks: [['4010.93', '0']],
          depth_mode: 'BBO_ONLY',
          source: 'LIVE_WS',
          quote_freshness: 'LIVE',
          provider: 'ITICK',
          provider_event_time_ms: 1_720_000_000_100,
        },
      },
    });
    const second = ingestContractMarketWsDomain({
      domain: 'depth',
      message: {
        type: 'contract_depth',
        symbol: 'XAUUSDT_PERP',
        depth: {
          symbol: 'XAUUSDT_PERP',
          bids: [['4011.12', '0']],
          asks: [['4011.74', '0']],
          depth_mode: 'BBO_ONLY',
          source: 'LIVE_WS',
          quote_freshness: 'LIVE',
          provider: 'ITICK',
          provider_event_time_ms: 1_720_000_000_200,
        },
      },
    });

    expect(first).toMatchObject({ accepted: true });
    expect(second).toMatchObject({ accepted: true });
    expect(selectOrderBook()).toMatchObject({
      symbol: 'XAUUSDT_PERP',
      bestBid: '4011.12',
      bestAsk: '4011.74',
      midpoint: '4011.43',
      depthMode: 'BBO_ONLY',
      source: 'LIVE_WS',
      provider: 'ITICK',
    });
    expect(selectContractMarketViewStoreAuthoritySnapshot(
      contractMarketStore.getState(),
      'XAUUSDT_PERP',
    )).toMatchObject({
      bestBid: '4011.12',
      bestAsk: '4011.74',
      depthSource: 'LIVE_WS',
      hasRealtimeBboAuthority: true,
    });
  });

  it('keeps the REST depth generation when same-provider WS frames omit it', () => {
    contractMarketStore.resetForTests();
    activateContractMarketShadowSymbol('BTCUSDT_PERP');
    writeContractMarketShadowDomain({
      symbol: 'BTCUSDT_PERP',
      domain: 'depth',
      data: {
        symbol: 'BTCUSDT_PERP',
        bids: [['64000', '1'], ['63999', '2']],
        asks: [['64001', '1'], ['64002', '2']],
        depth_mode: 'FULL_DEPTH',
        source: 'REST',
        freshness: 'RECENT',
        provider: 'OKX_SWAP',
        provider_generation: 21,
        provider_event_time_ms: 1_720_000_000_100,
      },
      transport: 'REST',
    });

    const wsDepth = ingestContractMarketWsDomain({
      domain: 'depth',
      message: {
        type: 'contract_depth',
        symbol: 'BTCUSDT_PERP',
        depth: {
          symbol: 'BTCUSDT_PERP',
          bids: [['64100', '9'], ['64099', '1']],
          asks: [['64101', '3'], ['64102', '1']],
          depth_mode: 'FULL_DEPTH',
          source: 'LIVE_WS',
          quote_freshness: 'LIVE',
          provider: 'OKX_SWAP',
          provider_event_time_ms: 1_720_000_000_200,
        },
      },
    });

    expect(wsDepth).toMatchObject({ accepted: true, reason: 'ACCEPTED' });
    expect(selectOrderBook()).toMatchObject({
      bestBid: '64100',
      bestAsk: '64101',
      provider: 'OKX_SWAP',
      providerGeneration: 21,
      freshness: 'LIVE',
    });

    const staleWsDepth = ingestContractMarketWsDomain({
      domain: 'depth',
      message: {
        type: 'contract_depth',
        symbol: 'BTCUSDT_PERP',
        depth: {
          symbol: 'BTCUSDT_PERP',
          bids: [['63000', '1'], ['62999', '1']],
          asks: [['63001', '1'], ['63002', '1']],
          depth_mode: 'FULL_DEPTH',
          source: 'LIVE_WS',
          quote_freshness: 'LIVE',
          provider: 'OKX_SWAP',
          provider_event_time_ms: 1_720_000_000_150,
        },
      },
    });

    expect(staleWsDepth).toMatchObject({ accepted: false, reason: 'STALE_EVENT' });
    expect(selectOrderBook()).toMatchObject({ bestBid: '64100', bestAsk: '64101' });
  });
});
