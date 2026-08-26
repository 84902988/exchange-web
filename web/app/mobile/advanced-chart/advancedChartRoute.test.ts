import {
  ADVANCED_CHART_BOOTSTRAP_CACHE_TTL_MS,
  ADVANCED_CHART_BOOTSTRAP_CACHE_MAX_ENTRIES,
  clearAdvancedChartBootstrapCache,
  createAdvancedChartBridgeEmitter,
  getAdvancedChartSessionIdForBridge,
  parseAdvancedChartQuery,
  readAdvancedChartBootstrapCache,
  resolveExactContractBootstrap,
  resolveExactSpotBootstrap,
  writeAdvancedChartBootstrapCache,
} from './advancedChartRoute';

function createMemoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

function parsedSpotQuery(sessionId: string) {
  const result = parseAdvancedChartQuery(
    `market=spot&symbol=BTCUSDT&interval=1m&lang=zh&sessionId=${sessionId}`,
  );
  if (!result.ok) throw new Error('expected a valid test query');
  return result.value;
}

function parsedContractQuery(sessionId: string) {
  const result = parseAdvancedChartQuery(
    `market=contract&symbol=XAUUSDT_PERP&interval=1m&lang=zh&sessionId=${sessionId}&category=cfd`,
  );
  if (!result.ok) throw new Error('expected a valid contract test query');
  return result.value;
}

const cachedSpotBootstrap = {
  market: 'spot' as const,
  symbol: 'BTCUSDT',
  displaySymbol: 'BTC/USDT',
  category: null,
  pricePrecision: 2,
  amountPrecision: 6,
  logoUrl: '/static/btc.png',
  logoAlt: 'BTC',
};

describe('mobile advanced chart query contract', () => {
  test('accepts a strict Spot query and preserves sessionId exactly', () => {
    const result = parseAdvancedChartQuery(
      'market=spot&symbol=ethusdt&interval=1m&lang=zh-CN&sessionId=rn:Chart_01',
    );

    expect(result).toEqual({
      ok: true,
      value: {
        market: 'spot',
        symbol: 'ETHUSDT',
        interval: '1m',
        locale: 'zh',
        sessionId: 'rn:Chart_01',
        category: null,
      },
    });
  });

  test('accepts contract dot symbols and a validated category hint', () => {
    const result = parseAdvancedChartQuery(
      'market=contract&symbol=brk.b&interval=1d&lang=en-US&sessionId=session-2&category=stock',
    );

    expect(result).toEqual({
      ok: true,
      value: {
        market: 'contract',
        symbol: 'BRK.B',
        interval: '1d',
        locale: 'en',
        sessionId: 'session-2',
        category: 'STOCK',
      },
    });
  });

  test.each([
    'market=spot&symbol=ETHUSDT&interval=2m&lang=zh&sessionId=s1',
    'market=spot&symbol=ETH.USDT&interval=1m&lang=zh&sessionId=s1',
    'market=spot&symbol=ETHUSDT&interval=1m&lang=xx&sessionId=s1',
    'market=spot&symbol=ETHUSDT&interval=1m&lang=zh&sessionId=s1&category=CRYPTO',
    'market=spot&symbol=ETHUSDT&interval=1m&lang=zh&sessionId=s1&api_base=https%3A%2F%2Fevil.test',
    'market=spot&symbol=ETHUSDT&symbol=BTCUSDT&interval=1m&lang=zh&sessionId=s1',
    'market=spot&symbol=ETHUSDT&interval=1m&lang=zh&sessionId=%20s1',
  ])('rejects an unsafe or ambiguous query: %s', (query) => {
    expect(parseAdvancedChartQuery(query)).toMatchObject({
      ok: false,
      error: { code: 'INVALID_QUERY' },
    });
  });

  test('extracts only a bridge-safe session id from an otherwise invalid query', () => {
    expect(getAdvancedChartSessionIdForBridge('sessionId=abc-1&bad=1')).toBe('abc-1');
    expect(getAdvancedChartSessionIdForBridge('sessionId=%20abc')).toBeNull();
  });
});

describe('mobile advanced chart exact symbol bootstrap', () => {
  test('selects the exact Spot symbol instead of the first fuzzy result', () => {
    const result = resolveExactSpotBootstrap([
      {
        symbol: 'ETHUSDC',
        display_symbol: 'ETH/USDC',
        price_precision: 2,
        amount_precision: 5,
      },
      {
        symbol: 'ETHUSDT',
        display_symbol: 'ETH/USDT',
        price_precision: 3,
        amount_precision: 6,
        base_asset_logo_url: '/static/eth.png',
      },
    ], 'ETHUSDT');

    expect(result).toEqual({
      ok: true,
      value: {
        market: 'spot',
        symbol: 'ETHUSDT',
        displaySymbol: 'ETH/USDT',
        category: null,
        pricePrecision: 3,
        amountPrecision: 6,
        logoUrl: '/static/eth.png',
        logoAlt: null,
      },
    });
  });

  test('uses Spot display precision before tick-size and trading precision', () => {
    expect(resolveExactSpotBootstrap([
      {
        symbol: 'BTCUSDT',
        display_symbol: 'BTC/USDT',
        display_price_precision: 1,
        price_tick_size: '0.1',
        price_precision: 2,
        amount_precision: 6,
      },
    ], 'BTCUSDT')).toMatchObject({
      ok: true,
      value: { pricePrecision: 1 },
    });

    expect(resolveExactSpotBootstrap([
      {
        symbol: 'ETHUSDT',
        display_symbol: 'ETH/USDT',
        display_price_precision: 99,
        price_tick_size: '0.01',
        price_precision: 4,
        amount_precision: 6,
      },
    ], 'ETHUSDT')).toMatchObject({
      ok: true,
      value: { pricePrecision: 2 },
    });
  });

  test('maps Contract quantity precision and backend category from the exact row', () => {
    const result = resolveExactContractBootstrap([
      {
        symbol: 'BRK.A',
        display_name: 'BRK.A',
        category: 'STOCK',
        price_precision: 2,
        quantity_precision: 4,
      },
      {
        symbol: 'BRK.B',
        display_name: 'BRK.B Contract',
        category: 'STOCK',
        price_precision: 3,
        quantity_precision: 5,
      },
    ], 'BRK.B');

    expect(result).toMatchObject({
      ok: true,
      value: {
        market: 'contract',
        symbol: 'BRK.B',
        displaySymbol: 'BRK.B Contract',
        category: 'STOCK',
        pricePrecision: 3,
        amountPrecision: 5,
      },
    });
  });

  test('fails closed for missing symbols or incomplete precision metadata', () => {
    expect(resolveExactSpotBootstrap([], 'ETHUSDT')).toMatchObject({
      ok: false,
      error: { code: 'SYMBOL_NOT_FOUND' },
    });
    expect(resolveExactContractBootstrap([
      { symbol: 'BTCUSDT_PERP', category: 'CRYPTO', price_precision: 2 },
    ], 'BTCUSDT_PERP')).toMatchObject({
      ok: false,
      error: { code: 'METADATA_INVALID' },
    });
  });
});

describe('mobile advanced chart metadata hot-start cache', () => {
  test('reuses only validated public metadata across isolated bridge sessions', () => {
    const storage = createMemoryStorage();
    const firstSession = parsedSpotQuery('session-cache-1');
    const nextSession = parsedSpotQuery('session-cache-2');

    expect(writeAdvancedChartBootstrapCache(firstSession, cachedSpotBootstrap, {
      storage,
      nowMs: 10_000,
    })).toBe(true);
    expect(readAdvancedChartBootstrapCache(nextSession, {
      storage,
      nowMs: 10_050,
    })).toEqual(cachedSpotBootstrap);

    clearAdvancedChartBootstrapCache(nextSession, { storage });
    expect(readAdvancedChartBootstrapCache(firstSession, {
      storage,
      nowMs: 10_060,
    })).toBeNull();
  });

  test('caches the authoritative Contract category when the mobile hint uses a UI group', () => {
    const storage = createMemoryStorage();
    const firstSession = parsedContractQuery('contract-cache-1');
    const nextSession = parsedContractQuery('contract-cache-2');
    const bootstrap = {
      market: 'contract' as const,
      symbol: 'XAUUSDT_PERP',
      displaySymbol: 'XAUUSDT 永续',
      category: 'GOLD',
      pricePrecision: 2,
      amountPrecision: 6,
      logoUrl: null,
      logoAlt: null,
    };

    expect(writeAdvancedChartBootstrapCache(firstSession, bootstrap, {
      storage,
      nowMs: 15_000,
    })).toBe(true);
    expect(readAdvancedChartBootstrapCache(nextSession, {
      storage,
      nowMs: 15_050,
    })).toEqual(bootstrap);
  });

  test('removes expired or corrupted metadata instead of bypassing validation', () => {
    const storage = createMemoryStorage();
    const query = parsedSpotQuery('session-cache-3');
    writeAdvancedChartBootstrapCache(query, cachedSpotBootstrap, {
      storage,
      nowMs: 20_000,
    });

    expect(readAdvancedChartBootstrapCache(query, {
      storage,
      nowMs: 20_000 + ADVANCED_CHART_BOOTSTRAP_CACHE_TTL_MS + 1,
    })).toBeNull();
    expect(storage.values.size).toBe(0);

    writeAdvancedChartBootstrapCache(query, cachedSpotBootstrap, {
      storage,
      nowMs: 30_000,
    });
    const [key] = storage.values.keys();
    storage.values.set(key, JSON.stringify({
      cachedAtMs: 30_000,
      value: { ...cachedSpotBootstrap, symbol: 'ETHUSDT' },
    }));
    expect(readAdvancedChartBootstrapCache(query, {
      storage,
      nowMs: 30_001,
    })).toBeNull();
    expect(storage.values.size).toBe(0);
  });

  test('bounds persistent metadata while retaining the most recent symbols', () => {
    const storage = createMemoryStorage();
    for (let index = 0; index < ADVANCED_CHART_BOOTSTRAP_CACHE_MAX_ENTRIES + 3; index += 1) {
      const symbol = `BTC${index}USDT`;
      const parsed = parseAdvancedChartQuery(
        `market=spot&symbol=${symbol}&interval=1m&lang=zh&sessionId=bounded-${index}`,
      );
      if (!parsed.ok) throw new Error('expected a valid bounded-cache query');
      expect(writeAdvancedChartBootstrapCache(parsed.value, {
        ...cachedSpotBootstrap,
        symbol,
        displaySymbol: `BTC${index}/USDT`,
      }, {
        storage,
        nowMs: 40_000 + index,
      })).toBe(true);
    }

    const [raw] = storage.values.values();
    const entries = JSON.parse(raw).entries as Array<{ identity: string }>;
    expect(entries).toHaveLength(ADVANCED_CHART_BOOTSTRAP_CACHE_MAX_ENTRIES);
    expect(entries[0].identity).toContain('BTC10USDT');
    expect(entries.some((entry) => entry.identity.includes('BTC0USDT'))).toBe(false);
  });

  test('drops the v1 cache after the Spot display-precision schema change', () => {
    const storage = createMemoryStorage();
    storage.values.set(
      'mobile-advanced-chart:bootstrap:v1',
      JSON.stringify({ version: 1, entries: [] }),
    );

    expect(readAdvancedChartBootstrapCache(parsedSpotQuery('session-cache-v2'), {
      storage,
      nowMs: 50_000,
    })).toBeNull();
    expect(storage.values.has('mobile-advanced-chart:bootstrap:v1')).toBe(false);
  });
});

describe('mobile advanced chart bridge', () => {
  test('dedupes lifecycle and consecutive commits while preserving interval round trips', () => {
    const messages: string[] = [];
    const bridge = createAdvancedChartBridgeEmitter((message) => messages.push(message));

    expect(bridge.emit({
      type: 'CHART_READY',
      sessionId: 's1',
      capabilities: ['indicator-config-v2'],
    })).toBe(true);
    expect(bridge.emit({
      type: 'CHART_READY',
      sessionId: 's1',
      capabilities: ['indicator-config-v2'],
    })).toBe(false);
    expect(bridge.emit({
      type: 'INTERVAL_COMMITTED',
      sessionId: 's1',
      interval: '5m',
    })).toBe(true);
    expect(bridge.emit({
      type: 'INTERVAL_COMMITTED',
      sessionId: 's1',
      interval: '5m',
    })).toBe(false);
    expect(bridge.emit({
      type: 'INTERVAL_COMMITTED',
      sessionId: 's1',
      interval: '1m',
    })).toBe(true);
    expect(bridge.emit({
      type: 'INTERVAL_COMMITTED',
      sessionId: 's1',
      interval: '5m',
    })).toBe(true);
    expect(bridge.emit({ type: 'CHART_ERROR', sessionId: 's1', message: 'failed' })).toBe(true);
    expect(bridge.emit({
      type: 'INDICATORS_ERROR',
      sessionId: 's1',
      intentId: 10,
      message: 'failed',
      indicators: null,
    })).toBe(true);
    expect(bridge.emit({
      type: 'INDICATORS_ERROR',
      sessionId: 's1',
      intentId: 11,
      message: 'failed',
      indicators: { overlay: 'MA', pane: 'VOL' },
    })).toBe(true);
    expect(bridge.emit({
      type: 'INDICATORS_COMMITTED',
      sessionId: 's1',
      intentId: 12,
      indicators: { overlay: 'MA', pane: 'VOL' },
    })).toBe(true);
    expect(bridge.emit({
      type: 'INDICATORS_COMMITTED',
      sessionId: 's1',
      intentId: 12,
      indicators: { overlay: 'MA', pane: 'VOL' },
    })).toBe(false);
    expect(bridge.emit({
      type: 'INDICATORS_COMMITTED',
      sessionId: 's1',
      intentId: 13,
      indicators: { overlay: 'EMA', pane: 'MACD' },
    })).toBe(true);
    expect(bridge.emit({
      type: 'INDICATORS_COMMITTED',
      sessionId: 's1',
      intentId: 14,
      indicators: { overlay: 'MA', pane: 'VOL' },
    })).toBe(true);
    const config = {
      protocolVersion: 2,
      overlay: { kind: 'MA', params: { length: 9 } },
      pane: { kind: 'VOL', params: { showMA: false, maLength: 20 } },
    } as const;
    expect(bridge.emit({
      type: 'INDICATOR_CONFIG_COMMITTED',
      sessionId: 's1',
      intentId: 20,
      config,
    })).toBe(true);
    expect(bridge.emit({
      type: 'INDICATOR_CONFIG_COMMITTED',
      sessionId: 's1',
      intentId: 20,
      config,
    })).toBe(false);
    expect(bridge.emit({
      type: 'INDICATOR_CONFIG_ERROR',
      sessionId: 's1',
      intentId: 21,
      message: 'failed',
      config,
    })).toBe(true);

    expect(messages.map((message) => JSON.parse(message))).toEqual([
      {
        type: 'CHART_READY',
        sessionId: 's1',
        capabilities: ['indicator-config-v2'],
      },
      { type: 'INTERVAL_COMMITTED', sessionId: 's1', interval: '5m' },
      { type: 'INTERVAL_COMMITTED', sessionId: 's1', interval: '1m' },
      { type: 'INTERVAL_COMMITTED', sessionId: 's1', interval: '5m' },
      { type: 'CHART_ERROR', sessionId: 's1', message: 'failed' },
      {
        type: 'INDICATORS_ERROR',
        sessionId: 's1',
        intentId: 10,
        message: 'failed',
        indicators: null,
      },
      {
        type: 'INDICATORS_ERROR',
        sessionId: 's1',
        intentId: 11,
        message: 'failed',
        indicators: { overlay: 'MA', pane: 'VOL' },
      },
      {
        type: 'INDICATORS_COMMITTED',
        sessionId: 's1',
        intentId: 12,
        indicators: { overlay: 'MA', pane: 'VOL' },
      },
      {
        type: 'INDICATORS_COMMITTED',
        sessionId: 's1',
        intentId: 13,
        indicators: { overlay: 'EMA', pane: 'MACD' },
      },
      {
        type: 'INDICATORS_COMMITTED',
        sessionId: 's1',
        intentId: 14,
        indicators: { overlay: 'MA', pane: 'VOL' },
      },
      {
        type: 'INDICATOR_CONFIG_COMMITTED',
        sessionId: 's1',
        intentId: 20,
        config,
      },
      {
        type: 'INDICATOR_CONFIG_ERROR',
        sessionId: 's1',
        intentId: 21,
        message: 'failed',
        config,
      },
    ]);
  });

  test('does not consume a dedupe signature when postMessage throws', () => {
    const messages: string[] = [];
    let throwNext = true;
    const bridge = createAdvancedChartBridgeEmitter((message) => {
      if (throwNext) {
        throwNext = false;
        throw new Error('bridge unavailable');
      }
      messages.push(message);
    });
    const ready = {
      type: 'CHART_READY',
      sessionId: 'retry-session',
      capabilities: ['indicator-config-v2'],
    } as const;

    expect(() => bridge.emit(ready)).toThrow('bridge unavailable');
    expect(bridge.emit(ready)).toBe(true);
    expect(bridge.emit(ready)).toBe(false);

    const committed = {
      type: 'INDICATOR_CONFIG_COMMITTED',
      sessionId: 'retry-session',
      intentId: 4,
      config: {
        protocolVersion: 2,
        overlay: { kind: 'MA', params: { length: 9 } },
        pane: { kind: 'VOL', params: { showMA: false, maLength: 20 } },
      },
    } as const;
    throwNext = true;
    expect(() => bridge.emit(committed)).toThrow('bridge unavailable');
    expect(bridge.emit(committed)).toBe(true);
    expect(bridge.emit(committed)).toBe(false);
    expect(messages.map((message) => JSON.parse(message).type)).toEqual([
      'CHART_READY',
      'INDICATOR_CONFIG_COMMITTED',
    ]);
  });
});
