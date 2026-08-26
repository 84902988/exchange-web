import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

import MobileAdvancedChartClient from './MobileAdvancedChartClient';
import {
  parseAdvancedChartQuery,
  writeAdvancedChartBootstrapCache,
} from './advancedChartRoute';

const mockGetSpotMarketTickers = jest.fn();
const mockGetContractSymbols = jest.fn();
const mockChangeLocale = jest.fn();
const mockCreateStudy = jest.fn();
const mockRemoveEntity = jest.fn();
const mockGetAllStudies = jest.fn();
const mockGetStudyById = jest.fn();
const mockPreloadAdvancedChartComponent = jest.fn();
const mockChartApi = {
  createStudy: (...args: unknown[]) => mockCreateStudy(...args),
  removeEntity: (...args: unknown[]) => mockRemoveEntity(...args),
  getAllStudies: () => mockGetAllStudies(),
  getStudyById: (...args: unknown[]) => mockGetStudyById(...args),
};
const mockIntervalChangeCallbacks: unknown[] = [];
const mockIntervalFailureCallbacks: unknown[] = [];
let mockAutoAttachStudyApi = true;
let mockChartApiReadyCallback: ((chart: typeof mockChartApi | null) => void) | undefined;

jest.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams([
    ['market', 'spot'],
    ['symbol', 'BTCUSDT'],
    ['interval', '1m'],
    ['lang', 'zh'],
    ['sessionId', 'mobile-layout-test'],
  ]),
}));

jest.mock('next/dynamic', () => ({
  __esModule: true,
  default: () => function EmbeddedChartStub(props: {
    interval: string;
    onIntervalChange?: (value: string) => void;
    onIntervalResolutionFailure?: (value: string) => void;
    onMobileChartApiReady?: (chart: typeof mockChartApi) => void;
  }) {
    mockIntervalChangeCallbacks.push(props.onIntervalChange);
    mockIntervalFailureCallbacks.push(props.onIntervalResolutionFailure);
    mockChartApiReadyCallback = props.onMobileChartApiReady;
    if (mockAutoAttachStudyApi) props.onMobileChartApiReady?.(mockChartApi);
    return (
      <div
        data-testid="embedded-chart"
        data-interval={props.interval}
        data-spot-chart-bootstrap="ready"
        data-spot-chart-loading="ready"
      />
    );
  },
}));

jest.mock('./advancedChartComponentLoader', () => ({
  loadSpotAdvancedChartComponent: jest.fn(),
  loadContractAdvancedChartComponent: jest.fn(),
  preloadAdvancedChartComponent: (...args: unknown[]) =>
    mockPreloadAdvancedChartComponent(...args),
}));

jest.mock('@/contexts/LocaleContext', () => ({
  useLocaleContext: () => ({
    locale: 'zh',
    changeLocale: mockChangeLocale,
    isInitialized: true,
    isLoading: false,
  }),
}));

jest.mock('@/lib/api/modules/spot', () => ({
  getSpotMarketTickers: (...args: unknown[]) => mockGetSpotMarketTickers(...args),
}));

jest.mock('@/lib/api/modules/contract', () => ({
  getContractSymbols: (...args: unknown[]) => mockGetContractSymbols(...args),
}));

describe('MobileAdvancedChartClient layout', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIntervalChangeCallbacks.length = 0;
    mockIntervalFailureCallbacks.length = 0;
    mockAutoAttachStudyApi = true;
    mockChartApiReadyCallback = undefined;
    mockPreloadAdvancedChartComponent.mockResolvedValue(undefined);
    mockCreateStudy
      .mockResolvedValueOnce('overlay-study')
      .mockResolvedValueOnce('pane-study');
    mockGetAllStudies.mockReturnValue([]);
    mockGetStudyById.mockImplementation((entityId: string) => {
      const callIndex = entityId === 'overlay-study' ? 0 : 1;
      const inputs = mockCreateStudy.mock.calls[callIndex]?.[3] || {};
      return {
        getInputValues: () => Object.entries(inputs).map(([id, value]) => ({ id, value })),
      };
    });
    window.localStorage.clear();
    mockGetSpotMarketTickers.mockResolvedValue([
      {
        symbol: 'BTCUSDT',
        display_symbol: 'BTC/USDT',
        price_precision: 2,
        amount_precision: 6,
      },
    ]);
    mockGetContractSymbols.mockResolvedValue({items: []});
  });

  test('starts a hot launch from validated persistent metadata without a directory request', async () => {
    const parsed = parseAdvancedChartQuery(
      'market=spot&symbol=BTCUSDT&interval=1m&lang=zh&sessionId=cache-seed',
    );
    if (!parsed.ok) throw new Error('expected a valid test query');
    writeAdvancedChartBootstrapCache(parsed.value, {
      market: 'spot',
      symbol: 'BTCUSDT',
      displaySymbol: 'BTC/USDT',
      category: null,
      pricePrecision: 2,
      amountPrecision: 6,
      logoUrl: null,
      logoAlt: null,
    });

    const { container } = render(<MobileAdvancedChartClient />);

    await screen.findByTestId('embedded-chart');
    expect(mockGetSpotMarketTickers).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-mobile-advanced-chart="spot"]'),
    ).toHaveAttribute(
      'data-mobile-chart-bootstrap-source',
      'persistent-cache',
    );
  });

  test('preloads the matching chart bundle while metadata initializes', async () => {
    render(<MobileAdvancedChartClient />);

    await waitFor(() => {
      expect(mockPreloadAdvancedChartComponent).toHaveBeenCalledWith('spot');
    });
  });

  test('keeps the chart above a compact six-period mobile bar', async () => {
    const { container } = render(<MobileAdvancedChartClient />);

    await screen.findByTestId('embedded-chart');
    const main = container.querySelector('[data-mobile-advanced-chart="spot"]');
    const chart = container.querySelector('[data-mobile-chart-region]');
    const periods = container.querySelector('[data-mobile-chart-periods]');

    expect(main).not.toBeNull();
    expect(main).toHaveAttribute(
      'data-mobile-chart-bootstrap-source',
      'request',
    );
    expect(chart).not.toBeNull();
    expect(periods).not.toBeNull();
    expect(main?.children[0]).toBe(chart);
    expect(main?.children[1]).toBe(periods);
    expect(chart).toHaveClass(
      'overflow-hidden',
      'landscape:rounded-lg',
      'landscape:border',
    );
    expect(periods).toHaveClass(
      'grid-cols-6',
      'border-t',
      'landscape:h-10',
      'landscape:bg-[#0f1319]',
    );
    expect(periods).not.toHaveClass('absolute');
    expect(screen.getAllByRole('button')).toHaveLength(6);
  });

  test('keeps the selected period synchronized with the embedded chart', async () => {
    render(<MobileAdvancedChartClient />);

    const fiveMinutes = await screen.findByRole('button', {name: '5m'});
    fireEvent.click(fiveMinutes);

    await waitFor(() => {
      expect(fiveMinutes).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('embedded-chart')).toHaveAttribute(
        'data-interval',
        '5m',
      );
    });
  });

  test('keeps Spot interval callback identities stable across period renders', async () => {
    render(<MobileAdvancedChartClient />);
    const fiveMinutes = await screen.findByRole('button', {name: '5m'});
    const firstIntervalChange = mockIntervalChangeCallbacks.at(-1);
    const firstIntervalFailure = mockIntervalFailureCallbacks.at(-1);

    fireEvent.click(fiveMinutes);
    await waitFor(() => {
      expect(screen.getByTestId('embedded-chart')).toHaveAttribute('data-interval', '5m');
      expect(mockIntervalChangeCallbacks.length).toBeGreaterThan(1);
    });

    expect(mockIntervalChangeCallbacks.at(-1)).toBe(firstIntervalChange);
    expect(mockIntervalFailureCallbacks.at(-1)).toBe(firstIntervalFailure);
  });

  test('applies a session-scoped indicator command through the ready chart API', async () => {
    const postMessage = jest.fn();
    (window as unknown as {
      ReactNativeWebView: { postMessage: (message: string) => void };
    }).ReactNativeWebView = { postMessage };
    render(<MobileAdvancedChartClient />);
    await screen.findByTestId('embedded-chart');
    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(JSON.stringify({
        type: 'CHART_READY',
        sessionId: 'mobile-layout-test',
        capabilities: ['indicator-config-v2'],
      }));
    });

    window.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'mobile-chart-command',
        sessionId: 'mobile-layout-test',
        command: 'set-indicators',
        intentId: 1,
        indicators: { overlay: 'MA', pane: 'VOL' },
      }),
      origin: 'https://untrusted.example',
      source: window,
    }));
    expect(mockCreateStudy).not.toHaveBeenCalled();

    window.dispatchEvent(new MessageEvent('message', {
      data: JSON.stringify({
        type: 'mobile-chart-command',
        sessionId: 'mobile-layout-test',
        command: 'set-indicators',
        intentId: 1,
        indicators: { overlay: 'MA', pane: 'VOL' },
      }),
      origin: window.location.origin,
      source: window,
    }));

    await waitFor(() => {
      expect(mockCreateStudy).toHaveBeenCalledTimes(2);
      expect(postMessage).toHaveBeenCalledWith(JSON.stringify({
        type: 'INDICATORS_COMMITTED',
        sessionId: 'mobile-layout-test',
        intentId: 1,
        indicators: { overlay: 'MA', pane: 'VOL' },
      }));
    });
    expect(mockCreateStudy).toHaveBeenNthCalledWith(
      1,
      'Moving Average',
      true,
      false,
      {
        length: 9,
        source: 'close',
        offset: 0,
        smoothingLine: 'SMA',
        smoothingLength: 9,
      },
      undefined,
      { disableUndo: true },
    );
    expect(mockCreateStudy).toHaveBeenNthCalledWith(
      2,
      'Volume',
      false,
      false,
      { showMA: false, length: 20, volumeMA: 'SMA', col_prev_close: false },
      undefined,
      { disableUndo: true },
    );
    delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
  });

  test('applies v2 config and emits the versioned receipt', async () => {
    const postMessage = jest.fn();
    (window as unknown as {
      ReactNativeWebView: { postMessage: (message: string) => void };
    }).ReactNativeWebView = { postMessage };
    render(<MobileAdvancedChartClient />);
    await screen.findByTestId('embedded-chart');
    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(JSON.stringify({
        type: 'CHART_READY',
        sessionId: 'mobile-layout-test',
        capabilities: ['indicator-config-v2'],
      }));
    });
    const config = {
      protocolVersion: 2,
      overlay: { kind: 'BOLL', params: { length: 25, multiplier: 2.5 } },
      pane: {
        kind: 'MACD',
        params: { fastLength: 8, slowLength: 21, signalLength: 5 },
      },
    } as const;

    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'mobile-chart-command',
        sessionId: 'mobile-layout-test',
        command: 'set-indicator-config-v2',
        intentId: 9,
        config,
      },
      origin: window.location.origin,
      source: window,
    }));

    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(JSON.stringify({
        type: 'INDICATOR_CONFIG_COMMITTED',
        sessionId: 'mobile-layout-test',
        intentId: 9,
        config,
      }));
    });
    expect(mockCreateStudy).toHaveBeenNthCalledWith(
      1,
      'Bollinger Bands',
      true,
      false,
      { in_0: 25, in_1: 2.5, offset: 0, maType: 'SMA' },
      undefined,
      { disableUndo: true },
    );
    expect(mockCreateStudy).toHaveBeenNthCalledWith(
      2,
      'MACD',
      false,
      false,
      {
        in_0: 8,
        in_1: 21,
        in_2: 5,
        in_3: 'close',
        oscillatorMAType: 'EMA',
        signalLineMAType: 'EMA',
      },
      undefined,
      { disableUndo: true },
    );
    delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
  });

  test('waits for the real Study API after loading is ready before advertising v2', async () => {
    mockAutoAttachStudyApi = false;
    const postMessage = jest.fn();
    (window as unknown as {
      ReactNativeWebView: { postMessage: (message: string) => void };
    }).ReactNativeWebView = { postMessage };
    render(<MobileAdvancedChartClient />);
    await screen.findByTestId('embedded-chart');
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    expect(postMessage).not.toHaveBeenCalledWith(expect.stringContaining('CHART_READY'));
    window.dispatchEvent(new MessageEvent('message', {
      data: {
        type: 'mobile-chart-command',
        sessionId: 'mobile-layout-test',
        command: 'set-indicator-config-v2',
        intentId: 30,
        config: {
          protocolVersion: 2,
          overlay: { kind: 'MA', params: { length: 9 } },
          pane: { kind: 'VOL', params: { showMA: false, maLength: 20 } },
        },
      },
      origin: window.location.origin,
      source: window,
    }));
    expect(mockCreateStudy).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalledWith(expect.stringContaining('INDICATOR_CONFIG_ERROR'));

    act(() => mockChartApiReadyCallback?.(mockChartApi));
    await waitFor(() => {
      expect(postMessage).toHaveBeenCalledWith(JSON.stringify({
        type: 'CHART_READY',
        sessionId: 'mobile-layout-test',
        capabilities: ['indicator-config-v2'],
      }));
    });
    expect(postMessage.mock.calls.filter(([message]) => (
      JSON.parse(String(message)).type === 'CHART_READY'
    ))).toHaveLength(1);
    delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
  });

  test('does not advertise v2 when the attached chart lacks study readback', async () => {
    mockAutoAttachStudyApi = false;
    const postMessage = jest.fn();
    (window as unknown as {
      ReactNativeWebView: { postMessage: (message: string) => void };
    }).ReactNativeWebView = { postMessage };
    render(<MobileAdvancedChartClient />);
    await screen.findByTestId('embedded-chart');
    await act(async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });

    const incompleteChart = {
      createStudy: mockChartApi.createStudy,
      removeEntity: mockChartApi.removeEntity,
      getAllStudies: mockChartApi.getAllStudies,
    };
    act(() => mockChartApiReadyCallback?.(
      incompleteChart as unknown as typeof mockChartApi,
    ));
    await act(async () => Promise.resolve());

    expect(postMessage).not.toHaveBeenCalledWith(expect.stringContaining('CHART_READY'));
    delete (window as unknown as { ReactNativeWebView?: unknown }).ReactNativeWebView;
  });
});
