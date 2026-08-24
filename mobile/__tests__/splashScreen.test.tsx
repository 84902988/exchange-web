import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {type ReactNode} from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import {
  LanguageProvider,
  MOBILE_LOCALE_STORAGE_KEY,
  useLanguage,
} from '../src/i18n';
import SplashScreen, {
  SPLASH_MAX_WAIT_MS,
  SPLASH_MIN_VISIBLE_MS,
} from '../src/screens/SplashScreen';

let mockAuthLoading = false;
let mockIsLoggedIn = false;

const mockLoadMobileContentBootstrap = jest.fn(() =>
  Promise.resolve({
    snapshot: null,
    source: 'error' as const,
    error: 'offline',
  }),
);

jest.mock('../src/api/mobileContent', () => ({
  loadMobileContentBootstrap: () => mockLoadMobileContentBootstrap(),
}));

jest.mock('../src/store/authStore', () => ({
  useAuth: () => ({
    isLoggedIn: mockIsLoggedIn,
    loading: mockAuthLoading,
  }),
}));

describe('SplashScreen', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    mockLoadMobileContentBootstrap.mockClear();
    mockAuthLoading = false;
    mockIsLoggedIn = false;
  });

  afterEach(() => {
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('shows the persisted English startup status', async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
    const replace = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <Ready>
            <SplashScreen
              navigation={{replace} as never}
              route={{key: 'splash', name: 'Splash'} as never}
            />
          </Ready>
        </LanguageProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(
      renderer.root
        .findAllByType(Text)
        .some(node => node.props.children === 'Starting up'),
    ).toBe(true);
    act(() => renderer.unmount());
  });

  it('enters after the short brand window when startup data is ready', async () => {
    const replace = jest.fn();
    let renderer: ReactTestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <SplashScreen
          navigation={{ replace } as never}
          route={{ key: 'splash', name: 'Splash' } as never}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockLoadMobileContentBootstrap).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();

    act(() => {
      jest.advanceTimersByTime(SPLASH_MIN_VISIBLE_MS - 1);
    });
    expect(replace).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(replace).toHaveBeenCalledWith('Main');

    act(() => {
      renderer!.unmount();
    });
  });

  it('never blocks entry indefinitely while auth restoration is slow', async () => {
    mockAuthLoading = true;
    const replace = jest.fn();
    let renderer: ReactTestRenderer.ReactTestRenderer;

    await act(async () => {
      renderer = ReactTestRenderer.create(
        <SplashScreen
          navigation={{ replace } as never}
          route={{ key: 'splash', name: 'Splash' } as never}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    act(() => {
      jest.advanceTimersByTime(SPLASH_MAX_WAIT_MS - 1);
    });
    expect(replace).not.toHaveBeenCalled();
    act(() => {
      jest.advanceTimersByTime(1);
    });
    expect(replace).toHaveBeenCalledWith('Main');

    act(() => {
      renderer!.unmount();
    });
  });
});

function Ready({children}: {children: ReactNode}) {
  const {ready} = useLanguage();
  return ready ? <>{children}</> : null;
}
