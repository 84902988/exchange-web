import {
  DEFAULT_CONTRACT_TRADING_ROUTE,
  DEFAULT_SPOT_TRADING_ROUTE,
  normalizeContractTradingRouteParams,
  normalizeSpotTradingRouteParams,
} from '../src/navigation/tradingRoute';

describe('trading route normalizers', () => {
  it('normalizes a complete authoritative spot instrument', () => {
    expect(
      normalizeSpotTradingRouteParams({
        symbol: ' ethusdt ',
        baseAsset: ' eth ',
        quoteAsset: ' usdt ',
        displayLabel: ' ETH / USDT ',
        logoUrl: ' https://cdn.example.com/assets/eth.png ',
      }),
    ).toEqual({
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      displayLabel: 'ETH / USDT',
      logoUrl: 'https://cdn.example.com/assets/eth.png',
    });
  });

  it('drops an invalid logo without discarding a valid trading route', () => {
    expect(
      normalizeSpotTradingRouteParams({
        symbol: 'ETHUSDT',
        baseAsset: 'ETH',
        quoteAsset: 'USDT',
        displayLabel: 'ETH/USDT',
        logoUrl: 'https://cdn.example.com/eth.png\nforged',
      }),
    ).toEqual({
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      displayLabel: 'ETH/USDT',
    });
  });

  it.each([
    undefined,
    {symbol: 'ETHUSDT'},
    {
      symbol: '../ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      displayLabel: 'ETH/USDT',
    },
    {
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'ETH',
      displayLabel: 'ETH/ETH',
    },
    {
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      displayLabel: 'ETH/USDT\n伪造',
    },
  ])('falls back atomically for an incomplete or invalid spot route: %p', params => {
    expect(normalizeSpotTradingRouteParams(params)).toEqual(
      DEFAULT_SPOT_TRADING_ROUTE,
    );
  });

  it('keeps a stock contract origin for the symbol selector return path', () => {
    expect(
      normalizeContractTradingRouteParams({
        symbol: ' nvda_perp ',
        baseAsset: ' nvda ',
        quoteAsset: ' usd ',
        displayLabel: ' NVIDIA ',
        marketCategory: 'stock',
      }),
    ).toEqual({
      symbol: 'NVDA_PERP',
      baseAsset: 'NVDA',
      quoteAsset: 'USD',
      displayLabel: 'NVIDIA',
      marketCategory: 'stock',
    });
  });

  it('defaults a missing contract category to crypto', () => {
    expect(
      normalizeContractTradingRouteParams({
        symbol: 'ETHUSDT_PERP',
        baseAsset: 'ETH',
        quoteAsset: 'USDT',
        displayLabel: 'ETH/USDT 永续',
      }),
    ).toEqual({
      symbol: 'ETHUSDT_PERP',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      displayLabel: 'ETH/USDT 永续',
      marketCategory: 'crypto',
    });
  });

  it('falls back atomically for partial contract params', () => {
    expect(
      normalizeContractTradingRouteParams({
        symbol: 'ETHUSDT_PERP',
        baseAsset: 'ETH',
      }),
    ).toEqual(DEFAULT_CONTRACT_TRADING_ROUTE);
  });
});
