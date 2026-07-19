import { describe, expect, it } from '@jest/globals';
import { createContractMarketStore } from '../../../lib/realtime/contractMarketStore';
import { selectContractHeaderStoreSnapshot } from './contractMarketStoreAdapter';

describe('Contract Header realtime Store hydration', () => {
  it('returns one stable safe snapshot for the initial empty Store', () => {
    const store = createContractMarketStore();
    store.activateSymbol('BTCUSDT_PERP');

    const first = selectContractHeaderStoreSnapshot(store.getState(), 'BTCUSDT_PERP');
    const second = selectContractHeaderStoreSnapshot(store.getState(), 'BTCUSDT_PERP');

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(first).toEqual({
      symbol: 'BTCUSDT_PERP',
      displayPrice: null,
      displayPriceSource: null,
      markPrice: null,
      indexPrice: null,
      fundingRate: null,
      bestBid: null,
      bestAsk: null,
      spread: null,
      priceChange24h: null,
      priceChangePercent24h: null,
      high24h: null,
      low24h: null,
      baseVolume24h: null,
      quoteVolume24h: null,
      displayState: null,
      marketStatus: null,
      marketSessionType: null,
      executable: null,
      source: null,
      freshness: null,
      provider: null,
      providerGeneration: null,
      revision: null,
      stale: false,
      observedAtMs: 0,
    });
  });

  it('builds a safe Header snapshot when ticker is missing', () => {
    const store = createContractMarketStore();
    store.activateSymbol('AAPLUSDT_PERP');
    store.ingest({
      symbol: 'AAPLUSDT_PERP',
      domain: 'depth',
      data: {
        bids: [['229.10', '4']],
        asks: [['229.30', '5']],
        mark_price: '229.20',
        index_price: '229.18',
        display_state: 'CLOSED',
        market_status: 'CLOSED',
        market_session_type: 'OFF_HOURS',
        executable: false,
      },
      transport: 'REST',
      source: 'ITICK_DEPTH',
      provider: 'ITICK',
      freshness: 'LAST_GOOD',
      providerGeneration: 4,
      eventTimeMs: 1_720_000_000_100,
    });

    const snapshot = selectContractHeaderStoreSnapshot(store.getState(), 'AAPLUSDT_PERP');
    expect(snapshot).toMatchObject({
        symbol: 'AAPLUSDT_PERP',
        displayPrice: '229.2',
        displayPriceSource: 'LIVE_MID',
        markPrice: '229.20',
        indexPrice: '229.18',
        bestBid: '229.1',
        bestAsk: '229.3',
        displayState: 'CLOSED',
        marketStatus: 'CLOSED',
        marketSessionType: 'OFF_HOURS',
        executable: false,
        source: 'ITICK_DEPTH',
        provider: 'ITICK',
        freshness: 'LAST_GOOD',
        providerGeneration: 4,
      });
    expect(Number(snapshot?.spread)).toBeCloseTo(0.2);
  });

  it('builds a safe Header snapshot when depth is missing', () => {
    const store = createContractMarketStore();
    store.activateSymbol('BTCUSDT_PERP');
    store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '64000',
        display_price_source: 'LIVE_MID',
        best_bid: '63999',
        best_ask: '64001',
        mark_price: '63998',
        index_price: '63997',
        open_24h: '63000',
        price_change_24h: '1000',
        price_change_percent_24h: '1.5873015873',
        high_24h: '65000',
        low_24h: '62000',
        base_volume_24h: '12.5',
        quote_volume_24h: '800000',
        market_status: 'OPEN',
        executable: true,
      },
      transport: 'WS',
      source: 'LIVE_WS',
      provider: 'BINANCE_USDM',
      freshness: 'LIVE',
      providerGeneration: 8,
      eventTimeMs: 1_720_000_000_100,
    });

    expect(selectContractHeaderStoreSnapshot(store.getState(), 'BTCUSDT_PERP'))
      .toMatchObject({
        symbol: 'BTCUSDT_PERP',
        displayPrice: '64000',
        bestBid: '63999',
        bestAsk: '64001',
        spread: '2',
        markPrice: '63998',
        indexPrice: '63997',
        priceChange24h: '1000',
        priceChangePercent24h: '1.5873015873',
        high24h: '65000',
        low24h: '62000',
        baseVolume24h: '12.5',
        quoteVolume24h: '800000',
        marketStatus: 'OPEN',
        executable: true,
        source: 'LIVE_WS',
        provider: 'BINANCE_USDM',
        freshness: 'LIVE',
        providerGeneration: 8,
      });
  });

  it('moves an anonymous Header from safe empty state to hydrated authority', () => {
    const store = createContractMarketStore();
    store.activateSymbol('XAUUSDT_PERP');
    const anonymous = selectContractHeaderStoreSnapshot(store.getState(), 'XAUUSDT_PERP');

    store.ingest({
      symbol: 'XAUUSDT_PERP',
      domain: 'ticker',
      data: { display_price: '2410.5', market_status: 'OPEN' },
      transport: 'REST',
      source: 'ITICK_QUOTE',
      provider: 'ITICK',
      freshness: 'LIVE',
      providerGeneration: 5,
      eventTimeMs: 1_720_000_000_200,
    });
    const hydrated = selectContractHeaderStoreSnapshot(store.getState(), 'XAUUSDT_PERP');

    expect(anonymous).toMatchObject({ symbol: 'XAUUSDT_PERP', displayPrice: null });
    expect(hydrated).not.toBe(anonymous);
    expect(hydrated).toMatchObject({
      symbol: 'XAUUSDT_PERP',
      displayPrice: '2410.5',
      marketStatus: 'OPEN',
      provider: 'ITICK',
      providerGeneration: 5,
    });
  });

  it('hides the previous snapshot after a realtime session restart', () => {
    const store = createContractMarketStore();
    store.activateSymbol('BTCUSDT_PERP');
    store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: { display_price: '64000' },
      transport: 'WS',
      provider: 'BINANCE_USDM',
      providerGeneration: 8,
      eventTimeMs: 1_720_000_000_200,
    });
    expect(selectContractHeaderStoreSnapshot(store.getState(), 'BTCUSDT_PERP')?.displayPrice)
      .toBe('64000');

    store.restartSession('BTCUSDT_PERP');
    const restarted = selectContractHeaderStoreSnapshot(store.getState(), 'BTCUSDT_PERP');
    expect(restarted).toMatchObject({
      symbol: 'BTCUSDT_PERP',
      displayPrice: null,
      source: null,
      providerGeneration: null,
    });

    const fallback = store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: { display_price: '63950' },
      transport: 'REST',
      provider: 'BINANCE_USDM',
      providerGeneration: 7,
      eventTimeMs: 1_720_000_000_100,
    });
    expect(fallback.accepted).toBe(true);
    expect(selectContractHeaderStoreSnapshot(store.getState(), 'BTCUSDT_PERP')?.displayPrice)
      .toBe('63950');
  });

  it('keeps symbol snapshots isolated while switching during hydration', () => {
    const store = createContractMarketStore();
    store.activateSymbol('BTCUSDT_PERP');
    const btcPending = selectContractHeaderStoreSnapshot(store.getState(), 'BTCUSDT_PERP');

    store.activateSymbol('ETHUSDT_PERP');
    const ethPending = selectContractHeaderStoreSnapshot(store.getState(), 'ETHUSDT_PERP');
    store.ingest({
      symbol: 'ETHUSDT_PERP',
      domain: 'ticker',
      data: { display_price: '3500' },
      transport: 'WS',
      provider: 'BINANCE_USDM',
      providerGeneration: 9,
      eventTimeMs: 1_720_000_000_300,
    });
    const ethHydrated = selectContractHeaderStoreSnapshot(store.getState(), 'ETHUSDT_PERP');
    const btcStillPending = selectContractHeaderStoreSnapshot(store.getState(), 'BTCUSDT_PERP');

    expect(btcPending).toMatchObject({ symbol: 'BTCUSDT_PERP', displayPrice: null });
    expect(ethPending).toMatchObject({ symbol: 'ETHUSDT_PERP', displayPrice: null });
    expect(ethHydrated).toMatchObject({ symbol: 'ETHUSDT_PERP', displayPrice: '3500' });
    expect(btcStillPending).toBe(btcPending);
    expect(btcStillPending?.displayPrice).toBeNull();
  });
});
