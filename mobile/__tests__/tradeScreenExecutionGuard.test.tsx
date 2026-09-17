import React from 'react';
import { Alert } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import { ApiClientError } from '../src/api/client';
import {
  createPendingTradeIntent,
  loadPendingTradeIntent,
  resetPendingTradeIntentMemoryForTests,
  savePendingTradeIntent,
} from '../src/services/pendingTradeIntent';

const mockNavigate = jest.fn();
const mockCancelSpotOrder = jest.fn();
const mockCreateSpotOrder = jest.fn();
const mockFetchSpotBalances = jest.fn();
const mockFetchSpotCurrentOrders = jest.fn();
const mockFetchSpotFeeRates = jest.fn();
const mockFeePayment = {
  useRcbFee: false,
  platformEnabled: true,
  payRatio: 0.75,
  minRcbFee: 0,
  spotRcbAvailable: 1,
  rcbUsdtPrice: 2,
};
const mockFetchSpotHistoryOrders = jest.fn();
const mockFetchSpotKlines = jest.fn();
const mockFetchSpotMyTrades = jest.fn();
const mockUseSpotMarketRealtime = jest.fn();
const mockFetchTradeIdempotencyStatus = jest.fn();

let mockMarketScreenActive = true;
let mockPrivateRealtimeStatus = 'open';
let mockIsLoggedIn = true;
let mockUserId = 7;
let mockSpotMarketState: Record<string, unknown>;
let mockRouteParams: Record<string, unknown> | undefined;
let mockOrderFormProps: Record<string, (...args: any[]) => any> | null = null;
let mockTradeBottomTabsProps: Record<string, any> | null = null;
let mockKlineChartProps: Record<string, any> | null = null;
let mockSymbolHeaderProps: Record<string, any> | null = null;
let mockMoreSheetProps: Record<string, any> | null = null;
let mockTopTabsProps: Record<string, any> | null = null;
let mockOrderBookProps: Record<string, any> | null = null;

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useRoute: () => ({ params: mockRouteParams }),
}));

jest.mock('../src/store/authStore', () => ({
  useAuth: () => ({
    isLoggedIn: mockIsLoggedIn,
    user: mockIsLoggedIn ? { id: mockUserId } : null,
  }),
}));

jest.mock('../src/hooks/useMarketScreenActive', () => ({
  useMarketScreenActive: () => mockMarketScreenActive,
}));

jest.mock('../src/hooks/useDeferredScreenContent', () => ({
  useDeferredScreenContent: () => true,
}));

jest.mock('../src/hooks/usePrivateTradingRealtime', () => ({
  usePrivateTradingRealtime: () => mockPrivateRealtimeStatus,
}));

jest.mock('../src/hooks/useSpotMarketRealtime', () => ({
  useSpotMarketRealtime: (...args: unknown[]) =>
    mockUseSpotMarketRealtime(...args),
}));

jest.mock('../src/api/spot', () => {
  const actual = jest.requireActual('../src/api/spot');
  return {
    ...actual,
    cancelSpotOrder: (...args: unknown[]) => mockCancelSpotOrder(...args),
    createSpotOrder: (...args: unknown[]) => mockCreateSpotOrder(...args),
    fetchSpotBalances: (...args: unknown[]) => mockFetchSpotBalances(...args),
    fetchSpotCurrentOrders: (...args: unknown[]) =>
      mockFetchSpotCurrentOrders(...args),
    fetchSpotCurrentOrdersPage: async (...args: unknown[]) => {
      const value = await mockFetchSpotCurrentOrders(...args);
      return Array.isArray(value)
        ? {
            items: value,
            hasMore: false,
            nextCursor: null,
            paginationSupported: true,
          }
        : value;
    },
    fetchSpotFeeRates: (...args: unknown[]) => mockFetchSpotFeeRates(...args),
    fetchSpotHistoryOrders: (...args: unknown[]) =>
      mockFetchSpotHistoryOrders(...args),
    fetchSpotHistoryOrdersPage: async (...args: unknown[]) => {
      const value = await mockFetchSpotHistoryOrders(...args);
      return Array.isArray(value)
        ? {
            items: value,
            hasMore: false,
            nextCursor: null,
            paginationSupported: true,
          }
        : value;
    },
    fetchSpotKlines: (...args: unknown[]) => mockFetchSpotKlines(...args),
    fetchSpotMyTrades: (...args: unknown[]) => mockFetchSpotMyTrades(...args),
    fetchSpotMyTradesPage: async (...args: unknown[]) => {
      const value = await mockFetchSpotMyTrades(...args);
      return Array.isArray(value)
        ? {
            items: value,
            hasMore: false,
            nextCursor: null,
            paginationSupported: true,
          }
        : value;
    },
  };
});

jest.mock('../src/api/tradeIdempotency', () => ({
  fetchTradeIdempotencyStatus: (...args: unknown[]) =>
    mockFetchTradeIdempotencyStatus(...args),
}));

jest.mock('../src/components/common/AppScreen', () => {
  const ReactModule = require('react');
  return {
    __esModule: true,
    default: ({ children }: { children?: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
  };
});

jest.mock('../src/components/trade/TradeOrderForm', () => ({
  __esModule: true,
  default: (props: Record<string, (...args: any[]) => any>) => {
    mockOrderFormProps = props;
    return null;
  },
}));

jest.mock('../src/components/trade/MobileKlineChart', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockKlineChartProps = props;
    return null;
  },
}));
jest.mock('../src/components/trade/TradeBottomTabs', () => ({
  __esModule: true,
  ...jest.requireActual('../src/components/trade/TradeBottomTabs'),
  default: (props: Record<string, (...args: any[]) => any>) => {
    mockTradeBottomTabsProps = props;
    return null;
  },
}));
jest.mock('../src/components/trade/TradeMoreSheet', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockMoreSheetProps = props;
    return null;
  },
}));
jest.mock('../src/components/trade/TradeOrderBook', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockOrderBookProps = props;
    return null;
  },
}));
jest.mock('../src/components/trade/TradeSymbolHeader', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockSymbolHeaderProps = props;
    return null;
  },
}));
jest.mock('../src/components/trade/TradeTopTabs', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockTopTabsProps = props;
    return null;
  },
}));

import TradeScreen from '../src/screens/trade/TradeScreen';

const keychainMock = Keychain as typeof Keychain & {
  __resetMock: () => void;
  __storeMockCredentials: (
    username: string,
    password: string,
    options?: Parameters<typeof Keychain.setGenericPassword>[2],
  ) => ReturnType<typeof Keychain.setGenericPassword>;
};

function executableMarketState() {
  return {
    ticker: {
      symbol: 'BTCUSDT',
      lastPrice: 100.5,
      changePercent: 0,
      pricePrecision: 2,
      displayPricePrecision: 1,
      amountPrecision: 6,
      minAmount: 0.001,
      minNotional: 5,
      freshness: 'LIVE',
      stale: false,
      marketStatus: 'OPEN',
    },
    depth: {
      symbol: 'BTCUSDT',
      bids: [{ price: 100, amount: 2 }],
      asks: [{ price: 101, amount: 3 }],
      freshness: 'LIVE',
      stale: false,
    },
    trades: [],
    executable: true,
    executionBid: 100,
    executionAsk: 101,
    executionObservedAtMs: 10_000,
    executionExpiresAtMs: 11_000,
    error: null,
  };
}

async function renderReadyTradeScreen() {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(<TradeScreen />);
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    mockOrderFormProps?.onOrderTypeChange('MARKET');
    mockOrderFormProps?.onAmountChange('1');
  });
  return renderer!;
}

function openConfirmation() {
  act(() => {
    mockOrderFormProps?.onSubmitPress();
  });
  const confirmationCall = (
    Alert.alert as jest.MockedFunction<typeof Alert.alert>
  ).mock.calls.find(call => call[0] === '确认买入 BTC');
  expect(confirmationCall).toBeDefined();
  const buttons = confirmationCall?.[2];
  const confirmButton = buttons?.find(button => button.text === '确认买入');
  expect(confirmButton?.onPress).toBeDefined();
  return confirmButton!;
}

const cancellableOrder = {
  id: '42',
  orderId: 42,
  symbol: 'BTCUSDT',
  side: 'BUY',
  orderType: 'LIMIT',
  price: '100',
  amount: '2',
  filledAmount: '0.5',
  status: 'PARTIALLY_FILLED',
  createdAt: '2026-07-31T00:00:00Z',
};

function openCancelConfirmation() {
  act(() => {
    mockTradeBottomTabsProps?.onCancelPress(cancellableOrder);
  });
  const confirmationCall = (
    Alert.alert as jest.MockedFunction<typeof Alert.alert>
  ).mock.calls.find(call => call[0] === '确认撤单');
  expect(confirmationCall).toBeDefined();
  const buttons = confirmationCall?.[2];
  const confirmButton = buttons?.find(button => button.text === '确认撤单');
  expect(confirmButton?.onPress).toBeDefined();
  return confirmButton!;
}

describe('TradeScreen execution confirmation lifecycle', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | null = null;

  beforeEach(async () => {
    await AsyncStorage.clear();
    keychainMock.__resetMock();
    resetPendingTradeIntentMemoryForTests();
    jest.useFakeTimers();
    jest.setSystemTime(10_000);
    jest.clearAllMocks();
    mockFetchTradeIdempotencyStatus.mockReset();
    mockFetchTradeIdempotencyStatus.mockRejectedValue(
      new Error('unexpected authority lookup'),
    );
    mockMarketScreenActive = true;
    mockPrivateRealtimeStatus = 'open';
    mockIsLoggedIn = true;
    mockUserId = 7;
    mockSpotMarketState = executableMarketState();
    mockRouteParams = undefined;
    mockOrderFormProps = null;
    mockTradeBottomTabsProps = null;
    mockKlineChartProps = null;
    mockSymbolHeaderProps = null;
    mockMoreSheetProps = null;
    mockTopTabsProps = null;
    mockOrderBookProps = null;
    mockUseSpotMarketRealtime.mockImplementation(() => mockSpotMarketState);
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    mockFetchSpotKlines.mockResolvedValue([]);
    mockFetchSpotBalances.mockResolvedValue([
      {
        coinSymbol: 'BTC',
        availableAmount: 10,
        frozenAmount: 0,
      },
      {
        coinSymbol: 'USDT',
        availableAmount: 100_000,
        frozenAmount: 0,
      },
    ]);
    mockFetchSpotCurrentOrders.mockResolvedValue([]);
    mockFetchSpotFeeRates.mockResolvedValue({
      makerRate: 0.001,
      takerRate: 0.002,
      payment: mockFeePayment,
    });
    mockFetchSpotHistoryOrders.mockResolvedValue([]);
    mockFetchSpotMyTrades.mockResolvedValue([]);
    mockCreateSpotOrder.mockResolvedValue({
      id: 1,
      orderNo: 'S-1',
      symbol: 'BTCUSDT',
      side: 'BUY',
      orderType: 'MARKET',
      status: 'OPEN',
    });
    mockCancelSpotOrder.mockResolvedValue({
      orderId: 42,
      orderNo: 'S-42',
      status: 'CANCELED',
    });
  });

  it('keeps a limit price empty until BBO copies the trusted execution ask', async () => {
    await act(async () => {
      renderer = ReactTestRenderer.create(<TradeScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOrderFormProps?.orderType).toBe('LIMIT');
    expect(mockOrderFormProps?.price).toBe('');

    await act(async () => {
      mockOrderFormProps?.onBboPress();
    });

    expect(mockOrderFormProps?.price).toBe('101');
  });

  it('navigates the chart action to the spot market detail route', async () => {
    renderer = await renderReadyTradeScreen();

    act(() => {
      mockSymbolHeaderProps?.onOpenChart();
    });
    expect(mockNavigate).toHaveBeenCalledWith('MarketDetail', {
      market: 'spot',
      symbol: 'BTCUSDT',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      displayLabel: 'BTC/USDT',
      initialInterval: '1m',
    });
  });

  it('passes the already visible Spot Klines into the detail preview', async () => {
    const initialKlines = [
      {
        openTime: 1_800_000_000_000,
        open: 100,
        high: 102,
        low: 99,
        close: 101,
        volume: 10,
      },
    ];
    mockFetchSpotKlines.mockResolvedValue(initialKlines);
    renderer = await renderReadyTradeScreen();

    act(() => {
      mockSymbolHeaderProps?.onOpenChart();
    });

    expect(mockNavigate).toHaveBeenCalledWith(
      'MarketDetail',
      expect.objectContaining({ initialKlines }),
    );
  });

  it('does not show private synchronization guards to logged-out users', async () => {
    mockIsLoggedIn = false;
    renderer = await renderReadyTradeScreen();

    expect(mockOrderFormProps?.feedbackText).toBe('');
    expect(mockOrderFormProps?.isLoggedIn).toBe(false);
  });

  it('recovers the fee estimate after a transient endpoint failure', async () => {
    mockFetchSpotFeeRates
      .mockRejectedValueOnce(new Error('backend restarting'))
      .mockResolvedValue({
        makerRate: 0.001,
        takerRate: 0.002,
        payment: mockFeePayment,
      });

    renderer = await renderReadyTradeScreen();

    expect(mockFetchSpotFeeRates).toHaveBeenCalledTimes(1);
    expect(mockOrderFormProps?.estimatedFeeText).toBe('费率重试中');

    await act(async () => {
      jest.advanceTimersByTime(5000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockFetchSpotFeeRates).toHaveBeenCalledTimes(2);
    expect(mockOrderFormProps?.estimatedFeeText).toBe('≈ 0.202 USDT');
  });

  it('shows the initial private synchronization reason while submission is guarded', async () => {
    mockFetchSpotBalances.mockReturnValue(new Promise(() => undefined));

    await act(async () => {
      renderer = ReactTestRenderer.create(<TradeScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOrderFormProps?.submitDisabled).toBe(true);
    expect(mockOrderFormProps?.feedbackText).toBe(
      '正在同步账户与当前委托，暂不能提交',
    );
    expect(mockOrderFormProps?.feedbackTone).not.toBe('error');
  });

  it('shows USDT and a funding-to-spot hint when RCB deduction is on but spot RCB is empty', async () => {
    mockFetchSpotFeeRates.mockResolvedValue({
      makerRate: 0.001,
      takerRate: 0.002,
      payment: { ...mockFeePayment, useRcbFee: true, spotRcbAvailable: 0 },
    });
    renderer = await renderReadyTradeScreen();
    expect(mockOrderFormProps?.estimatedFeeText).toBe('≈ 0.202 USDT');
    expect(
      renderer.root.findByProps({ testID: 'spot-fee-payment-hint' }).props
        .children,
    ).toContain('现货 RCB 不足');
    expect(
      renderer.root.findByProps({ testID: 'spot-fee-payment-hint' }).props
        .children,
    ).toContain('资金账户划转');
    expect(mockCreateSpotOrder).not.toHaveBeenCalled();
  });

  it('shows RCB estimates and refreshes eligibility while staying on the trading page', async () => {
    mockFetchSpotFeeRates
      .mockResolvedValueOnce({
        makerRate: 0.001,
        takerRate: 0.002,
        payment: { ...mockFeePayment, useRcbFee: true },
      })
      .mockResolvedValue({
        makerRate: 0.001,
        takerRate: 0.002,
        payment: { ...mockFeePayment, useRcbFee: true, spotRcbAvailable: 0 },
      });
    renderer = await renderReadyTradeScreen();
    expect(mockOrderFormProps?.estimatedFeeText).toBe('≈ 0.07575 RCB');
    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockOrderFormProps?.estimatedFeeText).toBe('≈ 0.202 USDT');
    expect(mockCreateSpotOrder).not.toHaveBeenCalled();
  });

  it('retries failed private synchronization when a guarded submit is pressed', async () => {
    mockFetchSpotBalances
      .mockRejectedValueOnce(new Error('现货余额暂不可用'))
      .mockResolvedValue([
        { coinSymbol: 'BTC', availableAmount: 10, frozenAmount: 0 },
        { coinSymbol: 'USDT', availableAmount: 100_000, frozenAmount: 0 },
      ]);

    await act(async () => {
      renderer = ReactTestRenderer.create(<TradeScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockFetchSpotBalances).toHaveBeenCalledTimes(1);

    await act(async () => {
      mockOrderFormProps?.onSubmitPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(Alert.alert).toHaveBeenCalledWith('无法提交', '现货余额暂不可用');
    expect(mockFetchSpotBalances).toHaveBeenCalledTimes(2);
    expect(mockOrderFormProps?.availableText).toBe('100,000 USDT');
  });

  it('keeps limit forms isolated from ticker renders while market forms receive the execution price', async () => {
    renderer = await renderReadyTradeScreen();

    await act(async () => {
      mockOrderFormProps?.onOrderTypeChange('LIMIT');
    });

    expect(mockOrderFormProps?.orderType).toBe('LIMIT');
    expect(mockOrderFormProps?.lastPrice).toBeNull();

    await act(async () => {
      mockOrderFormProps?.onOrderTypeChange('MARKET');
    });

    expect(mockOrderFormProps?.orderType).toBe('MARKET');
    expect(mockOrderFormProps?.lastPrice).toBe(101);
  });

  it('shows a non-blocking notice while private order realtime reconnects', async () => {
    mockPrivateRealtimeStatus = 'reconnecting';
    renderer = await renderReadyTradeScreen();

    expect(
      renderer.root.findAllByProps({
        children: '订单实时连接恢复中，页面仍会定时同步',
      }).length,
    ).toBeGreaterThan(0);
    expect(mockOrderFormProps?.submitDisabled).toBe(false);
  });

  it('uses display precision for visuals while retaining trading precision for limit validation', async () => {
    renderer = await renderReadyTradeScreen();

    expect(mockSymbolHeaderProps?.pricePrecision).toBe(1);
    expect(mockOrderBookProps?.pricePrecision).toBe(1);
    expect(mockKlineChartProps?.pricePrecision).toBe(1);

    await act(async () => {
      mockOrderFormProps?.onOrderTypeChange('LIMIT');
      mockOrderFormProps?.onPriceChange('100.55');
      mockOrderFormProps?.onAmountChange('1');
    });
    act(() => {
      mockOrderFormProps?.onSubmitPress();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      '确认买入 BTC',
      expect.stringContaining('价格：100.55 USDT'),
      expect.any(Array),
      expect.any(Object),
    );
    expect(Alert.alert).not.toHaveBeenCalledWith(
      '无法提交',
      '价格最多支持 1 位小数',
    );
  });

  afterEach(async () => {
    if (renderer) {
      await act(async () => {
        renderer?.unmount();
      });
    }
    renderer = null;
    jest.restoreAllMocks();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('submits while the same active lifecycle and lease remain valid', async () => {
    renderer = await renderReadyTradeScreen();
    const confirmButton = openConfirmation();

    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockCreateSpotOrder).toHaveBeenCalledTimes(1);
    expect(mockCreateSpotOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        client_order_id: expect.stringMatching(/^[a-z0-9][a-z0-9._-]{0,63}$/),
      }),
    );
  });

  it('keeps a confirmation valid when the periodic private refresh becomes due', async () => {
    renderer = await renderReadyTradeScreen();
    await act(async () => {
      mockOrderFormProps?.onOrderTypeChange('LIMIT');
      mockOrderFormProps?.onPriceChange('100');
      mockOrderFormProps?.onAmountChange('1');
    });
    const initialBalanceCalls = mockFetchSpotBalances.mock.calls.length;
    const confirmButton = openConfirmation();

    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
    });

    expect(mockFetchSpotBalances).toHaveBeenCalledTimes(initialBalanceCalls);

    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockCreateSpotOrder).toHaveBeenCalledTimes(1);
  });

  it('rejects a real spot order before confirmation when it is below the authoritative minimum', async () => {
    mockSpotMarketState = {
      ...executableMarketState(),
      ticker: {
        ...(executableMarketState().ticker as Record<string, unknown>),
        minNotional: 200,
      },
    };
    renderer = await renderReadyTradeScreen();

    act(() => {
      mockOrderFormProps?.onSubmitPress();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      '无法提交',
      expect.stringContaining('交易额不得低于 200 USDT'),
    );
    expect(mockCreateSpotOrder).not.toHaveBeenCalled();
  });

  it('surfaces a private response contract failure in the account tabs', async () => {
    mockFetchSpotBalances.mockRejectedValue(
      new Error('现货余额响应格式无效，请刷新后重试'),
    );

    renderer = await renderReadyTradeScreen();

    expect(mockTradeBottomTabsProps?.error).toBe(
      '现货余额响应格式无效，请刷新后重试',
    );
    expect(mockOrderFormProps?.submitDisabled).toBe(true);
  });

  it('keeps balances and current orders usable when only fills fail', async () => {
    mockFetchSpotMyTrades.mockRejectedValue(new Error('成交明细暂不可用'));
    mockFetchSpotCurrentOrders.mockResolvedValue([cancellableOrder]);

    renderer = await renderReadyTradeScreen();

    expect(mockTradeBottomTabsProps?.currentOrders).toEqual([cancellableOrder]);
    expect(mockTradeBottomTabsProps?.error).toBeNull();
    expect(mockOrderFormProps?.submitDisabled).toBe(false);
    act(() => {
      mockTradeBottomTabsProps?.onChange('fills');
    });
    expect(mockTradeBottomTabsProps?.error).toBe('成交明细暂不可用');
  });

  it('keeps the amount and locks submission when the create response cannot be verified', async () => {
    mockCreateSpotOrder.mockRejectedValue(
      new ApiClientError(
        '现货下单响应缺少有效订单标识或状态',
        'INVALID_SPOT_ORDER_RESPONSE',
      ),
    );
    renderer = await renderReadyTradeScreen();
    const confirmButton = openConfirmation();

    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockOrderFormProps?.amount).toBe('1');
    expect(Alert.alert).toHaveBeenCalledWith(
      '订单状态待确认',
      expect.stringContaining('请先查看委托记录'),
    );
    expect(mockOrderFormProps?.submitDisabled).toBe(true);
    expect(
      (Alert.alert as jest.MockedFunction<typeof Alert.alert>).mock.calls.some(
        call => call[0] === '订单已提交',
      ),
    ).toBe(false);
  });

  it('persists and retains a fail-closed lock when the create result is ambiguous', async () => {
    mockCreateSpotOrder.mockRejectedValue(
      new ApiClientError('请求超时，请稍后重试', 'TIMEOUT'),
    );
    renderer = await renderReadyTradeScreen();
    const confirmButton = openConfirmation();

    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockCreateSpotOrder).toHaveBeenCalledTimes(1);
    expect(mockOrderFormProps?.amount).toBe('1');
    expect(mockOrderFormProps?.submitDisabled).toBe(true);
    expect(Alert.alert).toHaveBeenCalledWith(
      '订单状态待确认',
      expect.stringContaining('暂勿重复提交'),
    );
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).resolves.toMatchObject({
      market: 'spot',
      ownerKey: '7',
      instrumentKey: 'BTCUSDT',
    });

    act(() => {
      mockOrderFormProps?.onSubmitPress();
    });
    expect(mockCreateSpotOrder).toHaveBeenCalledTimes(1);
  });

  it('clears the safety lock for an explicit server rejection', async () => {
    mockCreateSpotOrder.mockRejectedValue(
      new ApiClientError('交易额低于最小值', 'MIN_NOTIONAL', 400),
    );
    renderer = await renderReadyTradeScreen();
    const confirmButton = openConfirmation();

    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockOrderFormProps?.submitDisabled).toBe(false);
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).resolves.toBeNull();
    expect(Alert.alert).toHaveBeenCalledWith(
      '提交失败',
      '交易额低于该交易对的最小成交额',
    );
  });

  it('does not send an order when the persistent safety lock cannot be saved', async () => {
    renderer = await renderReadyTradeScreen();
    jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockRejectedValueOnce(new Error('storage unavailable'));
    const confirmButton = openConfirmation();

    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockCreateSpotOrder).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledWith(
      '未发送订单',
      expect.stringContaining('未提交任何委托'),
    );
    expect(mockOrderFormProps?.submitDisabled).toBe(false);
  });

  it('does not send after focus is lost while the safety intent is being persisted', async () => {
    let releaseStorage!: () => void;
    jest.spyOn(Keychain, 'setGenericPassword').mockImplementationOnce(
      (username, password, options) =>
        new Promise((resolve, reject) => {
          releaseStorage = () => {
            keychainMock
              .__storeMockCredentials(username, password, options)
              .then(resolve, reject);
          };
        }),
    );
    renderer = await renderReadyTradeScreen();
    const confirmButton = openConfirmation();
    let submitPromise!: Promise<void>;

    await act(async () => {
      submitPromise = Promise.resolve(confirmButton.onPress?.());
      await Promise.resolve();
    });
    mockMarketScreenActive = false;
    await act(async () => {
      renderer?.update(<TradeScreen />);
      await Promise.resolve();
    });
    await act(async () => {
      releaseStorage();
      await submitPromise;
    });

    expect(mockCreateSpotOrder).not.toHaveBeenCalled();
  });

  it('replays a persisted V2 intent with the same client id and clears only after an authoritative response', async () => {
    const intent = createPendingTradeIntent({
      market: 'spot',
      ownerKey: '7',
      instrumentKey: 'BTCUSDT',
      payload: {
        symbol: 'BTCUSDT',
        side: 'BUY' as const,
        order_type: 'LIMIT' as const,
        price: '100',
        amount: '2',
      },
      baselineIds: [41],
      createdAtMs: Date.parse('2026-07-31T00:00:00Z'),
    });
    await savePendingTradeIntent(intent);
    resetPendingTradeIntentMemoryForTests();
    mockFetchSpotHistoryOrders.mockResolvedValue([
      {
        ...cancellableOrder,
        id: '42',
        orderId: 42,
        price: '100',
        amount: '2',
        status: 'FILLED',
      },
    ]);

    renderer = await renderReadyTradeScreen();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOrderFormProps?.submitDisabled).toBe(true);
    expect(mockOrderFormProps?.pendingIntentReviewVisible).toBe(true);
    expect(mockOrderFormProps?.feedbackText).toContain('请先查看委托记录');
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).resolves.toMatchObject({ id: intent.id });

    await act(async () => {
      await mockOrderFormProps?.onPendingIntentReviewPress();
    });
    const reviewCall = (
      Alert.alert as jest.MockedFunction<typeof Alert.alert>
    ).mock.calls.find(call => call[0] === '重新确认订单');
    const confirmButton = reviewCall?.[2]?.[1];
    await act(async () => {
      await confirmButton?.onPress?.();
    });

    expect(mockCreateSpotOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        symbol: 'BTCUSDT',
        client_order_id: intent.clientOrderId,
      }),
    );
    expect(mockOrderFormProps?.pendingIntentReviewVisible).toBe(false);
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).resolves.toBeNull();
  });

  it('keeps a V2 lock when lifecycle changes before retry confirmation', async () => {
    const intent = createPendingTradeIntent({
      market: 'spot',
      ownerKey: '7',
      instrumentKey: 'BTCUSDT',
      payload: {
        symbol: 'BTCUSDT',
        side: 'SELL' as const,
        order_type: 'MARKET' as const,
        amount: '1',
      },
      createdAtMs: 1,
    });
    await savePendingTradeIntent(intent);
    resetPendingTradeIntentMemoryForTests();
    renderer = await renderReadyTradeScreen();
    await act(async () => {
      await mockOrderFormProps?.onPendingIntentReviewPress();
    });
    const reviewCall = (
      Alert.alert as jest.MockedFunction<typeof Alert.alert>
    ).mock.calls.find(call => call[0] === '重新确认订单');
    const confirmButton = reviewCall?.[2]?.[1];
    mockMarketScreenActive = false;
    await act(async () => {
      renderer!.update(<TradeScreen />);
      await Promise.resolve();
    });
    await act(async () => {
      await confirmButton?.onPress?.();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      '页面状态已变化',
      expect.stringContaining('重新进入当前交易对'),
    );
    expect(mockCreateSpotOrder).not.toHaveBeenCalled();
    resetPendingTradeIntentMemoryForTests();
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).resolves.toMatchObject({ id: intent.id });
  });

  it('does not clear a persisted lock unless both current and history authority load', async () => {
    const intent = createPendingTradeIntent({
      market: 'spot',
      ownerKey: '7',
      instrumentKey: 'BTCUSDT',
      payload: {
        symbol: 'BTCUSDT',
        side: 'BUY' as const,
        order_type: 'LIMIT' as const,
        price: '100',
        amount: '2',
      },
      baselineIds: [41],
      createdAtMs: Date.parse('2026-07-31T00:00:00Z'),
    });
    await savePendingTradeIntent(intent);
    resetPendingTradeIntentMemoryForTests();
    mockFetchSpotCurrentOrders.mockResolvedValue([
      {
        ...cancellableOrder,
        id: '42',
        orderId: 42,
        price: '100',
        amount: '2',
      },
    ]);
    mockFetchSpotHistoryOrders.mockRejectedValue(new Error('历史委托暂不可用'));

    renderer = await renderReadyTradeScreen();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOrderFormProps?.submitDisabled).toBe(true);
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).resolves.toMatchObject({ id: intent.id });
  });

  it('keeps a corrupt lock when server authority cannot confirm completion', async () => {
    const storageKey =
      '@exchange-mobile/pending-trade-intent/v1:spot:7:BTCUSDT';
    const raw = '{"version":2,"clientOrderId":"m-corrupt-spot-id","payload":';
    await AsyncStorage.setItem(storageKey, raw);
    resetPendingTradeIntentMemoryForTests();

    renderer = await renderReadyTradeScreen();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOrderFormProps?.submitDisabled).toBe(true);
    expect(mockOrderFormProps?.pendingIntentReviewVisible).toBe(true);
    expect(mockOrderFormProps?.pendingIntentReviewLabel).toBe('恢复订单');
    await act(async () => {
      await mockOrderFormProps?.onPendingIntentReviewPress();
    });
    expect(Alert.alert).toHaveBeenCalledWith(
      '查询订单结果',
      expect.stringContaining('查询上一笔订单的最新状态'),
      expect.any(Array),
    );
    const authorityPrompt = (
      Alert.alert as jest.MockedFunction<typeof Alert.alert>
    ).mock.calls.find(call => call[0] === '查询订单结果');
    mockFetchTradeIdempotencyStatus.mockResolvedValueOnce({
      market: 'spot',
      clientOrderId: 'm-corrupt-spot-id',
      status: 'NOT_FOUND',
      operation: null,
      result: null,
      resultSymbol: null,
      createdAt: null,
      completedAt: null,
    });
    await act(async () => {
      await authorityPrompt?.[2]?.[1]?.onPress?.();
    });
    expect(Alert.alert).toHaveBeenCalledWith(
      '订单状态待确认',
      expect.stringContaining('暂未查到上一笔订单结果'),
    );
    await expect(AsyncStorage.getItem(storageKey)).resolves.toBeNull();
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).rejects.toMatchObject({ kind: 'CORRUPT' });
    expect(mockCreateSpotOrder).not.toHaveBeenCalled();
  });

  it('clears a corrupt lock after an exact completed spot authority result', async () => {
    const storageKey =
      '@exchange-mobile/pending-trade-intent/v1:spot:7:BTCUSDT';
    const clientOrderId = 'm-corrupt-spot-completed';
    await AsyncStorage.setItem(
      storageKey,
      `{"version":2,"clientOrderId":"${clientOrderId}","payload":`,
    );
    resetPendingTradeIntentMemoryForTests();
    mockFetchTradeIdempotencyStatus.mockResolvedValueOnce({
      market: 'spot',
      clientOrderId,
      status: 'COMPLETED',
      operation: 'SPOT_CREATE',
      result: { id: 81, symbol: 'BTCUSDT', client_order_id: clientOrderId },
      resultSymbol: 'BTCUSDT',
      createdAt: '2026-08-02T01:02:03Z',
      completedAt: '2026-08-02T01:02:04Z',
    });

    renderer = await renderReadyTradeScreen();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await mockOrderFormProps?.onPendingIntentReviewPress();
    });
    const authorityPrompt = (
      Alert.alert as jest.MockedFunction<typeof Alert.alert>
    ).mock.calls.find(call => call[0] === '查询订单结果');
    await act(async () => {
      await authorityPrompt?.[2]?.[1]?.onPress?.();
    });

    await expect(AsyncStorage.getItem(storageKey)).resolves.toBeNull();
    expect(mockOrderFormProps?.pendingIntentReviewVisible).toBe(false);
    expect(Alert.alert).toHaveBeenCalledWith(
      '订单状态已恢复',
      expect.stringContaining('订单和余额正在刷新'),
    );
  });

  it('refreshes private spot state when the screen returns to the foreground', async () => {
    renderer = await renderReadyTradeScreen();
    const initialBalanceCalls = mockFetchSpotBalances.mock.calls.length;

    mockMarketScreenActive = false;
    await act(async () => {
      renderer?.update(<TradeScreen />);
    });
    mockMarketScreenActive = true;
    await act(async () => {
      renderer?.update(<TradeScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockFetchSpotBalances).toHaveBeenCalledTimes(
      initialBalanceCalls + 1,
    );
    expect(mockFetchSpotCurrentOrders).toHaveBeenCalledTimes(
      initialBalanceCalls + 1,
    );
  });

  it('opens the crypto market selector from the symbol header', async () => {
    renderer = await renderReadyTradeScreen();

    act(() => {
      mockSymbolHeaderProps?.onSymbolPress();
    });

    expect(mockNavigate).toHaveBeenCalledWith('Markets', {
      category: 'crypto',
    });
  });

  it('routes only real More actions and switches the order action to current records', async () => {
    renderer = await renderReadyTradeScreen();

    expect(mockTopTabsProps?.tabs).toEqual([{ key: 'spot', label: '现货' }]);
    const destinations = [
      ['deposit', 'AssetDeposit'],
      ['withdraw', 'AssetWithdraw'],
      ['transfer', 'AssetTransfer'],
      ['fundHistory', 'AssetHistory'],
      ['assets', 'Assets'],
      ['rcbFee', 'VipCenter'],
    ] as const;
    for (const [action, destination] of destinations) {
      act(() => {
        mockMoreSheetProps?.onActionPress(action);
      });
      expect(mockNavigate).toHaveBeenLastCalledWith(destination);
    }

    act(() => {
      mockTradeBottomTabsProps?.onChange('history');
    });
    expect(mockTradeBottomTabsProps?.activeTab).toBe('history');
    act(() => {
      mockMoreSheetProps?.onActionPress('orders');
    });
    expect(mockTradeBottomTabsProps?.activeTab).toBe('current');
    expect(mockMoreSheetProps?.visible).toBe(false);
  });

  it('rejects an old confirmation after focus is lost and restored', async () => {
    renderer = await renderReadyTradeScreen();
    const confirmButton = openConfirmation();

    mockMarketScreenActive = false;
    await act(async () => {
      renderer?.update(<TradeScreen />);
    });
    mockMarketScreenActive = true;
    await act(async () => {
      renderer?.update(<TradeScreen />);
    });
    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockCreateSpotOrder).not.toHaveBeenCalled();
  });

  it('rejects an old confirmation after the authenticated user changes', async () => {
    renderer = await renderReadyTradeScreen();
    const confirmButton = openConfirmation();

    mockUserId = 8;
    await act(async () => {
      renderer?.update(<TradeScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockCreateSpotOrder).not.toHaveBeenCalled();
  });

  it('switches every spot data owner to the routed symbol and rejects the old confirmation', async () => {
    renderer = await renderReadyTradeScreen();
    const confirmButton = openConfirmation();

    mockRouteParams = {
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      displayLabel: 'ETH/USDT',
    };
    mockSpotMarketState = {
      ...executableMarketState(),
      ticker: {
        ...(executableMarketState().ticker as Record<string, unknown>),
        symbol: 'ETHUSDT',
        lastPrice: 200,
      },
      depth: {
        ...(executableMarketState().depth as Record<string, unknown>),
        symbol: 'ETHUSDT',
      },
    };
    await act(async () => {
      renderer?.update(<TradeScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUseSpotMarketRealtime).toHaveBeenLastCalledWith(
      'ETHUSDT',
      'TradeScreen',
      true,
    );
    expect(mockFetchSpotKlines).toHaveBeenCalledWith('ETHUSDT', '1m', 80);
    expect(mockFetchSpotBalances).toHaveBeenCalledWith('ETHUSDT');
    expect(mockFetchSpotCurrentOrders).toHaveBeenCalledWith('ETHUSDT', 100);
    expect(mockFetchSpotHistoryOrders).toHaveBeenCalledWith('ETHUSDT', 100);
    expect(mockFetchSpotMyTrades).toHaveBeenCalledWith('ETHUSDT', 20);
    expect(mockOrderFormProps?.baseAsset).toBe('ETH');
    expect(mockOrderFormProps?.quoteAsset).toBe('USDT');
    expect(mockOrderFormProps?.amount).toBe('');
    expect(mockOrderBookProps?.baseAsset).toBe('ETH');
    expect(mockOrderBookProps?.quoteAsset).toBe('USDT');

    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockCreateSpotOrder).not.toHaveBeenCalled();
  });

  it('does not let a late Kline response from the old symbol replace the new symbol data', async () => {
    let resolveOldKlines!: (value: unknown) => void;
    const ethKlines = [
      {
        openTime: 2,
        open: 200,
        high: 202,
        low: 198,
        close: 201,
        volume: 8,
      },
    ];
    mockFetchSpotKlines.mockImplementation((symbol: string) =>
      symbol === 'BTCUSDT'
        ? new Promise(resolve => {
            resolveOldKlines = resolve;
          })
        : Promise.resolve(ethKlines),
    );
    renderer = await renderReadyTradeScreen();

    mockRouteParams = {
      symbol: 'ETHUSDT',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      displayLabel: 'ETH/USDT',
    };
    mockSpotMarketState = {
      ...executableMarketState(),
      ticker: {
        ...(executableMarketState().ticker as Record<string, unknown>),
        symbol: 'ETHUSDT',
      },
      depth: {
        ...(executableMarketState().depth as Record<string, unknown>),
        symbol: 'ETHUSDT',
      },
    };
    await act(async () => {
      renderer?.update(<TradeScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mockKlineChartProps?.items).toEqual(ethKlines);

    await act(async () => {
      resolveOldKlines([
        {
          openTime: 1,
          open: 100,
          high: 102,
          low: 98,
          close: 101,
          volume: 5,
        },
      ]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockKlineChartProps?.items).toEqual(ethKlines);
  });

  it('rejects an open confirmation after the screen unmounts', async () => {
    renderer = await renderReadyTradeScreen();
    const confirmButton = openConfirmation();

    await act(async () => {
      renderer?.unmount();
    });
    renderer = null;
    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockCreateSpotOrder).not.toHaveBeenCalled();
  });

  it('sends only one cancel request for repeated confirmation callbacks', async () => {
    let resolveCancel!: (value: unknown) => void;
    mockCancelSpotOrder.mockReturnValue(
      new Promise(resolve => {
        resolveCancel = resolve;
      }),
    );
    mockFetchSpotCurrentOrders.mockResolvedValue([cancellableOrder]);
    renderer = await renderReadyTradeScreen();
    const confirmButton = openCancelConfirmation();
    let firstRequest: Promise<void> | undefined;
    let repeatedRequest: Promise<void> | undefined;

    await act(async () => {
      firstRequest = confirmButton.onPress?.() as unknown as Promise<void>;
      repeatedRequest = confirmButton.onPress?.() as unknown as Promise<void>;
      await Promise.resolve();
    });

    expect(mockCancelSpotOrder).toHaveBeenCalledTimes(1);
    expect(mockCancelSpotOrder).toHaveBeenCalledWith(42);

    await act(async () => {
      resolveCancel({
        orderId: 42,
        orderNo: 'S-42',
        status: 'CANCELED',
      });
      await firstRequest;
      await repeatedRequest;
    });

    expect(mockFetchSpotCurrentOrders).toHaveBeenCalledTimes(2);
    expect(mockFetchSpotHistoryOrders).toHaveBeenCalledTimes(2);
    expect(mockFetchSpotBalances).toHaveBeenCalledTimes(2);
  });

  it('replaces a stale OPEN submission message after the order is canceled', async () => {
    mockFetchSpotCurrentOrders.mockResolvedValue([cancellableOrder]);
    renderer = await renderReadyTradeScreen();
    const submitButton = openConfirmation();

    await act(async () => {
      await submitButton.onPress?.();
    });
    expect(mockOrderFormProps?.feedbackText).toContain('已挂单');

    const cancelButton = openCancelConfirmation();
    await act(async () => {
      await cancelButton.onPress?.();
    });

    expect(mockOrderFormProps?.feedbackText).toBe(
      '订单 S-42 已撤销，未成交资产已释放。',
    );
    expect(mockOrderFormProps?.feedbackTone).toBe('success');
  });

  it('appends an older cursor page without replacing current records', async () => {
    mockFetchSpotCurrentOrders
      .mockResolvedValueOnce({
        items: [cancellableOrder],
        hasMore: true,
        nextCursor: 42,
        paginationSupported: true,
      })
      .mockResolvedValue({
        items: [{ ...cancellableOrder, id: '41', orderId: 41 }],
        hasMore: false,
        nextCursor: null,
        paginationSupported: true,
      });
    renderer = await renderReadyTradeScreen();

    expect(mockTradeBottomTabsProps?.hasMore).toBe(true);
    await act(async () => {
      await mockTradeBottomTabsProps?.onLoadMore();
    });

    expect(mockFetchSpotCurrentOrders).toHaveBeenLastCalledWith(
      'BTCUSDT',
      100,
      42,
    );
    expect(mockTradeBottomTabsProps?.currentOrders).toEqual([
      expect.objectContaining({ orderId: 42 }),
      expect.objectContaining({ orderId: 41 }),
    ]);
    expect(mockTradeBottomTabsProps?.hasMore).toBe(false);
  });

  it('reloads server state when cancel loses a fill race', async () => {
    mockCancelSpotOrder.mockRejectedValue(
      new Error('order cannot be canceled in status FILLED'),
    );
    mockFetchSpotCurrentOrders.mockResolvedValue([cancellableOrder]);
    renderer = await renderReadyTradeScreen();
    const confirmButton = openCancelConfirmation();

    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockCancelSpotOrder).toHaveBeenCalledTimes(1);
    expect(mockFetchSpotCurrentOrders).toHaveBeenCalledTimes(2);
    expect(mockFetchSpotHistoryOrders).toHaveBeenCalledTimes(2);
    expect(Alert.alert).toHaveBeenCalledWith(
      '撤单未完成',
      '订单状态已变化，已刷新最新状态。',
    );
  });
});
