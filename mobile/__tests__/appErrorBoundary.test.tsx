import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import {Text} from 'react-native';
import TestRenderer, {act} from 'react-test-renderer';
import AppErrorBoundary from '../src/app/AppErrorBoundary';
import {MOBILE_LOCALE_STORAGE_KEY} from '../src/i18n';

jest.mock('react-native-safe-area-context', () => {
  const ReactModule = require('react');
  const {View} = require('react-native');
  return {
    SafeAreaProvider: ({children}: {children?: React.ReactNode}) => children,
    SafeAreaView: (props: Record<string, unknown>) =>
      ReactModule.createElement(View, props),
  };
});

describe('AppErrorBoundary', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('shows a safe fallback and can remount the application tree', async () => {
    let shouldThrow = true;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    function Child() {
      if (shouldThrow) throw new Error('render failed');
      return <></>;
    }

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AppErrorBoundary>
          <Child />
        </AppErrorBoundary>,
      );
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({testID: 'app-error-fallback'})).toBeTruthy();
    shouldThrow = false;
    await act(async () => {
      renderer.root.findByProps({testID: 'app-error-retry'}).props.onPress();
      await Promise.resolve();
    });
    expect(renderer.root.findAllByProps({testID: 'app-error-fallback'})).toHaveLength(0);
    errorSpy.mockRestore();
  });

  it('uses the persisted English locale in the crash fallback', async () => {
    await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    function Child(): React.ReactElement {
      throw new Error('render failed');
    }

    let renderer!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <AppErrorBoundary>
          <Child />
        </AppErrorBoundary>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = renderer.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .join(' ');
    expect(text).toContain('This page is temporarily unavailable');
    expect(
      renderer.root.findByProps({accessibilityLabel: 'Reload app page'}),
    ).toBeTruthy();
    act(() => renderer.unmount());
    errorSpy.mockRestore();
  });
});
