import {
  __resetMobileMarketCacheForTests,
  fetchMobileMarkets,
  formatMarketPrice,
  getCachedMobileMarkets,
  getOverviewMarkets,
  MOBILE_MARKETS_MAX_STALE_MS,
  type MarketInstrument,
} from '../src/api/market';

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  } as unknown as Response;
}

describe('mobile market catalog', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    __resetMobileMarketCacheForTests();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('formats each market using its own backend-selected price precision', () => {
    const instrument = {
      id: 'BTCUSDT',
      symbol: 'BTCUSDT',
      displaySymbol: 'BTC/USDT',
      name: 'Bitcoin',
      category: 'crypto',
      price: 76_770,
      changePercent: 0,
      pricePrecision: 1,
      source: 'api',
    } as MarketInstrument;

    expect(formatMarketPrice(instrument)).toBe('76,770.0');
    expect(
      formatMarketPrice({ ...instrument, price: 3200, pricePrecision: 2 }),
    ).toBe('3,200.00');
  });

  it('returns an empty catalog instead of fabricated prices when APIs are empty', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/market/mobile/overview')) {
        return Promise.resolve(
          jsonResponse({overview_cards: [], sections: []}),
        );
      }
      if (url.includes('/market/pairs')) {
        return Promise.resolve(jsonResponse({items: []}));
      }
      if (url.includes('/market/tickers')) {
        return Promise.resolve(jsonResponse([]));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(fetchMobileMarkets()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('single-flights concurrent catalog loads', async () => {
    let release!: (response: Response) => void;
    const gate = new Promise<Response>(resolve => {
      release = resolve;
    });
    fetchMock.mockReturnValue(gate);

    const first = fetchMobileMarkets();
    const second = fetchMobileMarkets();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    release(
      jsonResponse({
        overview_cards: [
          {
            symbol: 'BTCUSDT',
            display_symbol: 'BTC',
            name: 'Bitcoin',
            category: 'spot',
            price: '100',
            change_pct: '1.25',
            price_precision: 2,
            tradable: true,
            trade_market: 'spot',
            trade_symbol: 'BTCUSDT',
            trade_status: 'ENABLED',
          },
        ],
        sections: [],
      }),
    );

    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(firstResult).toEqual(secondResult);
    expect(firstResult[0]).toMatchObject({
      symbol: 'BTCUSDT',
      price: 100,
      source: 'api',
      tradable: true,
      tradeMarket: 'spot',
      tradeSymbol: 'BTCUSDT',
      tradeStatus: 'ENABLED',
    });
  });

  it('orders home shortcuts by the four backend-configured symbols', () => {
    const instrument = (symbol: string, overviewRank: number): MarketInstrument => ({
      id: symbol,
      symbol,
      displaySymbol: symbol,
      name: symbol,
      category: 'crypto',
      price: 1,
      changePercent: 0,
      pricePrecision: 2,
      source: 'api',
      overviewRank,
    });
    const markets = [
      instrument('BTCUSDT', 0),
      instrument('RCBUSDT', 1),
      instrument('ETHUSDT', 2),
      instrument('NVDAUSDTPERP', 3),
    ];

    expect(
      getOverviewMarkets(markets, [
        'ETHUSDT',
        'BTCUSDT',
        'NVDAUSDT_PERP',
        'RCBUSDT',
      ]).map(item => item.symbol),
    ).toEqual(['ETHUSDT', 'BTCUSDT', 'NVDAUSDTPERP', 'RCBUSDT']);
  });

  it('preserves backend hot ranks when section rows repeat overview cards', async () => {
    const marketRow = (symbol: string, changePct: string) => ({
      symbol,
      display_symbol: symbol.replace('USDT', ''),
      name: symbol,
      category: 'spot',
      price: '100',
      change_pct: changePct,
      tradable: true,
      trade_market: 'spot',
      trade_symbol: symbol,
      trade_status: 'ENABLED',
    });
    const configured = [
      marketRow('BTCUSDT', '0.1'),
      marketRow('RCBUSDT', '0.2'),
      marketRow('ETHUSDT', '0.3'),
    ];
    fetchMock.mockResolvedValue(
      jsonResponse({
        overview_cards: configured,
        sections: [
          {
            key: 'spot',
            items: [
              marketRow('ETHUSDT', '8.8'),
              marketRow('BTCUSDT', '9.9'),
              marketRow('RCBUSDT', '7.7'),
            ],
          },
        ],
      }),
    );

    const markets = await fetchMobileMarkets();

    expect(getOverviewMarkets(markets).map(item => item.symbol)).toEqual([
      'BTCUSDT',
      'RCBUSDT',
      'ETHUSDT',
    ]);
    expect(markets.map(item => item.overviewRank)).toEqual([0, 1, 2]);
  });

  it('keeps backend ONCHAIN-labelled RWA spot pairs discoverable as crypto', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        overview_cards: [],
        sections: [
          {
            key: 'onchain',
            items: [
              {
                symbol: 'MFCUSDT',
                display_symbol: 'MFC',
                name: 'MFC',
                category: 'onchain',
                price: '0.108',
                change_pct: '0',
                tradable: false,
                trade_market: null,
                trade_symbol: null,
                trade_status: 'UNSUPPORTED',
              },
            ],
          },
        ],
      }),
    );

    await expect(fetchMobileMarkets()).resolves.toEqual([
      expect.objectContaining({
        symbol: 'MFCUSDT',
        category: 'crypto',
        price: 0.108,
      }),
    ]);
  });

  it('enriches overview rows only with backend-configured product logos', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/market/pairs')) {
        return Promise.resolve(
          jsonResponse({
            items: [
              {
                symbol: 'MFCUSDT',
                base_asset_logo_url:
                  '/static/uploads/assets/mfc-base.svg',
                spot_logo_url:
                  '/static/uploads/assets/mfc-product.svg',
              },
            ],
          }),
        );
      }
      return Promise.resolve(
        jsonResponse({
          overview_cards: [],
          sections: [
            {
              key: 'onchain',
              items: [
                {
                  symbol: 'MFCUSDT',
                  display_symbol: 'MFC',
                  name: 'MFC',
                  category: 'onchain',
                  price: '0.108',
                  change_pct: '0',
                },
              ],
            },
          ],
        }),
      );
    });

    await expect(fetchMobileMarkets()).resolves.toEqual([
      expect.objectContaining({
        symbol: 'MFCUSDT',
        category: 'crypto',
        logoUrl: '/static/uploads/assets/mfc-product.svg',
      }),
    ]);
  });

  it('does not expose CFD rows outside the enabled PC trading catalog', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        overview_cards: [
          {
            symbol: 'BTCUSDT',
            display_symbol: 'BTC',
            name: 'Bitcoin',
            category: 'spot',
            price: '63588.4',
            change_pct: '1.61',
            tradable: true,
            trade_market: 'spot',
            trade_symbol: 'BTCUSDT',
            trade_status: 'ENABLED',
          },
        ],
        sections: [
          {
            key: 'contract_cfd',
            items: [
              {
                symbol: 'XAGEURUSDT',
                display_symbol: 'XAGEUR',
                name: 'XAGEUR',
                category: 'contract_cfd',
                price: '28.4',
                change_pct: '-0.2',
                tradable: false,
                trade_market: 'contract',
                trade_symbol: null,
                trade_status: 'MARKET_DATA_ONLY',
              },
            ],
          },
        ],
      }),
    );

    await expect(fetchMobileMarkets()).resolves.toEqual([
      expect.objectContaining({
        symbol: 'BTCUSDT',
        price: 63588.4,
        tradable: true,
        tradeMarket: 'spot',
        tradeSymbol: 'BTCUSDT',
        tradeStatus: 'ENABLED',
      }),
    ]);
  });

  it('does not expose a catalog cache after its bounded stale window', async () => {
    let now = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => now);
    fetchMock.mockResolvedValue(
      jsonResponse({
        overview_cards: [
          {
            symbol: 'BTCUSDT',
            display_symbol: 'BTC',
            name: 'Bitcoin',
            category: 'spot',
            price: '100',
            change_pct: '1.25',
          },
        ],
        sections: [],
      }),
    );

    await fetchMobileMarkets();
    expect(getCachedMobileMarkets()).toHaveLength(1);

    now += MOBILE_MARKETS_MAX_STALE_MS + 1;
    expect(getCachedMobileMarkets()).toEqual([]);
    nowSpy.mockRestore();
  });

  it('uses a valid non-empty legacy catalog when the mobile contract is malformed', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/market/mobile/overview')) {
        return Promise.resolve(jsonResponse({data: []}));
      }
      if (url.includes('/market/pairs')) {
        return Promise.resolve(
          jsonResponse({
            items: [
              {
                symbol: 'ETHUSDT',
                display_symbol: 'ETH',
                category: 'spot',
                display_price_precision: 3,
              },
            ],
          }),
        );
      }
      if (url.includes('/market/tickers')) {
        return Promise.resolve(
          jsonResponse([
            {
              symbol: 'ETHUSDT',
              price: '123.4567',
              change_pct: '0',
            },
          ]),
        );
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(fetchMobileMarkets()).resolves.toEqual([
      expect.objectContaining({
        symbol: 'ETHUSDT',
        price: 123.4567,
        pricePrecision: 3,
      }),
    ]);
  });

  it('rejects a malformed catalog instead of presenting it as a real empty state', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/market/mobile/overview')) {
        return Promise.resolve(
          jsonResponse({overview_cards: [{}], sections: []}),
        );
      }
      if (url.includes('/market/pairs')) {
        return Promise.resolve(jsonResponse({unexpected: []}));
      }
      if (url.includes('/market/tickers')) {
        return Promise.resolve(jsonResponse([]));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(fetchMobileMarkets()).rejects.toThrow(
      'Market pairs API returned an invalid market row container',
    );
  });

  it('rejects an invalid primary contract when the fallback is merely empty', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/market/mobile/overview')) {
        return Promise.resolve(jsonResponse({overview_cards: [], sections: null}));
      }
      if (url.includes('/market/pairs')) {
        return Promise.resolve(jsonResponse({items: []}));
      }
      if (url.includes('/market/tickers')) {
        return Promise.resolve(jsonResponse([]));
      }
      throw new Error(`Unexpected URL: ${url}`);
    });

    await expect(fetchMobileMarkets()).rejects.toThrow(
      'Market catalog is unavailable',
    );
  });
});
