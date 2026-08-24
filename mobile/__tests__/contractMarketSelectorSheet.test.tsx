import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

const mockFetchContractTradingCatalog = jest.fn();
const mockGetCachedContractTradingCatalog = jest.fn();

jest.mock('../src/api/tradingCatalog', () => ({
  fetchContractTradingCatalog: (...args: unknown[]) =>
    mockFetchContractTradingCatalog(...args),
  getCachedContractTradingCatalog: (...args: unknown[]) =>
    mockGetCachedContractTradingCatalog(...args),
}));

jest.mock('../src/components/markets/MarketLogo', () => ({
  __esModule: true,
  default: () => null,
}));

import ContractMarketSelectorSheet from '../src/components/contract/ContractMarketSelectorSheet';

const catalog = [
  {
    symbol: 'BTCUSDT_PERP',
    displayName: 'BTC/USDT Perpetual CFD',
    displaySymbol: 'BTC/USDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    category: 'CRYPTO',
    marketCategory: 'crypto',
    providerSymbol: 'BTCUSDT',
    logoUrl: null,
    marketStatus: 'OPEN',
  },
  {
    symbol: 'ETHUSDT_PERP',
    displayName: 'ETH/USDT Perpetual CFD',
    displaySymbol: 'ETH/USDT',
    baseAsset: 'ETH',
    quoteAsset: 'USDT',
    category: 'CRYPTO',
    marketCategory: 'crypto',
    providerSymbol: 'ETHUSDT',
    logoUrl: null,
    marketStatus: 'OPEN',
  },
  {
    symbol: 'AAPLUSDT_PERP',
    displayName: 'Apple',
    displaySymbol: 'AAPL/USDT',
    baseAsset: 'AAPL',
    quoteAsset: 'USDT',
    category: 'STOCK',
    marketCategory: 'stock',
    providerSymbol: 'AAPL',
    logoUrl: null,
    marketStatus: 'CLOSED',
  },
  {
    symbol: 'NAS100USDT_PERP',
    displayName: 'NASDAQ 100',
    displaySymbol: 'NAS100/USDT',
    baseAsset: 'NAS100',
    quoteAsset: 'USDT',
    category: 'INDEX',
    marketCategory: 'cfd',
    providerSymbol: 'NAS100',
    logoUrl: null,
    marketStatus: 'OPEN',
  },
] as const;

describe('ContractMarketSelectorSheet', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetCachedContractTradingCatalog.mockReturnValue([]);
    mockFetchContractTradingCatalog.mockResolvedValue(catalog);
  });

  it('shows complete category counts and returns the authoritative crypto item', async () => {
    const onSelect = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ContractMarketSelectorSheet
          initialCategory="crypto"
          visible
          onClose={jest.fn()}
          onSelect={onSelect}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const labels = renderer.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat(Infinity)
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(labels).toContain('加密货币 2');
    expect(labels).toContain('股票 1');
    expect(labels).toContain('CFD 1');

    const btcRow = renderer.root
      .findAll(
        node =>
          node.props.accessibilityLabel === 'BTC/USDT BTC/USDT Perpetual CFD',
      )
      .find(node => typeof node.props.onPress === 'function');
    expect(btcRow).toBeDefined();
    act(() => btcRow?.props.onPress());
    expect(onSelect).toHaveBeenCalledWith(catalog[0]);

    act(() => renderer.unmount());
  });

  it('shows the authoritative closed status for stock contracts', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ContractMarketSelectorSheet
          initialCategory="crypto"
          visible
          onClose={jest.fn()}
          onSelect={jest.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const tabs = renderer.root.findAll(
      node =>
        node.props.accessibilityRole === 'tab' &&
        typeof node.props.onPress === 'function',
    );
    act(() => tabs[1].props.onPress());

    const labels = renderer.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat(Infinity)
      .join(' ')
      .replace(/\s+/g, ' ');
    expect(labels).toContain('AAPL/USDT');
    expect(labels).toContain('已休市');

    act(() => renderer.unmount());
  });

  it('recovers in place after the catalog request fails', async () => {
    mockFetchContractTradingCatalog
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(catalog);
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <ContractMarketSelectorSheet
          initialCategory="crypto"
          visible
          onClose={jest.fn()}
          onSelect={jest.fn()}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const retry = renderer.root
      .findAllByProps({ testID: 'contract-market-retry' })
      .find(node => typeof node.props.onPress === 'function');
    expect(retry).toBeDefined();
    await act(async () => {
      retry?.props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockFetchContractTradingCatalog).toHaveBeenCalledTimes(2);
    const labels = renderer.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat(Infinity)
      .join(' ');
    expect(labels).toContain('BTC/USDT');

    act(() => renderer.unmount());
  });
});
