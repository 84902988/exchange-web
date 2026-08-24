import React from 'react';
import { Switch, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { LanguageProvider, MOBILE_LOCALE_STORAGE_KEY } from '../src/i18n';

const mockGoBack = jest.fn();
const mockNavigate = jest.fn();
const mockFetchOverview = jest.fn();
const mockFetchPreference = jest.fn();
const mockUpdatePreference = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: mockNavigate }),
}));

jest.mock('../src/api/vip', () => ({
  fetchVipOverview: (...args: unknown[]) => mockFetchOverview(...args),
  fetchVipFeePreference: (...args: unknown[]) => mockFetchPreference(...args),
  updateVipFeePreference: (...args: unknown[]) => mockUpdatePreference(...args),
}));

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import VipCenterScreen from '../src/screens/home/VipCenterScreen';

const overview = {
  effectiveLevelCode: 'VIP1',
  effectiveFeeSource: 'VIP',
  effectiveSpotMakerFee: '0.001',
  effectiveSpotTakerFee: '0.0015',
  volume30d: '25000',
  rcbAvailable: '20',
  rcbFundingAvailable: '20',
  rcbLocked: '10',
  rcbLockPeriodDays: 365,
  rcbFeePayPercent: '80',
  vipLevels: [
    {
      levelCode: 'VIP1',
      levelName: 'VIP 1',
      sortOrder: 1,
      spotMakerFee: '0.001',
      spotTakerFee: '0.0015',
      min30dVolume: '10000',
      minRcbHold: '5',
      minLockAmount: null,
      lockPeriodDays: null,
      dividendRate: null,
    },
  ],
  svipLevels: [
    {
      levelCode: 'SVIP2',
      levelName: 'SVIP 2',
      sortOrder: 2,
      spotMakerFee: '0.0008',
      spotTakerFee: '0.0012',
      min30dVolume: null,
      minRcbHold: null,
      minLockAmount: '2000',
      lockPeriodDays: 365,
      userLimit: 88,
      dividendRate: '0.05',
    },
  ],
};

function screenText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .map(value => String(value))
    .join(' ');
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function preferenceSwitch(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root.findByProps({
    accessibilityLabel: '使用 RCB 抵扣手续费',
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(nextResolve => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

describe('mobile VIP RCB fee preference', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchOverview.mockResolvedValue(overview);
    mockFetchPreference.mockResolvedValue({ useRcbFee: false });
    mockUpdatePreference.mockResolvedValue({ useRcbFee: true });
  });

  it('loads the server preference and saves an explicit toggle result', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<VipCenterScreen />);
      await flushPromises();
    });

    expect(renderer.root.findAllByType(Switch)).toHaveLength(1);
    expect(preferenceSwitch(renderer).props.value).toBe(false);

    await act(async () => {
      preferenceSwitch(renderer).props.onValueChange(true);
      await flushPromises();
    });

    expect(mockUpdatePreference).toHaveBeenCalledTimes(1);
    expect(mockUpdatePreference).toHaveBeenCalledWith(true);
    expect(preferenceSwitch(renderer).props.value).toBe(true);
    expect(screenText(renderer)).toContain('已开启 RCB 手续费抵扣');
    expect(screenText(renderer)).toContain('人数上限 88 人');
    expect(screenText(renderer)).toContain('分红比例 5%');
    act(() => renderer.unmount());
  });

  it('rolls back a failed save and keeps duplicate changes locked out', async () => {
    let rejectSave!: (error: Error) => void;
    const pendingSave = new Promise<never>((_resolve, reject) => {
      rejectSave = reject;
    });
    mockUpdatePreference.mockReturnValueOnce(pendingSave);

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<VipCenterScreen />);
      await flushPromises();
    });

    act(() => {
      preferenceSwitch(renderer).props.onValueChange(true);
    });
    expect(preferenceSwitch(renderer).props.disabled).toBe(true);
    act(() => {
      preferenceSwitch(renderer).props.onValueChange(false);
    });
    expect(mockUpdatePreference).toHaveBeenCalledTimes(1);

    await act(async () => {
      rejectSave(new Error('network timeout'));
      await expect(pendingSave).rejects.toThrow('network timeout');
      await flushPromises();
    });

    expect(preferenceSwitch(renderer).props.value).toBe(false);
    expect(preferenceSwitch(renderer).props.disabled).toBe(false);
    expect(screenText(renderer)).toContain('保存失败，已恢复原设置');
    act(() => renderer.unmount());
  });

  it('keeps VIP data visible when only the preference request fails', async () => {
    mockFetchPreference.mockRejectedValueOnce(new Error('network timeout'));

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<VipCenterScreen />);
      await flushPromises();
    });

    expect(screenText(renderer)).toContain('VIP 1');
    expect(screenText(renderer)).toContain('RCB 手续费抵扣设置加载失败');
    expect(preferenceSwitch(renderer).props.disabled).toBe(true);

    mockFetchPreference.mockResolvedValueOnce({ useRcbFee: true });
    await act(async () => {
      renderer.root
        .findByProps({ accessibilityLabel: '重试读取抵扣设置' })
        .props.onPress();
      await flushPromises();
    });
    expect(preferenceSwitch(renderer).props.value).toBe(true);
    expect(preferenceSwitch(renderer).props.disabled).toBe(false);
    act(() => renderer.unmount());
  });

  it('aborts pending VIP reads when the screen exits', async () => {
    const pending = deferred<typeof overview>();
    let signal: AbortSignal | undefined;
    mockFetchOverview.mockImplementationOnce(
      (options?: { signal?: AbortSignal }) => {
        signal = options?.signal;
        return pending.promise;
      },
    );

    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<VipCenterScreen />);
      await Promise.resolve();
    });
    expect(signal?.aborted).toBe(false);
    act(() => renderer.unmount());
    expect(signal?.aborted).toBe(true);
  });

  it('renders VIP labels in English without changing the fee preference', async () => {
    await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <VipCenterScreen />
        </LanguageProvider>,
      );
      await flushPromises();
    });

    const text = screenText(renderer);
    expect(text).toContain('VIP benefits');
    expect(text).toContain('Current trading benefits');
    expect(text).toContain('30-day trading volume');
    expect(text).toContain('Level fees');
    expect(
      renderer.root.findByProps({
        accessibilityLabel: 'Use RCB to pay trading fees',
      }),
    ).toBeTruthy();
    expect(mockUpdatePreference).not.toHaveBeenCalled();
    act(() => renderer.unmount());
    await AsyncStorage.removeItem(MOBILE_LOCALE_STORAGE_KEY);
  });
});
