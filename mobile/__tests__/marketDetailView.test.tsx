import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';

let nativeChartProps: Record<string, any> | null = null;
let nativeChartMounts = 0;
let nativeChartUnmounts = 0;

function setWindowHeight(height: number) {
  const metrics = { fontScale: 1, height, scale: 1, width: 390 };
  Dimensions.set({ screen: metrics, window: metrics });
}

jest.mock('lucide-react-native', () => {
  const ReactModule = require('react');
  return {
    ArrowLeft: () => ReactModule.createElement('ArrowLeft'),
    ChevronRight: () => ReactModule.createElement('ChevronRight'),
    Maximize2: () => ReactModule.createElement('Maximize2'),
    Minimize2: () => ReactModule.createElement('Minimize2'),
    SlidersHorizontal: () => ReactModule.createElement('SlidersHorizontal'),
  };
});

jest.mock('../src/components/chart/advancedChartPreferences', () => ({
  readAdvancedChartPreferences: () => ({
    then: (resolve: (value: unknown) => void) => {
      const {
        cloneAdvancedChartPreferences,
        DEFAULT_ADVANCED_CHART_PREFERENCES,
      } = require('../src/components/chart/advancedChartConfig');
      resolve({
        preferences: cloneAdvancedChartPreferences(
          DEFAULT_ADVANCED_CHART_PREFERENCES,
        ),
        status: 'valid',
        writeProtected: false,
      });
    },
  }),
  writeAdvancedChartPreferences: jest.fn(() => Promise.resolve()),
}));

jest.mock('../src/components/trade/MobileKlineChart', () => {
  const ReactModule = require('react');
  const MockNativeChart = (receivedProps: Record<string, any>) => {
    nativeChartProps = receivedProps;
    ReactModule.useEffect(() => {
      nativeChartMounts += 1;
      return () => {
        nativeChartUnmounts += 1;
      };
    }, []);
    return ReactModule.createElement('MobileKlineChart', {
      ...receivedProps,
      testID: 'native-kline-render',
    });
  };
  return {
    __esModule: true,
    default: MockNativeChart,
  };
});

import MarketDetailView, {
  getHorizontalOverflowPresentation,
  type MarketDetailViewProps,
} from '../src/components/market/MarketDetailView';

function makeProps(
  overrides: Partial<MarketDetailViewProps> = {},
): MarketDetailViewProps {
  return {
    market: 'spot',
    symbol: 'BTCUSDT',
    symbolLabel: 'BTC/USDT',
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    price: 63_760.83,
    changePercent: -1.8,
    high24h: 65_399.05,
    low24h: 63_640.13,
    baseVolume24h: 48.23,
    quoteVolume24h: 3_115_588.25,
    displayPricePrecision: 2,
    marketStatus: 'OPEN',
    realtimePhase: 'live',
    bids: [{ price: 63_752.23, amount: 0.02891 }],
    asks: [{ price: 63_758.6, amount: 0.02926 }],
    trades: [
      {
        id: 'trade-1',
        price: 63_752.23,
        amount: 0.1,
        side: 'BUY',
        ts: 1_800_000_000_000,
      },
    ],
    interval: '1m',
    fallbackKlines: [],
    fullscreen: false,
    onBack: jest.fn(),
    onEnterFullscreen: jest.fn(),
    onExitFullscreen: jest.fn(),
    onIntervalChange: jest.fn(),
    ...overrides,
  };
}

describe('MarketDetailView', () => {
  it('shows an overflow cue until the indicator strip reaches its end', () => {
    expect(
      getHorizontalOverflowPresentation({
        contentWidth: 480,
        offsetX: 0,
        viewportWidth: 280,
      }),
    ).toEqual({ atEnd: false, hasOverflow: true });
    expect(
      getHorizontalOverflowPresentation({
        contentWidth: 480,
        offsetX: 198,
        viewportWidth: 280,
      }),
    ).toEqual({ atEnd: true, hasOverflow: true });
    expect(
      getHorizontalOverflowPresentation({
        contentWidth: 280,
        offsetX: 0,
        viewportWidth: 280,
      }),
    ).toEqual({ atEnd: true, hasOverflow: false });
  });

  beforeEach(() => {
    nativeChartProps = null;
    nativeChartMounts = 0;
    nativeChartUnmounts = 0;
    act(() => setWindowHeight(800));
  });

  it('renders the real portrait summary, native chart and depth by default', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailView {...makeProps()} />,
      );
    });

    expect(nativeChartProps).toEqual(
      expect.objectContaining({
        currentPrice: 63_760.83,
        testID: 'native-kline-chart',
      }),
    );
    expect(
      renderer.root.findByProps({ testID: 'market-detail-portrait' }),
    ).toBeTruthy();
    expect(
      renderer.root.findByProps({ testID: 'market-detail-depth' }),
    ).toBeTruthy();
    expect(
      renderer.root.findAllByProps({ children: '65,399.05' }),
    ).not.toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ children: '3.12M' }),
    ).not.toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ children: '≈$63,760.83' }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ children: '高级 K线' }),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('centers the three detail tabs in equal-width slots', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailView {...makeProps()} />,
      );
    });

    for (const tab of ['depth', 'trades', 'info']) {
      expect(
        StyleSheet.flatten(
          renderer.root
            .findByProps({ testID: `market-detail-tab-${tab}` })
            .props.style({ pressed: false }),
        ),
      ).toEqual(expect.objectContaining({ flex: 1, minWidth: 0 }));
    }
    act(() => renderer.unmount());
  });

  it('aligns the four real 24h fields and derives depth visuals from the book', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailView {...makeProps()} />,
      );
    });

    expect(
      renderer.root.findByProps({ testID: 'market-summary-stat-row-primary' }),
    ).toBeTruthy();
    expect(
      renderer.root.findByProps({
        testID: 'market-summary-stat-row-secondary',
      }),
    ).toBeTruthy();
    expect(
      renderer.root.findAllByProps({ children: '24h最高' }),
    ).not.toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ children: '24h最低' }),
    ).not.toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ children: '24h量(BTC)' }),
    ).not.toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ children: '24h额(USDT)' }),
    ).not.toHaveLength(0);

    expect(
      renderer.root.findByProps({ testID: 'market-detail-depth-reference' })
        .props.children,
    ).toEqual(['最新价 ', '63,760.83']);
    expect(
      renderer.root.findAllByProps({ testID: 'market-detail-depth-spread' }),
    ).toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'market-detail-bid-depth-0' }).props
        .style[2],
    ).toEqual({ width: '98.8%' });
    expect(
      renderer.root.findByProps({ testID: 'market-detail-ask-depth-0' }).props
        .style[2],
    ).toEqual({ width: '100%' });
    act(() => renderer.unmount());
  });

  it('keeps the real latest price without rendering spread for a crossed book', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailView
          {...makeProps({
            bids: [{ price: 63_752.23, amount: 0.02891 }],
            asks: [{ price: 63_700, amount: 0.02926 }],
          })}
        />,
      );
    });

    expect(
      renderer.root.findByProps({ testID: 'market-detail-depth-reference' })
        .props.children,
    ).toEqual(['最新价 ', '63,760.83']);
    expect(
      renderer.root.findAllByProps({ testID: 'market-detail-depth-spread' }),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('drops invalid zero levels and preserves small positive quantities', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailView
          {...makeProps({
            bids: [
              { price: 63_752.3, amount: 0 },
              { price: 63_752.2, amount: 0.000015 },
            ],
            asks: [
              { price: 63_758.5, amount: -1 },
              { price: 63_758.6, amount: 0.00001 },
            ],
          })}
        />,
      );
    });

    expect(
      renderer.root.findByProps({ testID: 'market-detail-bid-amount-0' }).props
        .children,
    ).toBe('0.000015');
    expect(
      renderer.root.findByProps({ testID: 'market-detail-ask-amount-0' }).props
        .children,
    ).toBe('0.00001');
    expect(
      renderer.root.findAllByProps({ children: '63,752.3' }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ children: '63,758.5' }),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('uses one real display precision for the header, book and latest reference', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailView
          {...makeProps({
            asks: [{ price: 62_551.3, amount: 0.02926 }],
            bids: [{ price: 62_551.2, amount: 0.02891 }],
            price: 62_567.4,
            displayPricePrecision: 1,
          })}
        />,
      );
    });

    expect(
      renderer.root.findAllByProps({ children: '62,567.4' }),
    ).not.toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ children: '62,551.2' }),
    ).not.toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ children: '62,551.3' }),
    ).not.toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'market-detail-depth-reference' })
        .props.children,
    ).toEqual(['最新价 ', '62,567.4']);
    expect(
      renderer.root.findAllByProps({ testID: 'market-detail-depth-spread' }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ children: '62,551.25' }),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('fills large portrait space and raises real depth capacity to seven rows', () => {
    const bids = Array.from({ length: 10 }, (_, index) => ({
      amount: 0.01 + index / 100,
      price: 63_752 - index,
    }));
    const asks = Array.from({ length: 10 }, (_, index) => ({
      amount: 0.02 + index / 100,
      price: 63_758 + index,
    }));
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailView {...makeProps({ asks, bids })} />,
      );
    });

    expect(
      renderer.root.findByProps({ testID: 'market-detail-panel' }).props
        .style[1],
    ).toEqual(expect.objectContaining({ flex: 1, minHeight: 220 }));
    expect(
      new Set(
        renderer.root
          .findAll(
            node =>
              typeof node.props.testID === 'string' &&
              /^market-detail-depth-row-\d+$/.test(node.props.testID),
          )
          .map(node => node.props.testID),
      ).size,
    ).toBe(7);
    act(() => renderer.unmount());
  });

  it('keeps small portrait compact and renders an explicit empty-book state', () => {
    act(() => setWindowHeight(680));
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailView {...makeProps({ asks: [], bids: [] })} />,
      );
    });

    expect(
      renderer.root.findByProps({ testID: 'market-detail-panel' }).props
        .style[1],
    ).toEqual(expect.objectContaining({ height: 170 }));
    expect(
      renderer.root.findByProps({ testID: 'market-detail-depth-empty' }),
    ).toBeTruthy();
    expect(
      new Set(
        renderer.root
          .findAll(
            node =>
              typeof node.props.testID === 'string' &&
              /^market-detail-depth-row-\d+$/.test(node.props.testID),
          )
          .map(node => node.props.testID),
      ).size,
    ).toBe(0);
    act(() => renderer.unmount());
  });

  it('uses the extreme compact budget without overflowing short screens', () => {
    act(() => setWindowHeight(568));
    const bids = Array.from({ length: 6 }, (_, index) => ({
      amount: 0.01 + index / 100,
      price: 63_752 - index,
    }));
    const asks = Array.from({ length: 6 }, (_, index) => ({
      amount: 0.02 + index / 100,
      price: 63_758 + index,
    }));
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailView
          {...makeProps({ asks, bids, realtimeError: 'reconnecting' })}
        />,
      );
    });

    expect(
      renderer.root.findByProps({ testID: 'market-detail-panel' }).props
        .style[1],
    ).toEqual(expect.objectContaining({ height: 148 }));
    expect(
      renderer.root.findByProps({ testID: 'market-detail-chart-shell' }).props
        .style[1],
    ).toEqual({ height: 176 });
    expect(
      new Set(
        renderer.root
          .findAll(
            node =>
              typeof node.props.testID === 'string' &&
              /^market-detail-depth-row-\d+$/.test(node.props.testID),
          )
          .map(node => node.props.testID),
      ).size,
    ).toBe(1);
    act(() => renderer.unmount());
  });

  it('switches to real trades and information without placeholder actions', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailView {...makeProps()} />,
      );
    });
    act(() => {
      renderer.root
        .findByProps({ testID: 'market-detail-tab-trades' })
        .props.onPress();
    });
    expect(
      renderer.root.findByProps({ testID: 'market-detail-trades' }),
    ).toBeTruthy();
    expect(
      renderer.root.findAllByProps({ children: '63,752.23' }),
    ).not.toHaveLength(0);
    act(() => {
      renderer.root
        .findByProps({ testID: 'market-detail-tab-info' })
        .props.onPress();
    });
    expect(
      renderer.root.findByProps({ testID: 'market-detail-info' }),
    ).toBeTruthy();
    expect(
      renderer.root.findAllByProps({ children: 'BTCUSDT' }),
    ).not.toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('keeps one native chart mount through repeated orientation layout changes', () => {
    const baseProps = makeProps();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<MarketDetailView {...baseProps} />);
    });
    expect(nativeChartMounts).toBe(1);

    act(() => {
      renderer.update(<MarketDetailView {...baseProps} fullscreen />);
    });
    expect(
      renderer.root.findByProps({ testID: 'market-detail-landscape' }),
    ).toBeTruthy();
    expect(nativeChartMounts).toBe(1);
    expect(nativeChartUnmounts).toBe(0);

    for (let index = 0; index < 20; index += 1) {
      act(() => {
        renderer.update(
          <MarketDetailView {...baseProps} fullscreen={index % 2 === 0} />,
        );
      });
    }
    expect(nativeChartMounts).toBe(1);
    expect(nativeChartUnmounts).toBe(0);

    act(() => {
      renderer.update(<MarketDetailView {...baseProps} fullscreen={false} />);
    });
    expect(nativeChartMounts).toBe(1);
    expect(nativeChartUnmounts).toBe(0);
    act(() => renderer.unmount());
    expect(nativeChartUnmounts).toBe(1);
  });

  it('keeps chart config references stable through price-only rerenders', () => {
    const baseProps = makeProps();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<MarketDetailView {...baseProps} />);
    });
    const initialConfig = nativeChartProps?.indicatorConfig;
    act(() => {
      renderer.update(
        <MarketDetailView {...baseProps} price={(baseProps.price ?? 0) + 1} />,
      );
    });
    expect(nativeChartProps?.indicatorConfig).toBe(initialConfig);
    expect(nativeChartProps?.currentPrice).toBe((baseProps.price ?? 0) + 1);
    expect(nativeChartMounts).toBe(1);
    expect(nativeChartUnmounts).toBe(0);
    act(() => renderer.unmount());
  });

  it('shows the native chart immediately without WebView loading or retry states', () => {
    const baseProps = makeProps({
      fallbackKlines: [
        {
          openTime: 1_800_000_000_000,
          open: 100,
          high: 102,
          low: 99,
          close: 101,
          volume: 10,
        },
      ],
    });
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<MarketDetailView {...baseProps} />);
    });

    expect(nativeChartMounts).toBe(1);
    expect(
      renderer.root.findAllByProps({ children: '高级图表加载中' }),
    ).toHaveLength(0);
    expect(
      renderer.root.findAllByProps({ testID: 'native-kline-chart' }),
    ).toHaveLength(1);
    expect(
      renderer.root.findByProps({ testID: 'native-kline-chart' }).props,
    ).toEqual(
      expect.objectContaining({
        items: baseProps.fallbackKlines,
        loading: false,
      }),
    );
    expect(
      renderer.root.findAllByProps({testID: 'market-detail-advanced-retry'}),
    ).toHaveLength(0);
    expect(nativeChartMounts).toBe(1);
    expect(nativeChartUnmounts).toBe(0);
    act(() => renderer.unmount());
  });

  it('keeps grouped indicators selected and fullscreen fixed outside the scroll strip', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailView {...makeProps()} />,
      );
    });

    const indicatorScroll = renderer.root.findByProps({
      testID: 'market-detail-indicator-scroll',
    });
    expect(indicatorScroll.props.horizontal).toBe(true);
    expect(indicatorScroll.props.scrollEventThrottle).toBe(32);
    act(() => {
      indicatorScroll.props.onLayout({
        nativeEvent: { layout: { width: 280 } },
      });
      indicatorScroll.props.onContentSizeChange(480, 42);
    });
    expect(
      StyleSheet.flatten(
        renderer.root.findByProps({
          testID: 'market-detail-indicator-overflow-cue',
        }).props.style,
      ).opacity,
    ).toBeUndefined();
    act(() => {
      indicatorScroll.props.onScroll({
        nativeEvent: { contentOffset: { x: 200 } },
      });
    });
    expect(
      StyleSheet.flatten(
        renderer.root.findByProps({
          testID: 'market-detail-indicator-overflow-cue',
        }).props.style,
      ).opacity,
    ).toBe(0);
    for (const indicator of [
      'ma',
      'ema',
      'boll',
      'sar',
      'avl',
      'super',
      'vol',
      'macd',
      'rsi',
      'kdj',
      'obv',
      'wr',
      'stochrsi',
    ]) {
      expect(
        StyleSheet.flatten(
          renderer.root
            .findByProps({
              testID: `market-detail-indicator-${indicator}`,
            })
            .props.style({ pressed: false }),
        ),
      ).toEqual(
        expect.objectContaining({ minWidth: 34, paddingHorizontal: 3 }),
      );
    }
    expect(
      indicatorScroll.findAllByProps({
        testID: 'market-detail-fullscreen-button',
      }),
    ).toHaveLength(0);
    expect(
      renderer.root.findByProps({ testID: 'market-detail-indicator-ma' }).props
        .accessibilityState,
    ).toEqual({ disabled: false, selected: true });
    expect(
      renderer.root.findByProps({ testID: 'market-detail-indicator-vol' }).props
        .accessibilityState,
    ).toEqual({ disabled: false, selected: true });
    expect(nativeChartProps?.indicatorConfig).toEqual(
      expect.objectContaining({
        overlay: expect.objectContaining({kind: 'MA'}),
        pane: expect.objectContaining({kind: 'VOL'}),
      }),
    );
    expect(nativeChartProps?.showPane).toBe(true);

    act(() => {
      renderer.root
        .findByProps({ testID: 'market-detail-indicator-boll' })
        .props.onPress();
    });
    expect(nativeChartProps?.indicatorConfig).toEqual(
      expect.objectContaining({
        overlay: expect.objectContaining({kind: 'BOLL'}),
        pane: expect.objectContaining({kind: 'VOL'}),
      }),
    );
    expect(
      renderer.root.findByProps({ testID: 'market-detail-indicator-boll' })
        .props.accessibilityState.selected,
    ).toBe(true);

    act(() => {
      renderer.root
        .findByProps({ testID: 'market-detail-indicator-macd' })
        .props.onPress();
    });
    expect(nativeChartProps?.indicatorConfig).toEqual(
      expect.objectContaining({
        overlay: expect.objectContaining({kind: 'BOLL'}),
        pane: expect.objectContaining({kind: 'MACD'}),
      }),
    );
    act(() => {
      renderer.root
        .findByProps({ testID: 'market-detail-indicator-super' })
        .props.onPress();
      renderer.root
        .findByProps({ testID: 'market-detail-indicator-kdj' })
        .props.onPress();
    });
    expect(nativeChartProps?.indicatorConfig).toEqual(
      expect.objectContaining({
        overlay: expect.objectContaining({kind: 'SUPER'}),
        pane: expect.objectContaining({kind: 'KDJ'}),
      }),
    );
    expect(nativeChartMounts).toBe(1);
    expect(nativeChartUnmounts).toBe(0);
    act(() => renderer.unmount());
  });

  it('toggles the active pane indicator off and back on without remounting', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailView {...makeProps()} />,
      );
    });

    const volButton = () =>
      renderer.root.findByProps({testID: 'market-detail-indicator-vol'});
    expect(nativeChartProps?.showPane).toBe(true);
    expect(volButton().props.accessibilityState.selected).toBe(true);

    act(() => volButton().props.onPress());
    expect(nativeChartProps?.showPane).toBe(false);
    expect(volButton().props.accessibilityState.selected).toBe(false);
    expect(nativeChartProps?.indicatorConfig.pane.kind).toBe('VOL');

    act(() => volButton().props.onPress());
    expect(nativeChartProps?.showPane).toBe(true);
    expect(volButton().props.accessibilityState.selected).toBe(true);
    expect(nativeChartMounts).toBe(1);
    expect(nativeChartUnmounts).toBe(0);
    act(() => renderer.unmount());
  });

  it('enables native indicator settings after preferences hydrate', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <MarketDetailView {...makeProps()} />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });
    const settings = renderer.root.findByProps({
      testID: 'market-detail-indicator-settings',
    });
    expect(settings.props.accessibilityState.disabled).toBe(false);
    expect(
      renderer.root
        .findByProps({testID: 'market-detail-indicator-scroll'})
        .findAllByProps({testID: 'market-detail-indicator-settings'}),
    ).toHaveLength(0);
    act(() => settings.props.onPress());
    expect(
      renderer.root.findByProps({testID: 'indicator-settings-sheet'}),
    ).toBeTruthy();
    expect(nativeChartMounts).toBe(1);
    expect(nativeChartUnmounts).toBe(0);
    act(() => renderer.unmount());
  });

  it('updates native indicators immediately without remounting the chart', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailView {...makeProps()} />,
      );
    });
    act(() => {
      renderer.root
        .findByProps({testID: 'market-detail-indicator-ema'})
        .props.onPress();
      renderer.root
        .findByProps({testID: 'market-detail-indicator-rsi'})
        .props.onPress();
    });
    expect(nativeChartProps?.indicatorConfig).toEqual(
      expect.objectContaining({
        overlay: expect.objectContaining({kind: 'EMA'}),
        pane: expect.objectContaining({kind: 'RSI'}),
      }),
    );
    expect(nativeChartMounts).toBe(1);
    expect(nativeChartUnmounts).toBe(0);
    act(() => renderer.unmount());
  });

  it('uses the native Kline and remains fullscreen-capable', () => {
    const onEnterFullscreen = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketDetailView
          {...makeProps({
            fallbackKlines: [
              {
                openTime: 1_800_000_000_000,
                open: 100,
                high: 102,
                low: 99,
                close: 101,
                volume: 10,
              },
            ],
            onEnterFullscreen,
          })}
        />,
      );
    });
    expect(
      renderer.root.findByProps({testID: 'native-kline-chart'}),
    ).toBeTruthy();
    expect(
      renderer.root.findAllByProps({
        children: '高级图表加载失败，点击重试',
      }),
    ).toHaveLength(0);
    expect(
      renderer.root.findByProps({testID: 'native-kline-chart'}).props.height,
    ).toBe(210);
    act(() => {
      renderer.root
        .findByProps({ testID: 'market-detail-fullscreen-button' })
        .props.onPress();
    });
    expect(onEnterFullscreen).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
