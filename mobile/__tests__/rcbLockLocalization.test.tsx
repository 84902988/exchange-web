import AsyncStorage from '@react-native-async-storage/async-storage';
import React, { type ReactNode } from 'react';
import { Alert, Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import {
  rcbLockEn,
  rcbLockJa,
  rcbLockZhCN,
  rcbLockZhTW,
} from '../src/i18n/rcbLockCatalog';
import {
  LanguageProvider,
  MOBILE_LOCALE_STORAGE_KEY,
  createTranslator,
  useLanguage,
} from '../src/i18n';

const mockCreateRcbLock = jest.fn();
const mockFetchRcbLocks = jest.fn();
const mockFetchVipOverview = jest.fn();
const mockReleaseMaturedRcbLocks = jest.fn();
const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn() }),
}));

jest.mock('../src/api/vip', () => ({
  createRcbLock: (...args: unknown[]) => mockCreateRcbLock(...args),
  fetchRcbLocks: (...args: unknown[]) => mockFetchRcbLocks(...args),
  fetchVipOverview: (...args: unknown[]) => mockFetchVipOverview(...args),
  releaseMaturedRcbLocks: (...args: unknown[]) =>
    mockReleaseMaturedRcbLocks(...args),
}));

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import RcbLockScreen from '../src/screens/home/RcbLockScreen';

const overview = {
  effectiveLevelCode: 'VIP0',
  effectiveFeeSource: 'VIP',
  effectiveSpotMakerFee: '0.001',
  effectiveSpotTakerFee: '0.001',
  volume30d: '0',
  rcbAvailable: '5000',
  rcbFundingAvailable: '5000',
  rcbLocked: '600',
  rcbLockPeriodDays: 365,
  rcbFeePayPercent: '80',
  vipLevels: [],
  svipLevels: [
    {
      levelCode: 'SVIP1',
      levelName: 'SVIP 1',
      sortOrder: 1,
      spotMakerFee: '0.001',
      spotTakerFee: '0.001',
      min30dVolume: null,
      minRcbHold: null,
      minLockAmount: '1000',
      lockPeriodDays: 365,
      dividendRate: '0.05',
    },
  ],
};

const lock = {
  id: 8,
  assetSymbol: 'RCB',
  lockAmount: '600',
  lockPeriodDays: 365,
  startTime: '2026-08-02T10:00:00',
  endTime: '2027-08-02T10:00:00',
  status: 'LOCKED' as const,
  currentSvip: 'SVIP1',
  createdAt: '2026-08-02T10:00:00',
};

describe('RCB lock screen localization and write boundaries', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockAlert.mockClear();
    await AsyncStorage.clear();
    await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
    mockFetchVipOverview.mockResolvedValue(overview);
    mockFetchRcbLocks.mockResolvedValue([lock]);
    mockReleaseMaturedRcbLocks.mockResolvedValue({
      releasedCount: 0,
      releasedAmount: '0',
      lockIds: [],
    });
  });

  it('keeps every RCB lock key explicit in all four languages', () => {
    const expectedKeys = Object.keys(rcbLockZhCN).sort();
    expect(expectedKeys).toHaveLength(46);
    expect(Object.keys(rcbLockZhTW).sort()).toEqual(expectedKeys);
    expect(Object.keys(rcbLockEn).sort()).toEqual(expectedKeys);
    expect(Object.keys(rcbLockJa).sort()).toEqual(expectedKeys);
    expect(
      createTranslator('en')('rcbLock.confirmDescription', {
        amount: '100',
        days: 365,
      }),
    ).toContain('Lock 100 RCB for 365 days');
    expect(createTranslator('ja')('rcbLock.statusUnlocked')).toBe('返還済み');
  });

  it('renders the full English screen without creating a new lock', async () => {
    const renderer = await renderEnglishScreen();
    const text = renderedText(renderer);
    expect(text).toContain('RCB lock');
    expect(text).toContain('Funding available');
    expect(text).toContain('New lock');
    expect(text).toContain('Confirm lock');
    expect(text).toContain('SVIP lock rules');
    expect(text).toContain('Lock records');
    expect(text).toContain('Locked');
    expect(text).not.toContain('RCB 锁仓');
    expect(mockFetchVipOverview).toHaveBeenCalledTimes(1);
    expect(mockFetchRcbLocks).toHaveBeenCalledTimes(1);
    expect(mockReleaseMaturedRcbLocks).toHaveBeenCalledTimes(1);
    expect(mockCreateRcbLock).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('localizes known client contract failures without running reconciliation', async () => {
    mockFetchVipOverview.mockRejectedValueOnce(
      new Error('VIP 概览响应格式无效'),
    );
    const renderer = await renderEnglishScreen();
    const text = renderedText(renderer);
    expect(text).toContain('RCB lock is unavailable');
    expect(text).toContain('RCB lock data is invalid');
    expect(text).not.toContain('响应格式无效');
    expect(mockReleaseMaturedRcbLocks).not.toHaveBeenCalled();
    expect(mockCreateRcbLock).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('locks duplicate confirmation dialogs and duplicate lock requests', async () => {
    const pending = new Promise(() => undefined);
    mockCreateRcbLock.mockReturnValueOnce(pending);
    const renderer = await renderEnglishScreen();

    act(() => {
      renderer.root
        .findByProps({ accessibilityLabel: 'Lock amount' })
        .props.onChangeText('1000');
    });
    const submit = renderer.root.findByProps({
      accessibilityLabel: 'Confirm lock',
    });
    act(() => {
      submit.props.onPress();
      submit.props.onPress();
    });
    expect(mockAlert).toHaveBeenCalledTimes(1);

    const buttons = mockAlert.mock.calls[0][2] as Array<{
      text?: string;
      onPress?: () => void | Promise<void>;
    }>;
    const confirm = buttons.find(button => button.text === 'Confirm lock');
    expect(confirm).toBeDefined();
    act(() => {
      confirm?.onPress?.();
      confirm?.onPress?.();
    });
    expect(mockCreateRcbLock).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});

function Ready({ children }: { children: ReactNode }) {
  const { ready } = useLanguage();
  return ready ? <>{children}</> : null;
}

async function renderEnglishScreen() {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <LanguageProvider>
        <Ready>
          <RcbLockScreen />
        </Ready>
      </LanguageProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return renderer;
}

function renderedText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .map(value => String(value))
    .join(' ');
}
