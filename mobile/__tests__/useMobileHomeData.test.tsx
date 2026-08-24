import React, { useEffect } from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import type {
  MobileContentLoadResult,
  MobileContentSnapshot,
} from '../src/api/mobileContent';
import type { MarketInstrument } from '../src/api/market';
import {
  MOBILE_HOME_MARKET_REFRESH_MS,
  useMobileHomeData,
  type MobileHomeDataState,
} from '../src/hooks/useMobileHomeData';

const mockLoadMobileContentBootstrap = jest.fn();
const mockGetCachedMobileContent = jest.fn();
const mockFetchMobileMarkets = jest.fn();
const mockGetCachedMobileMarkets = jest.fn();
let mockFocusCallback: (() => void | (() => void)) | null = null;
let mockApplicationActive = true;

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void | (() => void)) => {
    mockFocusCallback = callback;
  },
}));

jest.mock('../src/api/mobileContent', () => ({
  getCachedMobileContent: (...args: unknown[]) =>
    mockGetCachedMobileContent(...args),
  loadMobileContentBootstrap: (...args: unknown[]) =>
    mockLoadMobileContentBootstrap(...args),
}));

jest.mock('../src/api/market', () => ({
  fetchMobileMarkets: (...args: unknown[]) => mockFetchMobileMarkets(...args),
  getCachedMobileMarkets: (...args: unknown[]) =>
    mockGetCachedMobileMarkets(...args),
}));

jest.mock('../src/hooks/useApplicationState', () => ({
  useApplicationActive: () => mockApplicationActive,
}));

let latestState: MobileHomeDataState | null = null;

function Probe() {
  const state = useMobileHomeData();
  useEffect(() => {
    latestState = state;
  }, [state]);
  return null;
}

function snapshot(revision: string): MobileContentSnapshot {
  return {
    schemaVersion: 1,
    revision,
    locale: 'zh-CN',
    site: { displayName: 'Mobile', logo: null },
    homeConfig: {
      version: 1,
      sections: {
        assetSummary: true,
        quickEntries: true,
        marketShortcuts: true,
        promos: true,
        announcements: true,
      },
      quickEntries: [],
      marketShortcutLimit: 4,
      marketShortcutSymbols: ['BTCUSDT', 'RCBUSDT', 'ETHUSDT', 'NVDAUSDT_PERP'],
    },
    hero: null,
    promos: [],
    announcements: [],
    fetchedAt: 100,
  };
}

function market(id: string): MarketInstrument {
  return {
    id,
    symbol: 'BTCUSDT',
    displaySymbol: 'BTC/USDT',
    name: 'Bitcoin',
    category: 'crypto',
    price: 100,
    changePercent: 1,
    pricePrecision: 2,
    source: 'api',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function startFocus() {
  let cleanup: void | (() => void);
  await act(async () => {
    cleanup = mockFocusCallback?.();
    await Promise.resolve();
  });
  return cleanup!;
}

describe('useMobileHomeData', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFocusCallback = null;
    mockApplicationActive = true;
    latestState = null;
    mockGetCachedMobileContent.mockReturnValue(null);
    mockGetCachedMobileMarkets.mockReturnValue([]);
  });

  it('settles content and markets independently and retains successful content', async () => {
    const contentRequest = deferred<MobileContentLoadResult>();
    const marketRequest = deferred<MarketInstrument[]>();
    mockLoadMobileContentBootstrap.mockReturnValue(contentRequest.promise);
    mockFetchMobileMarkets.mockReturnValue(marketRequest.promise);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    const cleanup = await startFocus();

    await act(async () => {
      contentRequest.resolve({
        snapshot: snapshot('content-r1'),
        source: 'network',
        error: null,
      });
      await contentRequest.promise;
    });
    expect(latestState?.content?.revision).toBe('content-r1');
    expect(latestState?.contentLoading).toBe(false);
    expect(latestState?.marketsLoading).toBe(true);

    await act(async () => {
      marketRequest.reject(new Error('offline'));
      await marketRequest.promise.catch(() => undefined);
    });
    expect(latestState?.content?.revision).toBe('content-r1');
    expect(latestState?.markets).toEqual([]);
    expect(latestState?.marketsError).toBeTruthy();

    act(() => {
      cleanup?.();
      renderer.unmount();
    });
  });

  it('ignores a response from a cleaned-up focus generation', async () => {
    const oldContent = deferred<MobileContentLoadResult>();
    const newContent = deferred<MobileContentLoadResult>();
    mockLoadMobileContentBootstrap
      .mockReturnValueOnce(oldContent.promise)
      .mockReturnValueOnce(newContent.promise);
    mockFetchMobileMarkets.mockResolvedValue([market('market-1')]);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    const oldCleanup = await startFocus();
    act(() => {
      oldCleanup?.();
    });
    const newCleanup = await startFocus();

    await act(async () => {
      newContent.resolve({
        snapshot: snapshot('new-r2'),
        source: 'network',
        error: null,
      });
      await newContent.promise;
    });
    expect(latestState?.content?.revision).toBe('new-r2');

    await act(async () => {
      oldContent.resolve({
        snapshot: snapshot('old-r1'),
        source: 'network',
        error: null,
      });
      await oldContent.promise;
    });
    expect(latestState?.content?.revision).toBe('new-r2');

    act(() => {
      newCleanup?.();
      renderer.unmount();
    });
  });

  it('clears expired operator content when refresh returns no snapshot', async () => {
    mockGetCachedMobileContent.mockReturnValue(snapshot('stale-r1'));
    mockFetchMobileMarkets.mockResolvedValue([]);
    mockLoadMobileContentBootstrap.mockResolvedValue({
      snapshot: null,
      source: 'error',
      error: '移动端内容更新失败，请稍后重试',
    });

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    const cleanup = await startFocus();

    await act(async () => {
      await Promise.resolve();
    });

    expect(latestState?.content).toBeNull();
    expect(latestState?.contentLoading).toBe(false);
    expect(latestState?.contentError).toBeTruthy();

    act(() => {
      cleanup?.();
      renderer.unmount();
    });
  });

  it('clears cached prices when the market refresh fails', async () => {
    mockGetCachedMobileMarkets.mockReturnValue([market('cached-market')]);
    mockLoadMobileContentBootstrap.mockResolvedValue({
      snapshot: snapshot('content-r1'),
      source: 'network',
      error: null,
    });
    mockFetchMobileMarkets.mockRejectedValue(new Error('offline'));

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    const cleanup = await startFocus();

    await act(async () => {
      await Promise.resolve();
    });

    expect(latestState?.markets).toEqual([]);
    expect(latestState?.marketsLoading).toBe(false);
    expect(latestState?.marketsError).toBeTruthy();

    act(() => {
      cleanup?.();
      renderer.unmount();
    });
  });

  it('refreshes market cards while focused and stops polling after cleanup', async () => {
    jest.useFakeTimers();
    try {
      mockLoadMobileContentBootstrap.mockResolvedValue({
        snapshot: snapshot('content-r1'),
        source: 'network',
        error: null,
      });
      mockFetchMobileMarkets
        .mockResolvedValueOnce([{...market('market-1'), price: 100}])
        .mockResolvedValueOnce([{...market('market-1'), price: 101}]);

      let renderer!: ReactTestRenderer.ReactTestRenderer;
      act(() => {
        renderer = ReactTestRenderer.create(<Probe />);
      });
      const cleanup = await startFocus();

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockFetchMobileMarkets).toHaveBeenCalledTimes(1);
      expect(latestState?.markets[0]?.price).toBe(100);

      await act(async () => {
        jest.advanceTimersByTime(MOBILE_HOME_MARKET_REFRESH_MS);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mockFetchMobileMarkets).toHaveBeenCalledTimes(2);
      expect(latestState?.markets[0]?.price).toBe(101);

      act(() => {
        cleanup?.();
        jest.advanceTimersByTime(MOBILE_HOME_MARKET_REFRESH_MS * 2);
        renderer.unmount();
      });
      expect(mockFetchMobileMarkets).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not fetch or poll while the application is backgrounded', async () => {
    jest.useFakeTimers();
    try {
      mockApplicationActive = false;
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      act(() => {
        renderer = ReactTestRenderer.create(<Probe />);
      });
      const cleanup = await startFocus();

      act(() => {
        jest.advanceTimersByTime(MOBILE_HOME_MARKET_REFRESH_MS * 3);
      });

      expect(mockLoadMobileContentBootstrap).not.toHaveBeenCalled();
      expect(mockFetchMobileMarkets).not.toHaveBeenCalled();
      act(() => {
        cleanup?.();
        renderer.unmount();
      });
    } finally {
      jest.useRealTimers();
    }
  });
});
