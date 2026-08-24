import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

const mockRemove = jest.fn();
let mockAppStateHandler: ((state: string) => void) | null = null;
const mockAddEventListener = jest.fn(
  (_event: string, handler: (state: string) => void) => {
    mockAppStateHandler = handler;
    return {remove: mockRemove};
  },
);
let mockFocused = true;

type TestIdleGlobal = typeof globalThis & {
  requestIdleCallback?: (
    callback: () => void,
    options?: {timeout?: number},
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: (
      event: string,
      handler: (state: string) => void,
    ) => mockAddEventListener(event, handler),
  },
}));

jest.mock('@react-navigation/native', () => ({
  useIsFocused: () => mockFocused,
}));

import {
  isMarketScreenActive,
  useMarketScreenActive,
} from '../src/hooks/useMarketScreenActive';

describe('useMarketScreenActive', () => {
  const idleGlobal = globalThis as TestIdleGlobal;
  const originalRequestIdleCallback = idleGlobal.requestIdleCallback;
  const originalCancelIdleCallback = idleGlobal.cancelIdleCallback;
  let idleCallbacks: Array<() => void> = [];

  beforeEach(() => {
    jest.clearAllMocks();
    mockFocused = true;
    mockAppStateHandler = null;
    idleCallbacks = [];
    idleGlobal.requestIdleCallback = jest.fn((callback: () => void) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    idleGlobal.cancelIdleCallback = jest.fn();
  });

  afterAll(() => {
    idleGlobal.requestIdleCallback = originalRequestIdleCallback;
    idleGlobal.cancelIdleCallback = originalCancelIdleCallback;
  });

  it('requires navigation focus and the real AppState lifecycle', () => {
    expect(isMarketScreenActive(true, 'active')).toBe(true);
    expect(isMarketScreenActive(false, 'active')).toBe(false);
    expect(isMarketScreenActive(true, 'background')).toBe(false);
    expect(isMarketScreenActive(true, 'inactive')).toBe(false);
  });

  it('subscribes only to AppState change so Android blur does not churn connections', () => {
    let active = false;
    function Probe() {
      active = useMarketScreenActive();
      return null;
    }
    let renderer: ReactTestRenderer.ReactTestRenderer;

    act(() => {
      renderer = ReactTestRenderer.create(<Probe />);
    });

    expect(active).toBe(false);
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);
    expect(mockAddEventListener).toHaveBeenCalledWith(
      'change',
      expect.any(Function),
    );

    act(() => {
      idleCallbacks.shift()?.();
    });
    expect(active).toBe(true);

    act(() => {
      renderer!.unmount();
    });
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });

  it('shares one native lifecycle listener across resident tab consumers', () => {
    const activeStates: boolean[] = [];
    function Probe() {
      activeStates.push(useMarketScreenActive());
      return null;
    }
    let first!: ReactTestRenderer.ReactTestRenderer;
    let second!: ReactTestRenderer.ReactTestRenderer;

    act(() => {
      first = ReactTestRenderer.create(<Probe />);
      second = ReactTestRenderer.create(<Probe />);
    });
    expect(mockAddEventListener).toHaveBeenCalledTimes(1);

    act(() => {
      for (const callback of idleCallbacks.splice(0)) callback();
    });

    act(() => {
      mockAppStateHandler?.('background');
    });
    expect(activeStates.at(-1)).toBe(false);

    act(() => first.unmount());
    expect(mockRemove).not.toHaveBeenCalled();
    act(() => second.unmount());
    expect(mockRemove).toHaveBeenCalledTimes(1);
  });
});
