import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import type {
  StockTokenConvertRecord,
  StockTokenLock,
} from '../src/api/stockToken';
import {
  stockTokenEn,
  stockTokenJa,
  stockTokenZhCN,
  stockTokenZhTW,
} from '../src/i18n/stockTokenCatalog';
import {
  LanguageProvider,
  MOBILE_LOCALE_STORAGE_KEY,
  createTranslator,
} from '../src/i18n';

const mockGoBack = jest.fn();
const mockFetchLocks = jest.fn();
const mockFetchConverts = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({goBack: mockGoBack}),
}));

jest.mock('../src/api/stockToken', () => ({
  fetchStockTokenLocks: (...args: unknown[]) => mockFetchLocks(...args),
  fetchStockTokenConverts: (...args: unknown[]) => mockFetchConverts(...args),
}));

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({children}: {children?: React.ReactNode}) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import AssetStockTokenEntry from '../src/components/assets/AssetStockTokenEntry';
import StockTokenCenterScreen, {
  formatBackendUtcAt,
  formatDecimalAsPercent,
  formatLockStatus,
} from '../src/screens/assets/StockTokenCenterScreen';

const lock: StockTokenLock = {
  id: 9,
  lockSymbol: 'XABC',
  tradeSymbol: 'ABC',
  totalAmount: '100',
  lockedAmount: '75',
  availableAmount: '15',
  convertedAmount: '10',
  conversionRateSnapshot: '2.5',
  dailyReleaseRate: '0.01',
  lockDays: 30,
  releaseDays: 100,
  unlockAt: '2026-08-01T00:00:00',
  lockStartAt: '2026-07-02T00:00:00',
  lockEndAt: '2026-08-01T00:00:00',
  releaseStartAt: '2026-08-01T00:00:00',
  releaseFinishAt: '2026-11-09T00:00:00',
  releaseStarted: true,
  progressPercent: '25',
  status: 'ACTIVE',
  startAt: '2026-07-02T00:00:00',
  endAt: '2026-11-09T00:00:00',
};

const convert: StockTokenConvertRecord = {
  id: 11,
  fromSymbol: 'XABC',
  toSymbol: 'ABC',
  fromAmount: '10',
  toAmount: '25',
  conversionRate: '2.5',
  status: 'SUCCESS',
  createdAt: '2026-08-03T03:20:00',
};

function screenText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .map(value => String(value))
    .join(' ');
}

describe('mobile stock token center screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchLocks.mockResolvedValue({items: [lock]});
    mockFetchConverts.mockResolvedValue({items: [convert]});
  });

  it('keeps every stock token key explicit in all four languages', () => {
    const expectedKeys = Object.keys(stockTokenZhCN).sort();
    expect(expectedKeys).toHaveLength(46);
    expect(Object.keys(stockTokenZhTW).sort()).toEqual(expectedKeys);
    expect(Object.keys(stockTokenEn).sort()).toEqual(expectedKeys);
    expect(Object.keys(stockTokenJa).sort()).toEqual(expectedKeys);
    expect(
      createTranslator('en')('stockToken.lockBatch', {id: 9}),
    ).toBe('Lock batch #9');
    expect(formatLockStatus('ACTIVE', createTranslator('ja'))).toBe('解除中');
  });

  it('renders lock release progress, conversion history, and the write boundary', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<StockTokenCenterScreen />);
      await Promise.resolve();
    });

    const text = screenText(renderer);
    expect(text).toMatch(/XABC\s+→\s+ABC/);
    expect(text).toContain('25%');
    expect(text).toContain('15 XABC');
    expect(text).toContain('兑换成功');
    expect(text).toContain('移动端当前仅提供查询');
    expect(renderer.root.findAllByProps({accessibilityLabel: '兑换'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('shows the precise saved rate separately for old and new batches', async () => {
    mockFetchLocks.mockResolvedValueOnce({items: [
      {...lock, dailyReleaseRate: '0.00120000'},
      {...lock, id: 10, dailyReleaseRate: '0.001234570000000000'},
    ]});
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<StockTokenCenterScreen />);
      await Promise.resolve();
    });
    const text = screenText(renderer);
    expect(text).toContain('0.12%');
    expect(text).toContain('0.123457%');
    expect(text).toContain('本批次每日释放');
    expect(text).toContain('后续配置调整不改变本批次的比例');
    act(() => renderer.unmount());
  });

  it('shows explicit empty and retryable error states', async () => {
    mockFetchLocks.mockResolvedValueOnce({items: []});
    mockFetchConverts.mockResolvedValueOnce({items: []});
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<StockTokenCenterScreen />);
      await Promise.resolve();
    });
    expect(screenText(renderer)).toContain('暂无股票代币锁仓');
    expect(screenText(renderer)).toContain('暂无兑换记录');
    act(() => renderer.unmount());

    mockFetchLocks.mockRejectedValueOnce(new Error('network timeout'));
    await act(async () => {
      renderer = ReactTestRenderer.create(<StockTokenCenterScreen />);
      await Promise.resolve();
    });
    expect(screenText(renderer)).toContain('股票代币数据暂不可用');
    expect(screenText(renderer)).toContain('网络连接异常，请稍后重试');
    expect(renderer.root.findByProps({accessibilityLabel: '重新加载'})).toBeTruthy();
    act(() => renderer.unmount());
  });

  it('renders the read-only center in English without refetching for locale', async () => {
    await AsyncStorage.clear();
    await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <StockTokenCenterScreen />
        </LanguageProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const text = screenText(renderer);
    expect(text).toContain('Stock tokens');
    expect(text).toContain('Lock release');
    expect(text).toContain('Conversion successful');
    expect(text).toContain('read-only access');
    expect(text).not.toContain('股票代币');
    expect(mockFetchLocks).toHaveBeenCalledTimes(1);
    expect(mockFetchConverts).toHaveBeenCalledTimes(1);
    expect(renderer.root.findAllByProps({accessibilityLabel: 'Convert'})).toHaveLength(0);
    act(() => renderer.unmount());
  });

  it('opens from the dedicated asset entry and formats backend UTC safely', () => {
    const onPress = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <AssetStockTokenEntry onPress={onPress} />,
      );
    });
    act(() => {
      renderer.root.findByProps({accessibilityLabel: '查看股票代币锁仓'}).props.onPress();
    });
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(formatDecimalAsPercent('0.01')).toBe('1');
    expect(formatDecimalAsPercent('0.0125')).toBe('1.25');
    expect(formatDecimalAsPercent('0.00123457')).toBe('0.123457');
    expect(formatDecimalAsPercent('0.00142857')).toBe('0.142857');
    expect(formatDecimalAsPercent('0.00000001')).toBe('0.000001');
    expect(formatDecimalAsPercent('0.1')).toBe('10');
    expect(formatDecimalAsPercent('1')).toBe('100');
    expect(formatBackendUtcAt('invalid')).toBe('--');
    act(() => renderer.unmount());
  });
});
