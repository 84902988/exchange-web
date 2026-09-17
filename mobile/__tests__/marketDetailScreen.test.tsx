import React from 'react';
import {Dimensions} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

const mockGoBack = jest.fn();
const mockSetOptions = jest.fn();
const mockUseSpotMarketRealtime = jest.fn();
const mockUseContractMarketRealtime = jest.fn();
const mockUseContractKlineRealtime = jest.fn();
const mockFetchSpotKlines = jest.fn();
let preventRemoveEnabled = false;
let preventRemoveCallback: (() => void) | null = null;
let detailProps: Record<string, any> | null = null;

jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => true,
  usePreventRemove: (enabled: boolean, callback: () => void) => {
    preventRemoveEnabled = enabled;
    preventRemoveCallback = callback;
  },
}));

jest.mock('../src/hooks/useMarketScreenActive', () => ({
  useMarketScreenActive: () => true,
}));

jest.mock('../src/hooks/useSpotMarketRealtime', () => ({
  useSpotMarketRealtime: (...args: unknown[]) =>
    mockUseSpotMarketRealtime(...args),
}));

jest.mock('../src/hooks/useContractMarketRealtime', () => ({
  useContractMarketRealtime: (...args: unknown[]) =>
    mockUseContractMarketRealtime(...args),
}));

jest.mock('../src/hooks/useContractKlineRealtime', () => ({
  useContractKlineRealtime: (...args: unknown[]) =>
    mockUseContractKlineRealtime(...args),
}));

jest.mock('../src/api/spot', () => ({
  ...jest.requireActual('../src/api/spot'),
  fetchSpotKlines: (...args: unknown[]) => mockFetchSpotKlines(...args),
}));

jest.mock('../src/components/market/MarketDetailView', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: (props: Record<string, any>) => {
      detailProps = props;
      return ReactModule.createElement('MarketDetailView', {
        testID: props.fullscreen ? 'detail-landscape' : 'detail-portrait',
      });
    },
  };
});

import MarketDetailScreen from '../src/screens/market/MarketDetailScreen';

const navigation = {
  goBack: mockGoBack,
  setOptions: mockSetOptions,
} as any;

const spotRoute = {
  key: 'MarketDetail-spot',
  name: 'MarketDetail',
  params: {
    market: 'spot',
    symbol: 'BTCUSDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    displayLabel: 'BTC/USDT',
    initialInterval: '5m',
  },
} as any;

const contractRoute = {
  key: 'MarketDetail-contract',
  name: 'MarketDetail',
  params: {
    market: 'contract',
    symbol: 'BTCUSDT_PERP',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    displayLabel: 'BTC/USDT 永续',
    marketCategory: 'cfd',
    initialInterval: '1m',
  },
} as any;

describe('MarketDetailScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    preventRemoveEnabled = false;
    preventRemoveCallback = null;
    detailProps = null;
    const metrics = {width: 390, height: 844, scale: 1, fontScale: 1};
    Dimensions.set({screen: metrics, window: metrics});
    mockFetchSpotKlines.mockResolvedValue([]);
    mockUseSpotMarketRealtime.mockReturnValue({
      ticker: {
        symbol: 'BTCUSDT',
        lastPrice: 63_760.83,
        changePercent: -1.8,
        high24h: 65_399.05,
        low24h: 63_640.13,
        baseVolume24h: 48.23,
        quoteVolume24h: 3_115_588.25,
        displayPricePrecision: 1,
        pricePrecision: 2,
        amountPrecision: 6,
        marketStatus: 'OPEN',
      },
      depth: {symbol: 'BTCUSDT', bids: [], asks: []},
      trades: [],
      phase: 'live',
      error: null,
    });
    mockUseContractMarketRealtime.mockReturnValue({
      marketView: {
        quote: {
          symbol: 'BTCUSDT_PERP',
          lastPrice: 63_750,
          markPrice: 63_748,
          changePercent: -1.7,
          high24h: 65_390,
          low24h: 63_565,
          baseVolume24h: 7_706_034.54,
          quoteVolume24h: 77_060.34,
          pricePrecision: 2,
          marketStatus: 'OPEN',
        },
        depth: {bids: [], asks: []},
        trades: [],
      },
      phase: 'live',
      error: null,
    });
    mockUseContractKlineRealtime.mockReturnValue({
      items: [],
      loading: false,
      error: null,
      gapDetected: false,
      mode: 'NATIVE',
      phase: 'paused',
    });
  });

  it('opens in portrait and makes the first back from fullscreen restore portrait', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailScreen navigation={navigation} route={spotRoute} />,
      );
    });
    expect(mockSetOptions).toHaveBeenLastCalledWith({
      orientation: 'portrait_up',
      gestureEnabled: true,
      statusBarHidden: false,
      navigationBarHidden: false,
    });
    expect(detailProps).toEqual(
      expect.objectContaining({
        market: 'spot',
        symbol: 'BTCUSDT',
        interval: '5m',
        displayPricePrecision: 1,
        high24h: 65_399.05,
        low24h: 63_640.13,
      }),
    );
    expect(mockFetchSpotKlines).toHaveBeenCalledWith('BTCUSDT', '5m', 240);

    act(() => {
      detailProps?.onEnterFullscreen();
    });
    expect(
      renderer.root.findAllByProps({
        testID: 'market-detail-orientation-transition',
      }),
    ).toHaveLength(0);
    expect(detailProps?.fullscreen).toBe(true);
    expect(preventRemoveEnabled).toBe(true);
    expect(mockSetOptions).toHaveBeenLastCalledWith({
      orientation: 'landscape',
      gestureEnabled: false,
      statusBarHidden: true,
      navigationBarHidden: true,
    });

    act(() => {
      preventRemoveCallback?.();
    });
    expect(mockGoBack).not.toHaveBeenCalled();
    expect(preventRemoveEnabled).toBe(false);
    expect(mockSetOptions).toHaveBeenLastCalledWith({
      orientation: 'portrait_up',
      gestureEnabled: true,
      statusBarHidden: false,
      navigationBarHidden: false,
    });

    act(() => {
      detailProps?.onBack();
    });
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it.each([
    ['iPad portrait', 820, 1180],
    ['iPad narrow window', 375, 1024],
    ['iPhone portrait', 390, 844],
    ['Android phone portrait', 412, 915],
    ['Android tablet portrait', 800, 1280],
    ['tablet already landscape', 1180, 820],
  ])('can enter and exit fullscreen when %s never rotates', (_name, width, height) => {
    const metrics = {width, height, scale: 1, fontScale: 1};
    Dimensions.set({screen: metrics, window: metrics});
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailScreen navigation={navigation} route={contractRoute} />,
      );
    });
    expect(detailProps?.fullscreen).toBe(false);
    expect(renderer.root.findAllByProps({accessibilityRole: 'progressbar'})).toHaveLength(0);

    for (let attempt = 0; attempt < 3; attempt += 1) {
      act(() => detailProps?.onEnterFullscreen());
      expect(detailProps?.fullscreen).toBe(true);
      expect(preventRemoveEnabled).toBe(true);
      expect(renderer.root.findAllByProps({accessibilityRole: 'progressbar'})).toHaveLength(0);
      act(() => detailProps?.onExitFullscreen());
      expect(detailProps?.fullscreen).toBe(false);
      expect(preventRemoveEnabled).toBe(false);
      expect(mockGoBack).not.toHaveBeenCalled();
    }
    act(() => detailProps?.onBack());
    expect(mockGoBack).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });

  it('keeps fullscreen and interval selection across late rotation and window resizing', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailScreen navigation={navigation} route={contractRoute} />,
      );
    });
    act(() => {
      detailProps?.onEnterFullscreen();
      detailProps?.onIntervalChange('15m');
    });
    for (const [width, height] of [[1180, 820], [375, 1024], [820, 1180]]) {
      act(() => {
        const metrics = {width, height, scale: 1, fontScale: 1};
        Dimensions.set({screen: metrics, window: metrics});
        renderer.update(<MarketDetailScreen navigation={navigation} route={contractRoute} />);
      });
      expect(detailProps?.fullscreen).toBe(true);
      expect(detailProps?.interval).toBe('15m');
      expect(renderer.root.findAllByProps({accessibilityRole: 'progressbar'})).toHaveLength(0);
    }
    act(() => preventRemoveCallback?.());
    expect(detailProps?.fullscreen).toBe(false);
    expect(detailProps?.interval).toBe('15m');
    expect(mockGoBack).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('renders route Klines immediately while the fresh Spot preview loads', () => {
    const initialKlines = [
      {
        openTime: 1_800_000_000_000,
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 10,
      },
    ];
    mockFetchSpotKlines.mockReturnValue(new Promise(() => undefined));
    const route = {
      ...spotRoute,
      params: {...spotRoute.params, initialKlines},
    } as any;
    let renderer!: ReactTestRenderer.ReactTestRenderer;

    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailScreen navigation={navigation} route={route} />,
      );
    });

    expect(detailProps).toEqual(
      expect.objectContaining({
        fallbackKlines: initialKlines,
        fallbackLoading: false,
      }),
    );
    act(() => renderer.unmount());
  });

  it('keeps the Contract native Kline realtime source active', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailScreen navigation={navigation} route={contractRoute} />,
      );
    });
    expect(mockUseContractKlineRealtime).toHaveBeenLastCalledWith(
      'BTCUSDT_PERP',
      '1m',
      'market-detail-contract-native',
      true,
    );
    expect(detailProps).toEqual(
      expect.objectContaining({
        market: 'contract',
        category: 'cfd',
        high24h: 65_390,
        quoteVolume24h: 77_060.34,
      }),
    );

    expect(detailProps?.chartReady).toBeUndefined();
    expect(detailProps?.advancedFailed).toBeUndefined();
    expect(detailProps?.onAdvancedReady).toBeUndefined();
    expect(detailProps?.onAdvancedFallback).toBeUndefined();
    expect(detailProps?.onAdvancedRetry).toBeUndefined();
    act(() => renderer.unmount());
  });
});
