import {parseMarketDetailRouteParams} from '../src/navigation/marketDetailRoute';

describe('market detail route', () => {
  it('normalizes a valid Spot route without inventing a symbol', () => {
    expect(
      parseMarketDetailRouteParams({
        market: 'spot',
        symbol: 'btcusdt',
        baseAsset: 'btc',
        quoteAsset: 'usdt',
        displayLabel: 'BTC/USDT',
        initialInterval: '5m',
      }),
    ).toEqual({
      market: 'spot',
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      displayLabel: 'BTC/USDT',
      initialInterval: '5m',
    });
  });

  it('normalizes a valid Contract category and safe interval default', () => {
    expect(
      parseMarketDetailRouteParams({
        market: 'contract',
        symbol: 'nvda_perp',
        baseAsset: 'nvda',
        quoteAsset: 'usd',
        displayLabel: 'NVIDIA',
        marketCategory: 'stock',
        initialInterval: '3m',
      }),
    ).toEqual({
      market: 'contract',
      symbol: 'NVDA_PERP',
      baseAsset: 'NVDA',
      quoteAsset: 'USD',
      displayLabel: 'NVIDIA',
      marketCategory: 'stock',
      initialInterval: '1m',
    });
  });

  it('keeps only validated, ordered Klines as an immediate chart preview', () => {
    expect(
      parseMarketDetailRouteParams({
        market: 'spot',
        symbol: 'ethusdt',
        baseAsset: 'eth',
        quoteAsset: 'usdt',
        displayLabel: 'ETH/USDT',
        initialInterval: '1m',
        initialKlines: [
          {
            openTime: 1_800_000_060_000,
            open: 102,
            high: 104,
            low: 101,
            close: 103,
            volume: 12,
          },
          {
            openTime: 1_800_000_000_000,
            open: 100,
            high: 103,
            low: 99,
            close: 102,
            volume: 10,
          },
        ],
      }),
    ).toEqual(
      expect.objectContaining({
        initialKlines: [
          expect.objectContaining({openTime: 1_800_000_000_000}),
          expect.objectContaining({openTime: 1_800_000_060_000}),
        ],
      }),
    );
  });

  it('keeps validated Contract position price lines for fullscreen continuity', () => {
    expect(
      parseMarketDetailRouteParams({
        market: 'contract',
        symbol: 'xauusdt_perp',
        baseAsset: 'xau',
        quoteAsset: 'usdt',
        displayLabel: 'XAU/USDT 永续',
        referencePriceLines: [
          {
            key: '7:ENTRY',
            kind: 'ENTRY',
            label: 'BUY 开仓均价',
            price: 4095.45,
          },
        ],
      }),
    ).toEqual(
      expect.objectContaining({
        referencePriceLines: [
          expect.objectContaining({key: '7:ENTRY', price: 4095.45}),
        ],
      }),
    );
  });

  it('drops an invalid optional preview without rejecting the route', () => {
    const parsed = parseMarketDetailRouteParams({
      market: 'spot',
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      displayLabel: 'ETH/USDT',
      initialKlines: [
        {
          openTime: 1_800_000_000_000,
          open: 100,
          high: 90,
          low: 99,
          close: 101,
          volume: 10,
        },
      ],
    });

    expect(parsed).toEqual(
      expect.objectContaining({market: 'spot', symbol: 'ETHUSDT'}),
    );
    expect(parsed).not.toHaveProperty('initialKlines');
  });

  it.each([
    null,
    {},
    {market: 'spot', symbol: 'BTCUSDT'},
    {
      market: 'spot',
      symbol: '../BTC',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      displayLabel: 'BTC/USDT',
    },
    {
      market: 'spot',
      symbol: 'BTCBTC',
      baseAsset: 'BTC',
      quoteAsset: 'BTC',
      displayLabel: 'BTC/BTC',
    },
  ])('rejects malformed params instead of silently opening BTC (%p)', value => {
    expect(parseMarketDetailRouteParams(value)).toBeNull();
  });
});
