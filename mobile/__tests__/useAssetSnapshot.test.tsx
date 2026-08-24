import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import type {
  AssetSnapshot,
  AssetSnapshotLoadResult,
} from '../src/services/assetSnapshot';

const mockLoadAssetSnapshot = jest.fn();
const mockGetCachedAssetSnapshot = jest.fn();
let mockAuthState: {
  loading: boolean;
  user: { id: number | string } | null;
} = {
  loading: false,
  user: { id: 'user-a' },
};

jest.mock('../src/store/authStore', () => ({
  useAuth: () => mockAuthState,
}));

jest.mock('../src/services/assetSnapshot', () => ({
  getCachedAssetSnapshot: (userId: string) =>
    mockGetCachedAssetSnapshot(userId),
  isAssetSnapshotExpired: () => false,
  loadAssetSnapshot: (options: { userId: string; force?: boolean }) =>
    mockLoadAssetSnapshot(options),
  normalizeAssetSnapshotUserId: (value: unknown) => {
    if (typeof value === 'number') {
      return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
    }
    return typeof value === 'string' ? value.trim() : '';
  },
}));

jest.mock('@react-navigation/native', () => {
  const ReactModule = jest.requireActual<typeof import('react')>('react');
  return {
    useFocusEffect: (callback: React.EffectCallback) =>
      ReactModule.useEffect(callback, [callback]),
  };
});

import { useAssetSnapshot } from '../src/hooks/useAssetSnapshot';

function snapshot(userId: string, totalUsdt: number): AssetSnapshot {
  return {
    userId,
    rows: [],
    accounts: [],
    knownTotalUsdt: totalUsdt,
    totalUsdt,
    valuationComplete: true,
    missingPriceSymbols: [],
    incompleteSymbols: [],
    fetchedAt: 1_000,
  };
}

describe('useAssetSnapshot focus lifecycle', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAuthState = {
      loading: false,
      user: { id: 'user-a' },
    };
    mockGetCachedAssetSnapshot.mockReturnValue(null);
  });

  it('refreshes on focus and ignores a slow response from the previous user', async () => {
    const releases = new Map<
      string,
      (result: AssetSnapshotLoadResult) => void
    >();
    mockLoadAssetSnapshot.mockImplementation(
      ({ userId }: { userId: string }) =>
        new Promise<AssetSnapshotLoadResult>(resolve => {
          releases.set(userId, resolve);
        }),
    );
    const observed: {
      current: ReturnType<typeof useAssetSnapshot> | null;
    } = { current: null };
    function Probe() {
      observed.current = useAssetSnapshot();
      return null;
    }
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<Probe />);
    });
    expect(mockLoadAssetSnapshot).toHaveBeenCalledWith({
      userId: 'user-a',
      force: false,
    });

    act(() => {
      mockAuthState = {
        loading: false,
        user: { id: 'user-b' },
      };
      renderer!.update(<Probe />);
    });
    expect(mockLoadAssetSnapshot).toHaveBeenCalledWith({
      userId: 'user-b',
      force: false,
    });

    await act(async () => {
      releases.get('user-b')?.({
        snapshot: snapshot('user-b', 22),
        source: 'network',
        error: null,
      });
      await Promise.resolve();
    });
    expect(observed.current?.snapshot?.userId).toBe('user-b');
    expect(observed.current?.snapshot?.totalUsdt).toBe(22);

    await act(async () => {
      releases.get('user-a')?.({
        snapshot: snapshot('user-a', 11),
        source: 'network',
        error: null,
      });
      await Promise.resolve();
    });
    expect(observed.current?.snapshot?.userId).toBe('user-b');
    expect(observed.current?.snapshot?.totalUsdt).toBe(22);

    act(() => {
      renderer!.unmount();
    });
  });

  it('surfaces first-load failure as no snapshot instead of zero', async () => {
    mockLoadAssetSnapshot.mockResolvedValue({
      snapshot: null,
      source: 'error',
      error: 'offline',
    });
    const observed: {
      current: ReturnType<typeof useAssetSnapshot> | null;
    } = { current: null };
    function Probe() {
      observed.current = useAssetSnapshot();
      return null;
    }

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<Probe />);
      await Promise.resolve();
    });

    expect(observed.current?.snapshot).toBeNull();
    expect(observed.current?.loading).toBe(false);
    expect(observed.current?.error).toBe('offline');
    act(() => {
      renderer!.unmount();
    });
  });

  it('forces a network refresh when the user retries', async () => {
    mockLoadAssetSnapshot.mockResolvedValue({
      snapshot: snapshot('user-a', 11),
      source: 'network',
      error: null,
    });
    const observed: {
      current: ReturnType<typeof useAssetSnapshot> | null;
    } = { current: null };
    function Probe() {
      observed.current = useAssetSnapshot();
      return null;
    }

    let renderer: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<Probe />);
      await Promise.resolve();
    });
    mockLoadAssetSnapshot.mockClear();

    await act(async () => {
      observed.current?.reload();
      await Promise.resolve();
    });

    expect(mockLoadAssetSnapshot).toHaveBeenCalledWith({
      userId: 'user-a',
      force: true,
    });
    act(() => renderer!.unmount());
  });
});
