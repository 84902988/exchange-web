import { describe, expect, it } from '@jest/globals';
import {
  contractMarketStore,
  createContractMarketStore,
} from '../../../lib/realtime/contractMarketStore';
import {
  activateContractMarketShadowSymbol,
  hydrateContractMarketViewShadow,
  projectContractMarketViewStoreAuthority,
  selectContractHeaderStoreSnapshot,
  selectContractMarketViewStoreAuthoritySnapshot,
  writeContractMarketShadowDomain,
} from './contractMarketStoreAdapter';

describe('Contract Header realtime Store hydration', () => {
  it('can hydrate live market-state domains without replaying its embedded K-line', () => {
    const symbol = 'EURUSD_MARKET_STATE_DOMAIN_TEST_PERP';
    activateContractMarketShadowSymbol(symbol);

    const results = hydrateContractMarketViewShadow({
      symbol,
      ticker: { last_price: '1.14205' },
      depth: { bids: [['1.14197', '1']], asks: [['1.14212', '1']] },
      trades: [{ id: 'trade-1', price: '1.14205', qty: '1', time: 1_720_000_000_100 }],
      kline_current_candle: {
        interval: '1m',
        open_time: 1_720_000_000_000,
        open: '1.14200',
        high: '1.14210',
        low: '1.14190',
        close: '1.14205',
        volume: '10',
      },
    }, 'WS', ['ticker', 'depth', 'trades']);

    expect(results.map((result) => result.entry?.domain)).toEqual([
      'ticker',
      'depth',
      'trades',
    ]);
    expect(contractMarketStore.getEntry(symbol, 'kline', '1m')).toBeNull();
  });

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

  it('does not expose an iTick quote-derived spread as Header BBO', () => {
    const store = createContractMarketStore();
    store.activateSymbol('EURUSD_PERP');
    store.ingest({
      symbol: 'EURUSD_PERP',
      domain: 'ticker',
      data: {
        display_price: '1.14250',
        best_bid: '1.14193',
        best_ask: '1.14307',
        market_status: 'OPEN',
        executable: true,
      },
      transport: 'WS',
      source: 'LIVE_WS',
      provider: 'ITICK',
      freshness: 'LIVE',
      eventTimeMs: Date.now(),
    });

    expect(selectContractHeaderStoreSnapshot(store.getState(), 'EURUSD_PERP'))
      .toMatchObject({
        displayPrice: '1.14250',
        bestBid: null,
        bestAsk: null,
        spread: null,
      });
  });

  it('lets a newer executable depth recover stale unavailable Header structure', () => {
    const store = createContractMarketStore();
    const nowMs = Date.now();
    store.activateSymbol('NAS100USDT_PERP');
    store.ingest({
      symbol: 'NAS100USDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '28943.38',
        display_state: 'UNAVAILABLE',
        market_status: 'UNKNOWN',
        executable: false,
      },
      transport: 'WS',
      source: 'ITICK_QUOTE',
      provider: 'ITICK',
      freshness: 'RECENT',
      eventTimeMs: nowMs - 20,
    });
    store.ingest({
      symbol: 'NAS100USDT_PERP',
      domain: 'depth',
      data: {
        bids: [['29053.88', '1']],
        asks: [['29054.88', '1']],
        market_status: 'OPEN',
        executable: true,
      },
      transport: 'WS',
      source: 'ITICK_DEPTH',
      provider: 'ITICK',
      freshness: 'LIVE',
      eventTimeMs: nowMs - 10,
    });

    expect(selectContractHeaderStoreSnapshot(store.getState(), 'NAS100USDT_PERP'))
      .toMatchObject({
        displayState: 'LIVE_TRADABLE',
        marketStatus: 'OPEN',
        executable: true,
        bestBid: '29053.88',
        bestAsk: '29054.88',
        source: 'ITICK_DEPTH',
        freshness: 'LIVE',
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

describe('Contract MarketView realtime Store recovery', () => {
  it('restores a live MarketView from accepted WS ticker and depth authority', () => {
    const store = createContractMarketStore();
    const nowMs = Date.now();
    store.activateSymbol('XAUUSDT_PERP');
    store.ingest({
      symbol: 'XAUUSDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '4012.5',
        display_price_source: 'LIVE_MID',
        display_state: 'LIVE_TRADABLE',
        market_status: 'OPEN',
        executable: true,
        execution_mode: 'NATIVE_BBO',
      },
      transport: 'WS',
      source: 'ITICK_QUOTE',
      provider: 'ITICK',
      freshness: 'LIVE',
      eventTimeMs: nowMs - 20,
    });
    store.ingest({
      symbol: 'XAUUSDT_PERP',
      domain: 'depth',
      data: {
        bids: [['4012.1', '1']],
        asks: [['4012.9', '1']],
        executable: true,
      },
      transport: 'WS',
      source: 'ITICK_DEPTH',
      provider: 'ITICK',
      freshness: 'LIVE',
      eventTimeMs: nowMs - 10,
    });

    const authority = selectContractMarketViewStoreAuthoritySnapshot(
      store.getState(),
      'XAUUSDT_PERP',
    );
    const projected = projectContractMarketViewStoreAuthority(authority, {
      symbol: 'XAUUSDT_PERP',
      display_symbol: 'XAU/USDT',
      market_type: 'CONTRACT',
      category: 'METAL',
      market_status: 'UNKNOWN',
      display_state: 'UNAVAILABLE',
      display_price: '3999',
      display_price_source: 'KLINE_CLOSE',
      best_bid: null,
      best_ask: null,
      spread: null,
      executable: false,
      execution_bid: null,
      execution_ask: null,
      execution_mode: 'UNAVAILABLE',
      last_good_bbo_valid: false,
      reason_code: 'REST_REJECTED',
      warnings: [],
      raw_source_summary: {},
    }, nowMs);

    expect(projected).toMatchObject({
      symbol: 'XAUUSDT_PERP',
      category: 'METAL',
      display_state: 'LIVE_TRADABLE',
      display_price: '4012.5',
      best_bid: '4012.1',
      best_ask: '4012.9',
      executable: true,
      execution_bid: '4012.1',
      execution_ask: '4012.9',
      ticker_source: 'ITICK_QUOTE',
      depth_source: 'ITICK_DEPTH',
    });
    expect(projected?.raw_source_summary).toMatchObject({
      authority_source: 'CONTRACT_MARKET_STORE',
    });
  });

  it('does not promote REST-only or stale Store data to realtime MarketView authority', () => {
    const nowMs = Date.now();
    const restStore = createContractMarketStore();
    restStore.activateSymbol('EURUSDT_PERP');
    restStore.ingest({
      symbol: 'EURUSDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '1.14',
        display_state: 'LIVE_TRADABLE',
        executable: true,
        best_bid: '1.13',
        best_ask: '1.15',
      },
      transport: 'REST',
      freshness: 'LIVE',
      eventTimeMs: nowMs,
    });
    const restAuthority = selectContractMarketViewStoreAuthoritySnapshot(
      restStore.getState(),
      'EURUSDT_PERP',
    );
    expect(projectContractMarketViewStoreAuthority(restAuthority)).toBeNull();

    const staleStore = createContractMarketStore();
    staleStore.activateSymbol('EURUSDT_PERP');
    staleStore.ingest({
      symbol: 'EURUSDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '1.14',
        display_state: 'LIVE_TRADABLE',
        executable: true,
        best_bid: '1.13',
        best_ask: '1.15',
      },
      transport: 'WS',
      freshness: 'STALE',
      stale: true,
      eventTimeMs: nowMs,
    });
    const staleAuthority = selectContractMarketViewStoreAuthoritySnapshot(
      staleStore.getState(),
      'EURUSDT_PERP',
    );
    expect(projectContractMarketViewStoreAuthority(staleAuthority)).toBeNull();
  });

  it('requires iTick depth or explicit execution fields for realtime BBO authority', () => {
    const store = createContractMarketStore();
    const nowMs = Date.now();
    store.activateSymbol('XAUUSDT_PERP');
    store.ingest({
      symbol: 'XAUUSDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '4012.5',
        display_state: 'LIVE_TRADABLE',
        executable: true,
        best_bid: '4010.49',
        best_ask: '4014.51',
      },
      transport: 'WS',
      source: 'LIVE_WS',
      provider: 'ITICK',
      freshness: 'LIVE',
      eventTimeMs: nowMs,
    });

    const authority = selectContractMarketViewStoreAuthoritySnapshot(
      store.getState(),
      'XAUUSDT_PERP',
    );
    expect(authority).toMatchObject({
      bestBid: null,
      bestAsk: null,
      executionBid: null,
      executionAsk: null,
      hasRealtimeBboAuthority: false,
    });
    expect(projectContractMarketViewStoreAuthority(authority, null, nowMs)).toBeNull();
  });

  it('does not combine a REST ticker with WS depth into realtime MarketView authority', () => {
    const store = createContractMarketStore();
    const nowMs = Date.now();
    store.activateSymbol('AAPLUSDT_PERP');
    store.ingest({
      symbol: 'AAPLUSDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '230',
        display_state: 'LIVE_TRADABLE',
        executable: true,
      },
      transport: 'REST',
      freshness: 'LIVE',
      eventTimeMs: nowMs - 20,
    });
    store.ingest({
      symbol: 'AAPLUSDT_PERP',
      domain: 'depth',
      data: {
        bids: [['229.9', '10']],
        asks: [['230.1', '10']],
        executable: true,
      },
      transport: 'WS',
      freshness: 'LIVE',
      eventTimeMs: nowMs - 10,
    });

    const authority = selectContractMarketViewStoreAuthoritySnapshot(
      store.getState(),
      'AAPLUSDT_PERP',
    );
    expect(authority?.hasRealtimeAuthority).toBe(false);
    expect(projectContractMarketViewStoreAuthority(authority, null, nowMs)).toBeNull();
  });

  it('expires recovered Store authority instead of keeping an old WS frame tradable', () => {
    const store = createContractMarketStore();
    const nowMs = Date.now();
    store.activateSymbol('BTCUSDT_PERP');
    store.ingest({
      symbol: 'BTCUSDT_PERP',
      domain: 'ticker',
      data: {
        display_price: '64000',
        display_state: 'LIVE_TRADABLE',
        executable: true,
        best_bid: '63999',
        best_ask: '64001',
      },
      transport: 'WS',
      freshness: 'LIVE',
      eventTimeMs: nowMs - 10_000,
    });
    const authority = selectContractMarketViewStoreAuthoritySnapshot(
      store.getState(),
      'BTCUSDT_PERP',
    );

    expect(projectContractMarketViewStoreAuthority(authority, null, nowMs)).toBeNull();
  });

  it('does not inherit structural authority from a REST ticker into a WS quote', () => {
    const symbol = 'REST_TO_WS_RECOVERY_TEST_PERP';
    activateContractMarketShadowSymbol(symbol);
    hydrateContractMarketViewShadow({
      symbol,
      display_state: 'LIVE_TRADABLE',
      display_price: '100',
      executable: true,
      execution_mode: 'NATIVE_BBO',
      ticker: { last_price: '100', ts: 1_720_000_000_100 },
    }, 'REST');
    writeContractMarketShadowDomain({
      symbol,
      domain: 'ticker',
      data: { last_price: '101' },
      transport: 'WS',
      metadata: { ts: 1_720_000_000_200 },
    });

    expect(contractMarketStore.getEntry<Record<string, unknown>>(symbol, 'ticker')?.data)
      .toEqual({ last_price: '101' });
  });

  it('preserves REST 24h evidence when a newer WS ticker only updates price', () => {
    const symbol = 'EURUSD_PERP';
    activateContractMarketShadowSymbol(symbol);
    writeContractMarketShadowDomain({
      symbol,
      domain: 'ticker',
      data: {
        last_price: '1.14219',
        price_change_24h: '0.00075',
        price_change_percent_24h: '0.065704',
        high_24h: '1.14278',
        low_24h: '1.14088',
        base_volume_24h: '259978.6',
        quote_volume_24h: '296805.11612',
      },
      transport: 'REST',
      metadata: { ts: 1_720_000_000_100 },
    });
    writeContractMarketShadowDomain({
      symbol,
      domain: 'ticker',
      data: {
        last_price: '1.14227',
        price_change_24h: null,
        price_change_percent_24h: null,
      },
      transport: 'WS',
      metadata: { ts: 1_720_000_000_200 },
    });

    expect(contractMarketStore.getEntry<Record<string, unknown>>(symbol, 'ticker')?.data)
      .toMatchObject({
        last_price: '1.14227',
        price_change_24h: '0.00075',
        price_change_percent_24h: '0.065704',
        high_24h: '1.14278',
        low_24h: '1.14088',
        base_volume_24h: '259978.6',
        quote_volume_24h: '296805.11612',
      });
  });

  it('does not treat explicit zero ticker evidence as missing', () => {
    const symbol = 'ZERO_CHANGE_PERP';
    activateContractMarketShadowSymbol(symbol);
    writeContractMarketShadowDomain({
      symbol,
      domain: 'ticker',
      data: { price_change_24h: '1', price_change_percent_24h: '2' },
      transport: 'WS',
      metadata: { ts: 1_720_000_000_100 },
    });
    writeContractMarketShadowDomain({
      symbol,
      domain: 'ticker',
      data: { price_change_24h: 0, price_change_percent_24h: 0 },
      transport: 'WS',
      metadata: { ts: 1_720_000_000_200 },
    });

    expect(contractMarketStore.getEntry<Record<string, unknown>>(symbol, 'ticker')?.data)
      .toMatchObject({ price_change_24h: 0, price_change_percent_24h: 0 });
  });

  it('preserves structural state when a newer quote updates the shared ticker domain', () => {
    const symbol = 'STORE_RECOVERY_TEST_PERP';
    activateContractMarketShadowSymbol(symbol);
    hydrateContractMarketViewShadow({
      symbol,
      display_state: 'LIVE_TRADABLE',
      display_price: '100',
      display_price_source: 'LIVE_MID',
      market_status: 'OPEN',
      executable: true,
      execution_mode: 'NATIVE_BBO',
      reason_code: '',
      ticker: { last_price: '100', ts: 1_720_000_000_100 },
    }, 'WS');
    writeContractMarketShadowDomain({
      symbol,
      domain: 'ticker',
      data: {
        last_price: '101',
        best_bid: '100.5',
        best_ask: '101.5',
        market_status: 'OPEN',
        executable: true,
      },
      transport: 'WS',
      metadata: { ts: 1_720_000_000_200 },
    });

    expect(contractMarketStore.getEntry<Record<string, unknown>>(symbol, 'ticker')?.data)
      .toMatchObject({
        last_price: '101',
        display_state: 'LIVE_TRADABLE',
        execution_mode: 'NATIVE_BBO',
      });
  });

  it('advances Forex Header price from a trusted live quote after a full WS market state', () => {
    const symbol = 'GBPUSD_PERP';
    activateContractMarketShadowSymbol(symbol);
    hydrateContractMarketViewShadow({
      symbol,
      display_state: 'LIVE_TRADABLE',
      display_price: '1.33811',
      display_price_source: 'TRADE_TICK',
      current_price_source: 'TRADE_TICK',
      executable: true,
      ticker: {
        provider: 'ITICK',
        last_price: '1.33811',
        source: 'ITICK_LIVE_WS_DERIVED_BBO',
        quote_freshness: 'LIVE',
      },
      snapshot_metadata: {
        ticker: {
          provider: 'ITICK',
          provider_generation: 7,
          revision: { epoch: 7, sequence: 20 },
          provider_event_time_ms: 1_720_000_000_100,
        },
      },
    }, 'WS');

    const result = writeContractMarketShadowDomain({
      symbol,
      domain: 'ticker',
      data: {
        provider: 'ITICK',
        last_price: '1.33818',
        mark_price: '1.33821',
        source: 'ITICK_LIVE_WS_DERIVED_BBO',
        quote_freshness: 'LIVE',
        price_source: 'TRADE_TICK',
      },
      transport: 'WS',
      metadata: {
        provider: 'ITICK',
        provider_generation: 7,
        revision: { epoch: 7, sequence: 21 },
        provider_event_time_ms: 1_720_000_000_200,
      },
    });

    expect(result).toMatchObject({ accepted: true });
    expect(selectContractHeaderStoreSnapshot(
      contractMarketStore.getState(),
      symbol,
    )).toMatchObject({
      displayPrice: '1.33818',
      displayPriceSource: 'TRADE_TICK',
      markPrice: '1.33821',
      providerGeneration: 7,
      revision: { epoch: 7, sequence: 21 },
    });
  });

  it('keeps MarketView display authority isolated from a later raw quote increment', () => {
    const symbol = 'SPX_AUTHORITY_ISOLATION_PERP';
    activateContractMarketShadowSymbol(symbol);
    hydrateContractMarketViewShadow({
      symbol,
      display_state: 'UNAVAILABLE',
      display_price: '7490.98',
      display_price_source: 'KLINE_CLOSE',
      current_price_source: 'KLINE_CLOSE',
      executable: false,
      ticker: {
        last_price: '7443.29',
        quote_freshness: 'LAST_VALID',
        ts: 1_720_000_000_100,
      },
    }, 'WS');

    writeContractMarketShadowDomain({
      symbol,
      domain: 'ticker',
      data: {
        last_price: '0.35',
        quote_freshness: 'LAST_VALID',
      },
      transport: 'WS',
      metadata: { ts: 1_720_000_000_200 },
    });

    const snapshot = selectContractMarketViewStoreAuthoritySnapshot(
      contractMarketStore.getState(),
      symbol,
    );
    expect(snapshot).toMatchObject({
      displayPrice: '7490.98',
      displayPriceSource: 'KLINE_CLOSE',
      displayState: 'UNAVAILABLE',
      executable: false,
    });
  });

  it('recovers stale unavailable structure from a same-symbol live REST view', () => {
    const symbol = 'SPX_STRUCTURAL_RECOVERY_PERP';
    const nowMs = Date.now();
    activateContractMarketShadowSymbol(symbol);
    hydrateContractMarketViewShadow({
      symbol,
      display_state: 'UNAVAILABLE',
      display_price: '7443.29',
      display_price_source: 'KLINE_CLOSE',
      current_price_source: 'KLINE_CLOSE',
      market_status: 'OPEN',
      executable: false,
      reason_code: 'BBO_UNAVAILABLE',
      ticker: {
        last_price: '7443.29',
        provider: 'ITICK',
        quote_freshness: 'LAST_VALID',
      },
    }, 'WS');
    writeContractMarketShadowDomain({
      symbol,
      domain: 'ticker',
      data: {
        last_price: '7485.40',
        provider: 'ITICK',
        market_status: 'OPEN',
      },
      transport: 'WS',
      metadata: { ts: nowMs - 20, provider: 'ITICK' },
    });
    writeContractMarketShadowDomain({
      symbol,
      domain: 'depth',
      data: {
        bids: [['7481.17', '1']],
        asks: [['7488.65', '1']],
        executable: true,
      },
      transport: 'WS',
      metadata: { ts: nowMs - 10, provider: 'ITICK' },
    });

    const snapshot = selectContractMarketViewStoreAuthoritySnapshot(
      contractMarketStore.getState(),
      symbol,
    );
    expect(snapshot).toMatchObject({
      displayState: 'UNAVAILABLE',
      executable: true,
      executionBid: '7481.17',
      executionAsk: '7488.65',
    });

    const projected = projectContractMarketViewStoreAuthority(snapshot, {
      symbol,
      display_symbol: 'SPX/USDT',
      market_type: 'CONTRACT',
      category: 'INDEX',
      market_status: 'OPEN',
      display_state: 'LIVE_TRADABLE',
      display_price: '7485.40',
      display_price_source: 'TRADE_TICK',
      current_price_source: 'TRADE_TICK',
      best_bid: '7481.17',
      best_ask: '7488.65',
      spread: '7.48',
      executable: true,
      execution_bid: '7481.17',
      execution_ask: '7488.65',
      execution_mode: 'LIVE_BBO',
      last_good_bbo_valid: false,
      reason_code: 'LIVE_BBO',
      warnings: [],
      raw_source_summary: {},
    }, nowMs);

    expect(projected).toMatchObject({
      display_state: 'LIVE_TRADABLE',
      display_price: '7485.40',
      display_price_source: 'TRADE_TICK',
      executable: true,
      execution_bid: '7481.17',
      execution_ask: '7488.65',
      reason_code: 'LIVE_BBO',
    });
    expect(projected?.raw_source_summary).toMatchObject({
      authority_source: 'CONTRACT_MARKET_STORE_WITH_REST_STRUCTURE',
    });
  });

  it('treats explicit null MarketView price as a clear instead of reviving embedded ticker data', () => {
    const symbol = 'DJI_NULL_AUTHORITY_PERP';
    activateContractMarketShadowSymbol(symbol);
    hydrateContractMarketViewShadow({
      symbol,
      display_state: 'UNAVAILABLE',
      display_price: null,
      display_price_source: 'NONE',
      current_price_source: 'NONE',
      executable: false,
      ticker: {
        display_price: '0.35',
        display_price_source: 'LIVE_MID',
        last_price: '51844.20',
        ts: 1_720_000_000_300,
      },
    }, 'WS');

    const ticker = contractMarketStore.getEntry<Record<string, unknown>>(symbol, 'ticker')?.data;
    const snapshot = selectContractMarketViewStoreAuthoritySnapshot(
      contractMarketStore.getState(),
      symbol,
    );

    expect(ticker).toMatchObject({
      display_price: null,
      display_price_source: 'NONE',
      current_price_source: 'NONE',
    });
    expect(snapshot).toMatchObject({
      displayPrice: null,
      displayPriceSource: null,
      displayState: 'UNAVAILABLE',
      executable: false,
    });
  });

  it('projects the selected BBO domain into canonical live execution authority', () => {
    const symbol = 'EURUSD_CANONICAL_EXECUTION_PERP';
    const nowMs = Date.now();
    activateContractMarketShadowSymbol(symbol);
    writeContractMarketShadowDomain({
      symbol,
      domain: 'ticker',
      data: {
        display_price: '1.14025',
        display_state: 'LIVE_TRADABLE',
        executable: true,
        execution_mode: 'NATIVE_BBO',
        reason_code: 'TICKER_STRUCTURE',
      },
      transport: 'WS',
      metadata: { ts: nowMs - 20, freshness: 'LIVE' },
    });
    writeContractMarketShadowDomain({
      symbol,
      domain: 'depth',
      data: {
        execution_bid: '1.14017',
        execution_ask: '1.14033',
        executable: true,
        execution_mode: 'LIVE_BBO',
        reason_code: 'LIVE_BBO',
        depth_freshness: 'LIVE',
      },
      transport: 'WS',
      metadata: { ts: nowMs - 10, freshness: 'LIVE' },
    });

    const snapshot = selectContractMarketViewStoreAuthoritySnapshot(
      contractMarketStore.getState(),
      symbol,
    );
    expect(snapshot).toMatchObject({
      executionMode: 'LIVE_BBO',
      reasonCode: 'LIVE_BBO',
      executionBid: '1.14017',
      executionAsk: '1.14033',
    });

    expect(projectContractMarketViewStoreAuthority(snapshot, null, nowMs))
      .toMatchObject({
        execution_mode: 'LIVE_BBO',
        depth_freshness: 'LIVE',
        executable: true,
      });
  });
});
