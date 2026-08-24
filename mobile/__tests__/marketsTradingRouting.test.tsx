import React from 'react';
import {Alert} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

const mockNavigate = jest.fn();
const mockSetParams = jest.fn();
const mockFetchMobileMarkets = jest.fn();
const mockGetCachedMobileMarkets = jest.fn();
const mockResolveContractTradingInstrument = jest.fn();
const mockResolveSpotTradingInstrument = jest.fn();

let mockRouteParams: Record<string, unknown> | undefined;
let mockCategoryTabsProps: Record<string, any> | null = null;
let mockOverviewCardsProps: Record<string, any> | null = null;
let mockSectionListProps: Record<string, any> | null = null;

const cryptoMarket = {
  id: 'api-BTCUSDT',
  symbol: 'BTCUSDT',
  displaySymbol: 'BTC',
  name: 'Bitcoin',
  category: 'crypto',
  price: 100,
  changePercent: 1,
  pricePrecision: 2,
  source: 'api',
};
const staleRwaSpotMarket = {
  ...cryptoMarket,
  id: 'api-MFCUSDT',
  symbol: 'MFCUSDT',
  displaySymbol: 'MFC',
  name: 'MFC',
  tradable: false,
  tradeMarket: null,
  tradeSymbol: null,
  tradeStatus: 'UNSUPPORTED',
};
const stockMarket = {
  id: 'api-NVDA',
  symbol: 'NVDA',
  displaySymbol: 'NVDA',
  name: 'NVIDIA',
  category: 'stock',
  price: 200,
  changePercent: 2,
  pricePrecision: 2,
  source: 'api',
};
const cfdMarket = {
  id: 'api-XAGUSDUSDT',
  symbol: 'XAGUSDUSDT',
  displaySymbol: 'XAGUSD',
  name: 'XAGUSD',
  category: 'cfd',
  price: 50,
  changePercent: -1,
  pricePrecision: 4,
  source: 'api',
};
const routedCfdMarket = {
  ...cfdMarket,
  tradable: true,
  tradeMarket: 'contract',
  tradeSymbol: 'XAGUSDT_PERP',
  tradeStatus: 'ENABLED',
};
const marketOnlyCfd = {
  ...cfdMarket,
  id: 'api-XAGEURUSDT',
  symbol: 'XAGEURUSDT',
  displaySymbol: 'XAGEUR',
  name: 'XAGEUR',
  tradable: false,
  tradeMarket: 'contract',
  tradeSymbol: null,
  tradeStatus: 'MARKET_DATA_ONLY',
};
const onchainMarket = {
  id: 'api-SPYX',
  symbol: 'SPYX',
  displaySymbol: 'SPYX',
  name: 'SPYX',
  category: 'onchain',
  price: 1,
  changePercent: 0,
  pricePrecision: 4,
  source: 'api',
};
const mockMarkets = [cryptoMarket, stockMarket, onchainMarket];

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return {promise, reject, resolve};
}

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({navigate: mockNavigate, setParams: mockSetParams}),
  useRoute: () => ({params: mockRouteParams}),
}));

jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  return {
    SafeAreaView: ({children}: {children?: React.ReactNode}) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

jest.mock('../src/api/market', () => ({
  fetchMobileMarkets: (...args: unknown[]) =>
    mockFetchMobileMarkets(...args),
  getCachedMobileMarkets: (...args: unknown[]) =>
    mockGetCachedMobileMarkets(...args),
  getOverviewMarkets: (items: unknown[]) => items.slice(0, 6),
}));

jest.mock('../src/api/tradingCatalog', () => ({
  resolveContractTradingInstrument: (...args: unknown[]) =>
    mockResolveContractTradingInstrument(...args),
  resolveSpotTradingInstrument: (...args: unknown[]) =>
    mockResolveSpotTradingInstrument(...args),
}));

jest.mock('../src/components/markets/MarketCategoryTabs', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockCategoryTabsProps = props;
    return null;
  },
}));
jest.mock('../src/components/markets/MarketOverviewCards', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockOverviewCardsProps = props;
    return null;
  },
}));
jest.mock('../src/components/markets/MarketSearchBar', () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock('../src/components/markets/MarketSectionList', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    const ReactModule = require('react');
    mockSectionListProps = props;
    return ReactModule.createElement(
      ReactModule.Fragment,
      null,
      props.header ?? null,
      props.footer ?? null,
      props.refreshControl ?? null,
    );
  },
}));

import MarketsScreen from '../src/screens/markets/MarketsScreen';

async function renderMarketsScreen() {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(<MarketsScreen />);
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer!;
}

describe('MarketsScreen authoritative trading routing', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | null = null;

  beforeEach(() => {
    jest.clearAllMocks();
    mockRouteParams = undefined;
    mockCategoryTabsProps = null;
    mockOverviewCardsProps = null;
    mockSectionListProps = null;
    mockGetCachedMobileMarkets.mockReturnValue(mockMarkets);
    mockFetchMobileMarkets.mockResolvedValue(mockMarkets);
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
  });

  afterEach(async () => {
    if (renderer) {
      await act(async () => {
        renderer?.unmount();
      });
    }
    renderer = null;
    jest.restoreAllMocks();
  });

  it('resolves a real spot instrument before navigating to Trade', async () => {
    const marketWithLogo = {
      ...cryptoMarket,
      logoUrl: '/static/uploads/assets/btc.webp',
    };
    mockResolveSpotTradingInstrument.mockResolvedValue({
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      displaySymbol: 'BTC/USDT',
    });
    renderer = await renderMarketsScreen();

    await act(async () => {
      await mockSectionListProps?.onRowPress(marketWithLogo);
    });

    expect(mockResolveSpotTradingInstrument).toHaveBeenCalledWith('BTCUSDT');
    expect(mockNavigate).toHaveBeenCalledWith('Trade', {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      displayLabel: 'BTC/USDT',
      logoUrl: '/static/uploads/assets/btc.webp',
    });
  });

  it('rechecks a stale RWA spot row against the real spot catalog', async () => {
    mockResolveSpotTradingInstrument.mockResolvedValue({
      symbol: 'MFCUSDT',
      baseAsset: 'MFC',
      quoteAsset: 'USDT',
      displaySymbol: 'MFC/USDT',
    });
    renderer = await renderMarketsScreen();

    await act(async () => {
      await mockSectionListProps?.onRowPress(staleRwaSpotMarket);
    });

    expect(mockResolveSpotTradingInstrument).toHaveBeenCalledWith('MFCUSDT');
    expect(mockNavigate).toHaveBeenCalledWith('Trade', {
      symbol: 'MFCUSDT',
      baseAsset: 'MFC',
      quoteAsset: 'USDT',
      displayLabel: 'MFC/USDT',
    });
  });

  it('routes overview cards through the same authoritative resolver', async () => {
    mockResolveSpotTradingInstrument.mockResolvedValue({
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      displaySymbol: 'BTC/USDT',
    });
    renderer = await renderMarketsScreen();

    await act(async () => {
      await mockOverviewCardsProps?.onPress(cryptoMarket);
    });

    expect(mockResolveSpotTradingInstrument).toHaveBeenCalledWith('BTCUSDT');
    expect(mockNavigate).toHaveBeenCalledWith('Trade', {
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      displayLabel: 'BTC/USDT',
    });
  });

  it('ignores an older market response after a newer refresh completes', async () => {
    const initialRequest = deferred<typeof mockMarkets>();
    const refreshRequest = deferred<typeof mockMarkets>();
    const latestMarket = {...stockMarket, id: 'api-LATEST', symbol: 'LATEST'};
    mockFetchMobileMarkets
      .mockReturnValueOnce(initialRequest.promise)
      .mockReturnValueOnce(refreshRequest.promise);

    await act(async () => {
      renderer = ReactTestRenderer.create(<MarketsScreen />);
      await Promise.resolve();
    });
    const refreshControl = renderer!.root.find(
      node => typeof node.props.onRefresh === 'function',
    );
    let refreshPromise!: Promise<void>;
    await act(async () => {
      refreshPromise = refreshControl.props.onRefresh();
      await Promise.resolve();
    });

    await act(async () => {
      refreshRequest.resolve([latestMarket]);
      await Promise.all([refreshRequest.promise, refreshPromise]);
    });
    expect(mockSectionListProps?.sections[0]?.items[0]?.id).toBe('api-LATEST');

    await act(async () => {
      initialRequest.resolve(mockMarkets);
      await initialRequest.promise;
    });
    expect(mockSectionListProps?.sections[0]?.items[0]?.id).toBe('api-LATEST');
  });

  it('opens the market category requested by a trading symbol header', async () => {
    mockRouteParams = {category: 'stock'};
    renderer = await renderMarketsScreen();

    expect(mockCategoryTabsProps?.activeKey).toBe('stock');
    expect(
      mockCategoryTabsProps?.tabs.map(
        (tab: {label: string}) => tab.label,
      ),
    ).not.toContain('自选');
    expect(
      mockCategoryTabsProps?.tabs.map(
        (tab: {label: string}) => tab.label,
      ),
    ).not.toContain('链上交易');
    expect(mockSetParams).toHaveBeenCalledWith({category: undefined});
  });

  it('resolves a CFD row by its provider display symbol', async () => {
    const marketWithLogo = {
      ...cfdMarket,
      logoUrl: '/static/uploads/assets/xag.svg',
    };
    mockResolveContractTradingInstrument.mockResolvedValue({
      symbol: 'XAGUSDT_PERP',
      baseAsset: 'XAG',
      quoteAsset: 'USDT',
      displayName: 'XAG/USDT 永续',
      category: 'GOLD',
    });
    renderer = await renderMarketsScreen();

    await act(async () => {
      await mockSectionListProps?.onRowPress(marketWithLogo);
    });

    expect(mockResolveContractTradingInstrument).toHaveBeenCalledWith(
      'XAGUSD',
    );
    expect(mockNavigate).toHaveBeenCalledWith('Contract', {
      symbol: 'XAGUSDT_PERP',
      baseAsset: 'XAG',
      quoteAsset: 'USDT',
      displayLabel: 'XAG/USDT 永续',
      marketCategory: 'cfd',
      logoUrl: '/static/uploads/assets/xag.svg',
    });
  });

  it('uses the authoritative backend trade symbol when it is available', async () => {
    mockResolveContractTradingInstrument.mockResolvedValue({
      symbol: 'XAGUSDT_PERP',
      baseAsset: 'XAG',
      quoteAsset: 'USDT',
      displayName: 'XAG/USDT 永续',
      category: 'GOLD',
    });
    renderer = await renderMarketsScreen();

    await act(async () => {
      await mockSectionListProps?.onRowPress(routedCfdMarket);
    });

    expect(mockResolveContractTradingInstrument).toHaveBeenCalledWith(
      'XAGUSDT_PERP',
    );
    expect(mockNavigate).toHaveBeenCalledWith(
      'Contract',
      expect.objectContaining({symbol: 'XAGUSDT_PERP'}),
    );
  });

  it('fails closed if a stale unsupported row reaches the screen', async () => {
    renderer = await renderMarketsScreen();

    await act(async () => {
      await mockSectionListProps?.onRowPress(marketOnlyCfd);
    });

    expect(mockResolveSpotTradingInstrument).not.toHaveBeenCalled();
    expect(mockResolveContractTradingInstrument).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      '暂不支持交易',
      'XAGEUR 当前未在实际交易目录中启用。',
    );
  });

  it('shows the complete enabled CFD catalog instead of truncating at five rows', async () => {
    mockRouteParams = {category: 'cfd'};
    const cfdCatalog = Array.from({length: 9}, (_, index) => ({
      ...routedCfdMarket,
      id: `api-CFD${index}`,
      symbol: `CFD${index}_PERP`,
      displaySymbol: `CFD${index}`,
      name: `CFD ${index}`,
      tradeSymbol: `CFD${index}_PERP`,
      changePercent: index,
    }));
    mockGetCachedMobileMarkets.mockReturnValue(cfdCatalog);
    mockFetchMobileMarkets.mockResolvedValue(cfdCatalog);
    renderer = await renderMarketsScreen();

    expect(mockSectionListProps?.sections).toHaveLength(1);
    expect(mockSectionListProps?.sections[0].items).toHaveLength(9);
  });

  it('routes only the latest valid request after category invalidation and keeps clicks single-flight', async () => {
    let resolveOldRequest!: (value: unknown) => void;
    mockResolveSpotTradingInstrument.mockReturnValue(
      new Promise(resolve => {
        resolveOldRequest = resolve;
      }),
    );
    mockResolveContractTradingInstrument.mockResolvedValue({
      symbol: 'NVDA_PERP',
      baseAsset: 'NVDA',
      quoteAsset: 'USD',
      displayName: 'NVIDIA',
      category: 'STOCK',
    });
    renderer = await renderMarketsScreen();

    let oldRequest!: Promise<void>;
    await act(async () => {
      oldRequest = mockSectionListProps?.onRowPress(cryptoMarket);
      await mockSectionListProps?.onRowPress(stockMarket);
    });
    expect(mockResolveSpotTradingInstrument).toHaveBeenCalledTimes(1);
    expect(mockResolveContractTradingInstrument).not.toHaveBeenCalled();
    expect(
      renderer.root.findAll(
        node => node.props.children === '正在确认真实交易入口',
      ),
    ).toHaveLength(0);

    act(() => {
      mockCategoryTabsProps?.onChange('stock');
    });
    let currentRequest!: Promise<void>;
    await act(async () => {
      currentRequest = mockSectionListProps?.onRowPress(stockMarket);
      await Promise.resolve();
    });
    resolveOldRequest({
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      displaySymbol: 'BTC/USDT',
    });
    await act(async () => {
      await Promise.all([oldRequest, currentRequest]);
    });

    expect(mockNavigate).toHaveBeenCalledTimes(1);
    expect(mockNavigate).toHaveBeenCalledWith('Contract', {
      symbol: 'NVDA_PERP',
      baseAsset: 'NVDA',
      quoteAsset: 'USD',
      displayLabel: 'NVIDIA',
      marketCategory: 'stock',
    });
  });

  it('ignores an unimplemented onchain row without inventing a trade route', async () => {
    renderer = await renderMarketsScreen();

    await act(async () => {
      await mockSectionListProps?.onRowPress(onchainMarket);
    });

    expect(mockResolveSpotTradingInstrument).not.toHaveBeenCalled();
    expect(mockResolveContractTradingInstrument).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(Alert.alert).not.toHaveBeenCalled();
  });

  it('surfaces the real catalog error and does not navigate', async () => {
    mockResolveSpotTradingInstrument.mockRejectedValue(
      new Error('catalog timeout'),
    );
    renderer = await renderMarketsScreen();

    await act(async () => {
      await mockSectionListProps?.onRowPress(cryptoMarket);
    });

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      '交易入口加载失败',
      'catalog timeout',
    );
  });
});
