import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {DividendRecordPage, DividendSummary} from '../src/api/dividend';
import {
  LanguageProvider,
  MOBILE_LOCALE_STORAGE_KEY,
  createTranslator,
} from '../src/i18n';

const mockGoBack = jest.fn();
const mockFetchSummary = jest.fn();
const mockFetchRecords = jest.fn();

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({goBack: mockGoBack}),
}));

jest.mock('../src/api/dividend', () => ({
  fetchMyDividendSummary: (...args: unknown[]) => mockFetchSummary(...args),
  fetchMyDividendRecords: (...args: unknown[]) => mockFetchRecords(...args),
}));

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({children}: {children?: React.ReactNode}) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

import DividendCenterScreen, {
  formatDividendPaidAt,
  formatDividendStatus,
} from '../src/screens/account/DividendCenterScreen';

const summary: DividendSummary = {
  totalRcb: '120.5',
  monthRcb: '20.5',
  latestAmountRcb: '10.25',
  latestDividendDate: '2026-07-31',
  latestStatus: 'PAID',
  currentSvipLevel: 'SVIP1',
  eligible: true,
};

const firstPage: DividendRecordPage = {
  items: [
    {
      id: 7,
      dividendDate: '2026-07-31',
      svipLevelCode: 'SVIP1',
      amountRcb: '10.25',
      amountUsdt: '8.5',
      status: 'PAID',
      paidAt: '2026-08-01T02:30:00Z',
    },
  ],
  total: 21,
  page: 1,
  pageSize: 20,
};

function screenText(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .flatMap(node => node.props.children)
    .filter(value => typeof value === 'string' || typeof value === 'number')
    .map(value => String(value))
    .join(' ');
}

describe('mobile dividend center screen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchSummary.mockResolvedValue(summary);
    mockFetchRecords.mockResolvedValue(firstPage);
  });

  it('renders account-owned summary and records, then loads the next page', async () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<DividendCenterScreen />);
      await Promise.resolve();
    });

    let text = screenText(renderer);
    expect(text).toContain('当前具备分红资格');
    expect(text).toContain('120.5 RCB');
    expect(text).toContain('10.25 RCB');
    expect(text).toContain('已发放');
    expect(text).toMatch(/1\s+\/\s+2/);

    mockFetchRecords.mockResolvedValueOnce({
      items: [],
      total: 21,
      page: 2,
      pageSize: 20,
    });
    await act(async () => {
      renderer.root.findByProps({accessibilityLabel: '下一页'}).props.onPress();
      await Promise.resolve();
    });
    expect(mockFetchRecords).toHaveBeenLastCalledWith(
      2,
      20,
      expect.objectContaining({signal: expect.any(Object)}),
    );
    text = screenText(renderer);
    expect(text).toContain('暂无分红记录');
    expect(text).toMatch(/2\s+\/\s+2/);
    act(() => renderer.unmount());
  });

  it('shows an explicit empty state and a retryable error state', async () => {
    mockFetchRecords.mockResolvedValueOnce({
      items: [],
      total: 0,
      page: 1,
      pageSize: 20,
    });
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(<DividendCenterScreen />);
      await Promise.resolve();
    });
    expect(screenText(renderer)).toContain('暂无分红记录');
    act(() => renderer.unmount());

    mockFetchSummary.mockRejectedValueOnce(new Error('network timeout'));
    await act(async () => {
      renderer = ReactTestRenderer.create(<DividendCenterScreen />);
      await Promise.resolve();
    });
    expect(screenText(renderer)).toContain('分红记录暂不可用');
    expect(screenText(renderer)).toContain('网络连接异常，请稍后重试');
    expect(
      renderer.root.findByProps({accessibilityLabel: '重新加载'}),
    ).toBeTruthy();
    act(() => renderer.unmount());
  });

  it('formats statuses and paid timestamps conservatively', () => {
    expect(formatDividendStatus('CALCULATED')).toBe('待发放');
    expect(formatDividendStatus('FAILED')).toBe('发放失败');
    expect(formatDividendPaidAt('invalid')).toBe('--');
    expect(formatDividendPaidAt(null)).toBe('--');
  });

  it('renders financial labels in English while preserving backend values', async () => {
    await AsyncStorage.setItem(MOBILE_LOCALE_STORAGE_KEY, 'en');
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = ReactTestRenderer.create(
        <LanguageProvider>
          <DividendCenterScreen />
        </LanguageProvider>,
      );
      await Promise.resolve();
    });

    const text = screenText(renderer);
    expect(text).toContain('My Dividends');
    expect(text).toContain('Currently eligible for dividends');
    expect(text).toContain('Total dividends');
    expect(text).toContain('120.5 RCB');
    expect(text).toContain('SVIP1');
    expect(text).toContain('Distributed');
    expect(formatDividendStatus('CALCULATED', createTranslator('en'))).toBe(
      'Pending distribution',
    );
    act(() => renderer.unmount());
    await AsyncStorage.removeItem(MOBILE_LOCALE_STORAGE_KEY);
  });
});
