import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import {
  MAIN_TAB_PRELOAD_ORDER,
  type PreloadableMainTab,
  usePreloadMainTabs,
} from '../src/hooks/usePreloadMainTabs';

function Harness({
  preload,
}: {
  preload: (route: PreloadableMainTab) => void;
}) {
  usePreloadMainTabs(preload);
  return null;
}

type TestIdleGlobal = typeof globalThis & {
  requestIdleCallback?: (
    callback: () => void,
    options?: {timeout?: number},
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

describe('usePreloadMainTabs', () => {
  const idleGlobal = globalThis as TestIdleGlobal;
  const originalRequestIdleCallback = idleGlobal.requestIdleCallback;
  const originalCancelIdleCallback = idleGlobal.cancelIdleCallback;

  afterEach(() => {
    idleGlobal.requestIdleCallback = originalRequestIdleCallback;
    idleGlobal.cancelIdleCallback = originalCancelIdleCallback;
    jest.useRealTimers();
  });

  it('preloads non-home tabs sequentially across idle windows', () => {
    jest.useFakeTimers();
    const idleCallbacks: Array<() => void> = [];
    idleGlobal.requestIdleCallback = jest.fn((callback: () => void) => {
      idleCallbacks.push(callback);
      return idleCallbacks.length;
    });
    idleGlobal.cancelIdleCallback = jest.fn();
    const preload = jest.fn();

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<Harness preload={preload} />);
    });

    for (const route of MAIN_TAB_PRELOAD_ORDER) {
      act(() => {
        idleCallbacks.shift()?.();
      });
      expect(preload).toHaveBeenLastCalledWith(route);
      act(() => {
        jest.advanceTimersByTime(200);
      });
    }

    expect(preload.mock.calls.map(call => call[0])).toEqual(
      MAIN_TAB_PRELOAD_ORDER,
    );
    act(() => renderer.unmount());
  });
});
