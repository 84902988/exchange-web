import {
  fetchContractQuote,
  fetchContractMarketView,
  formatContractFundingRate,
  isContractExecutionReady,
  normalizeContractMarketViewPayload,
} from '../src/api/contract';
import {
  fetchSpotMarketView,
  normalizeSpotDepthPayload,
  normalizeSpotMarketViewPayload,
  normalizeSpotTickerPayload,
} from '../src/api/spot';
import {
  __resetApiClientForTests,
  setApiAuthTokens,
} from '../src/api/client';

function jsonResponse(payload: unknown): Response {
  return {
    ok: true,
    status: 200,
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  } as unknown as Response;
}

describe('Spot MarketView normalization', () => {
  const payload = {
    symbol: 'BTCUSDT',
    display_price: '64361.9',
    ticker_24h_change_percent: '0.33',
    ticker_24h_high: '65423.7',
    ticker_24h_low: '63605.8',
    ticker_volume: '4902.926959',
    ticker_quote_volume: '316116390.353266775',
    display_price_precision: 1,
    price_tick_size: '0.1',
    amount_precision: 6,
    min_amount: '0.001',
    min_notional: '5',
    best_bid: '64361.8',
    best_ask: '64362.0',
    executable: true,
    market_status: 'OPEN',
    depth_status: 'ok',
    quote_freshness: 'LIVE',
    depth_freshness: 'LIVE',
    trades_freshness: 'RECENT',
    updated_at: '2026-07-31T04:00:00Z',
    warnings: [],
    ticker: {
      symbol: 'BTCUSDT',
      last_price: '64360.0',
      price_precision: 2,
    },
    depth: {
      symbol: 'BTCUSDT',
      bids: [{price: '64361.8', amount: '1.2'}],
      asks: [{price: '64362.0', amount: '2.3'}],
    },
    trades: {
      symbol: 'BTCUSDT',
      items: [
        {
          trade_id: 'trade-1',
          price: '64361.9',
          amount: '0.1',
          side: 'BUY',
          event_time_ms: 1785470431552,
        },
      ],
    },
  };

  it('drops non-positive depth levels while preserving small positive amounts', () => {
    expect(
      normalizeSpotDepthPayload(
        {
          symbol: 'BTCUSDT',
          bids: [
            {price: '64361.8', amount: '0'},
            {price: '64361.7', amount: '0.000015'},
          ],
          asks: [
            ['64362.0', '-1'],
            ['64362.1', '0.000010'],
          ],
        },
        'BTCUSDT',
      ),
    ).toMatchObject({
      bids: [{price: 64361.7, amount: 0.000015}],
      asks: [{price: 64362.1, amount: 0.00001}],
    });
  });

  it('uses the unified display, depth and trades authority', () => {
    const view = normalizeSpotMarketViewPayload(payload, 'BTCUSDT');

    expect(view.ticker).toMatchObject({
      symbol: 'BTCUSDT',
      lastPrice: 64361.9,
      changePercent: 0.33,
      high24h: 65423.7,
      low24h: 63605.8,
      baseVolume24h: 4902.926959,
      quoteVolume24h: 316116390.353266775,
      pricePrecision: 2,
      displayPricePrecision: 1,
      displayPricePrecisionSource: 'display_price_precision',
      priceTickSize: 0.1,
      amountPrecision: 6,
      minAmount: 0.001,
      minNotional: 5,
      freshness: 'LIVE',
      marketStatus: 'OPEN',
      stale: false,
    });
    expect(view.depth.bids[0]).toEqual({price: 64361.8, amount: 1.2});
    expect(view.depth.asks[0]).toEqual({price: 64362, amount: 2.3});
    expect(view.trades[0]).toMatchObject({
      id: 'trade-1',
      price: 64361.9,
      amount: 0.1,
      side: 'BUY',
    });
    expect(view.executable).toBe(true);
  });

  it('derives display precision from tick size before trading precision', () => {
    expect(
      normalizeSpotTickerPayload(
        {
          symbol: 'BTCUSDT',
          last_price: '62567.40',
          price_precision: 2,
          price_tick_size: '0.1',
        },
        'BTCUSDT',
      ),
    ).toMatchObject({
      displayPricePrecision: 1,
      displayPricePrecisionSource: 'price_tick_size',
      pricePrecision: 2,
      priceTickSize: 0.1,
    });
  });

  it('fails closed when the declared BBO is crossed', () => {
    const view = normalizeSpotMarketViewPayload(
      {...payload, best_bid: '64363', best_ask: '64362'},
      'BTCUSDT',
    );

    expect(view.executable).toBe(false);
  });

  it('fails closed for stale depth or a missing market status', () => {
    expect(
      normalizeSpotMarketViewPayload(
        {
          ...payload,
          depth_freshness: 'STALE',
          depth: {...payload.depth, stale: true},
        },
        'BTCUSDT',
      ).executable,
    ).toBe(false);
    expect(
      normalizeSpotMarketViewPayload(
        {...payload, market_status: undefined},
        'BTCUSDT',
      ).executable,
    ).toBe(false);
  });

  it('does not coerce non-decimal ticker values into real market data', () => {
    const view = normalizeSpotMarketViewPayload(
      {
        ...payload,
        ticker_24h_change_percent: true,
      },
      'BTCUSDT',
    );

    expect(view.ticker.changePercent).toBeNull();
  });

  it('preserves zero root metrics and does not replace them with ticker values', () => {
    const view = normalizeSpotMarketViewPayload(
      {
        ...payload,
        ticker_24h_high: '0',
        ticker_24h_low: 0,
        ticker_volume: '0.0',
        ticker_quote_volume: 0,
        ticker: {
          ...payload.ticker,
          high_24h: '10',
          low_24h: '9',
          base_volume_24h: '8',
          quote_volume_24h: '7',
        },
      },
      'BTCUSDT',
    );

    expect(view.ticker).toMatchObject({
      high24h: 0,
      low24h: 0,
      baseVolume24h: 0,
      quoteVolume24h: 0,
    });
  });

  it('normalizes canonical and provider WS aliases without inventing missing values', () => {
    expect(
      normalizeSpotTickerPayload(
        {
          symbol: 'BTCUSDT',
          high24h: '65400.5',
          lowPrice: '63000.25',
          vol24h: 0,
          volCcy24h: '0.0',
        },
        'BTCUSDT',
      ),
    ).toMatchObject({
      high24h: 65400.5,
      low24h: 63000.25,
      baseVolume24h: 0,
      quoteVolume24h: 0,
    });
    expect(
      normalizeSpotTickerPayload(
        {
          symbol: 'BTCUSDT',
          high_24h: null,
          low_24h: true,
          base_volume_24h: {},
          quote_volume_24h: '',
        },
        'BTCUSDT',
      ),
    ).toMatchObject({
      high24h: null,
      low24h: null,
      baseVolume24h: null,
      quoteVolume24h: null,
    });
  });

  it('rejects missing and nested cross-symbol authorities', () => {
    expect(() =>
      normalizeSpotMarketViewPayload(
        {...payload, symbol: undefined},
        'BTCUSDT',
      ),
    ).toThrow('现货行情数据暂不可用');
    expect(() =>
      normalizeSpotMarketViewPayload(
        {
          ...payload,
          depth: {...payload.depth, symbol: 'ETHUSDT'},
        },
        'BTCUSDT',
      ),
    ).toThrow('盘口行情标识不匹配');
  });

  it('rejects a response for a different symbol', () => {
    expect(() =>
      normalizeSpotMarketViewPayload(
        {...payload, symbol: 'ETHUSDT'},
        'BTCUSDT',
      ),
    ).toThrow('现货行情标识不匹配');
  });
});

describe('Contract MarketView normalization', () => {
  it('formats only bounded real funding rates and fails closed otherwise', () => {
    expect(formatContractFundingRate(0.000125)).toBe('资金费率 +0.0125%');
    expect(formatContractFundingRate(0)).toBe('资金费率 0.0000%');
    expect(formatContractFundingRate(-0.0005)).toBe('资金费率 -0.0500%');
    expect(formatContractFundingRate(null)).toBe('资金费率不可用');
    expect(formatContractFundingRate(Number.NaN)).toBe('资金费率不可用');
    expect(formatContractFundingRate(1.01)).toBe('资金费率不可用');
  });

  const payload = {
    symbol: 'BTCUSDT_PERP',
    view_version: '2',
    authority_source: 'SNAPSHOT_AUTHORITY',
    snapshot_authority: true,
    display_price: '64334.7',
    mark_price: '64334.65',
    index_price: '64334.6',
    best_bid: '64334.6',
    best_ask: '64334.7',
    executable: true,
    execution_bid: '64334.6',
    execution_ask: '64334.7',
    execution_mode: 'LIVE_BBO',
    display_state: 'LIVE_TRADABLE',
    market_status: 'OPEN',
    reason_code: 'LIVE_BBO',
    ticker_freshness: 'LIVE',
    depth_freshness: 'LIVE',
    trades_freshness: 'RECENT',
    price_age_ms: 100,
    snapshot_metadata: {
      ticker: {ttl_ms: 1500},
      depth: {ttl_ms: 1200},
    },
    warnings: [],
    ticker: {
      symbol: 'BTCUSDT_PERP',
      price_precision: 1,
      funding_rate: '0.000125',
      price_change_percent_24h: '0.34',
      high_24h: '65410.2',
      low_24h: '63590.4',
      base_volume_24h: '7708218.23',
      quote_volume_24h: '77082.1823',
      single_side_spread_fee_price: '0.05',
      effective_total_spread: '0.1',
    },
    depth: {
      symbol: 'BTCUSDT_PERP',
      price_precision: 1,
      bids: [['64334.6', '551.33']],
      asks: [['64334.7', '420.1']],
    },
    trades: [
      {
        id: 'trade-2',
        symbol: 'BTCUSDT_PERP',
        price: '64334.6',
        qty: '10',
        side: 'SELL',
        time: 1785470435206,
      },
    ],
  };

  it('keeps display BBO separate from trusted execution BBO', () => {
    const view = normalizeContractMarketViewPayload(
      payload,
      'BTCUSDT_PERP',
    );

    expect(view.quote).toMatchObject({
      symbol: 'BTCUSDT_PERP',
      lastPrice: 64334.7,
      markPrice: 64334.65,
      bidPrice: 64334.6,
      askPrice: 64334.7,
      executionBid: 64334.6,
      executionAsk: 64334.7,
      executable: true,
      fundingRate: 0.000125,
      high24h: 65410.2,
      low24h: 63590.4,
      baseVolume24h: 7708218.23,
      quoteVolume24h: 77082.1823,
      pricePrecision: 1,
      snapshotAuthority: true,
    });
    expect(view.depth.bids[0]).toEqual({price: 64334.6, amount: 551.33});
    expect(view.trades[0]).toMatchObject({
      id: 'trade-2',
      price: 64334.6,
      amount: 10,
      side: 'SELL',
    });
    expect(view.priceAgeMs).toBe(100);
    expect(view.executionTtlMs).toBe(1200);
    expect(
      isContractExecutionReady(view.quote, 'BTCUSDT_PERP'),
    ).toBe(true);
  });

  it.each([true, '   ', [], {}, '0x10'])(
    'does not coerce a non-decimal funding rate from %p',
    rawFundingRate => {
      const view = normalizeContractMarketViewPayload(
        {
          ...payload,
          ticker: {
            ...payload.ticker,
            funding_rate: rawFundingRate,
          },
        },
        'BTCUSDT_PERP',
      );

      expect(view.quote.fundingRate).toBeNull();
      expect(formatContractFundingRate(view.quote.fundingRate)).toBe(
        '资金费率不可用',
      );
    },
  );

  it('does not expose execution prices from an untrusted snapshot', () => {
    const view = normalizeContractMarketViewPayload(
      {...payload, snapshot_authority: false},
      'BTCUSDT_PERP',
    );

    expect(view.executable).toBe(false);
    expect(view.quote.executionBid).toBeNull();
    expect(view.quote.executionAsk).toBeNull();
    expect(view.depth.bids).toHaveLength(1);
  });

  it('preserves zero contract metrics and keeps invalid or missing values null', () => {
    const view = normalizeContractMarketViewPayload(
      {
        ...payload,
        ticker: {
          ...payload.ticker,
          high_24h: '0',
          low_24h: 0,
          base_volume_24h: '0.0',
          quote_volume_24h: null,
        },
      },
      'BTCUSDT_PERP',
    );

    expect(view.quote).toMatchObject({
      high24h: 0,
      low24h: 0,
      baseVolume24h: 0,
      quoteVolume24h: null,
    });
  });

  it('fails closed for a crossed execution BBO', () => {
    const view = normalizeContractMarketViewPayload(
      {...payload, execution_bid: '64335', execution_ask: '64334'},
      'BTCUSDT_PERP',
    );

    expect(view.executable).toBe(false);
    expect(view.quote.executionBid).toBeNull();
    expect(view.quote.executionAsk).toBeNull();
  });

  it('requires both ticker and depth TTL metadata for a lease', () => {
    const view = normalizeContractMarketViewPayload(
      {
        ...payload,
        snapshot_metadata: {
          ticker: {ttl_ms: 1500},
        },
      },
      'BTCUSDT_PERP',
    );

    expect(view.executable).toBe(true);
    expect(view.executionTtlMs).toBeNull();
  });

  it('does not report execution readiness for the wrong symbol', () => {
    const view = normalizeContractMarketViewPayload(
      payload,
      'BTCUSDT_PERP',
    );

    expect(
      isContractExecutionReady(view.quote, 'ETHUSDT_PERP'),
    ).toBe(false);
  });

  it('rejects a response for a different symbol', () => {
    expect(() =>
      normalizeContractMarketViewPayload(
        {...payload, symbol: 'ETHUSDT_PERP'},
        'BTCUSDT_PERP',
      ),
    ).toThrow('合约行情标识不匹配');
  });
});

describe('MarketView public bootstrap requests', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    __resetApiClientForTests();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('loads each unified snapshot with one credential-free request', async () => {
    setApiAuthTokens({
      accessToken: 'private-access',
      refreshToken: 'private-refresh',
    });
    const fetchMock = jest.fn(
      (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/market/spot/view')) {
          return Promise.resolve(
            jsonResponse({
              ok: true,
              data: {
                symbol: 'TESTUSDT',
                display_price: '1',
                best_bid: '0.9',
                best_ask: '1.1',
                executable: true,
                depth: {
                  symbol: 'TESTUSDT',
                  bids: [['0.9', '1']],
                  asks: [['1.1', '1']],
                },
                trades: {items: []},
              },
            }),
          );
        }
        return Promise.resolve(
          jsonResponse({
            ok: true,
            data: {
              symbol: 'TESTUSDT_PERP',
              snapshot_authority: true,
              display_price: '1',
              executable: true,
              execution_bid: '0.9',
              execution_ask: '1.1',
              execution_mode: 'LIVE_BBO',
              depth: {
                symbol: 'TESTUSDT_PERP',
                bids: [['0.9', '1']],
                asks: [['1.1', '1']],
              },
              trades: [],
            },
          }),
        );
      },
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(fetchSpotMarketView('TESTUSDT')).resolves.toMatchObject({
      symbol: 'TESTUSDT',
    });
    await expect(
      fetchContractMarketView('TESTUSDT_PERP'),
    ).resolves.toMatchObject({
      symbol: 'TESTUSDT_PERP',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit;
      expect(init.credentials).toBe('omit');
      expect(
        (init.headers as Record<string, string>).Authorization,
      ).toBeUndefined();
    }
  });

  it('maps the contract quote 24h fields while preserving zero and null', async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve(
        jsonResponse({
          ok: true,
          data: {
            symbol: 'ZEROUSDT_PERP',
            last_price: '1',
            high_24h: '0',
            low24h: 0,
            volume_24h: '0.0',
            quoteVolume: null,
          },
        }),
      ),
    );
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(fetchContractQuote('ZEROUSDT_PERP')).resolves.toMatchObject({
      symbol: 'ZEROUSDT_PERP',
      high24h: 0,
      low24h: 0,
      baseVolume24h: 0,
      quoteVolume24h: null,
    });
  });
});
