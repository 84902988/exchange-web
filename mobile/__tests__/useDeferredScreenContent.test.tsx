import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {View} from 'react-native';

import {useDeferredScreenContent} from '../src/hooks/useDeferredScreenContent';

function Harness({active}: {active: boolean}) {
  const ready = useDeferredScreenContent(active);
  return <View accessibilityState={{busy: !ready}} testID="ready-state" />;
}

type TestIdleGlobal = typeof globalThis & {
  requestIdleCallback?: (
    callback: () => void,
    options?: {timeout?: number},
  ) => number;
  cancelIdleCallback?: (handle: number) => void;
};

describe('useDeferredScreenContent', () => {
  const idleGlobal = globalThis as TestIdleGlobal;
  const originalRequestIdleCallback = idleGlobal.requestIdleCallback;
  const originalCancelIdleCallback = idleGlobal.cancelIdleCallback;

  afterEach(() => {
    idleGlobal.requestIdleCallback = originalRequestIdleCallback;
    idleGlobal.cancelIdleCallback = originalCancelIdleCallback;
    jest.restoreAllMocks();
  });

  it('defers heavy content with the supported idle callback API', () => {
    let idleCallback: (() => void) | null = null;
    const requestIdleCallback = jest.fn((callback: () => void) => {
      idleCallback = callback;
      return 42;
    });
    const cancelIdleCallback = jest.fn();
    idleGlobal.requestIdleCallback = requestIdleCallback;
    idleGlobal.cancelIdleCallback = cancelIdleCallback;

    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<Harness active />);
    });
    expect(
      renderer!.root.findByProps({testID: 'ready-state'}).props
        .accessibilityState.busy,
    ).toBe(true);
    expect(requestIdleCallback).toHaveBeenCalledWith(
      expect.any(Function),
      {timeout: 500},
    );

    act(() => {
      idleCallback?.();
    });
    expect(
      renderer!.root.findByProps({testID: 'ready-state'}).props
        .accessibilityState.busy,
    ).toBe(false);

    act(() => renderer!.unmount());
    expect(cancelIdleCallback).toHaveBeenCalledWith(42);
  });

});
