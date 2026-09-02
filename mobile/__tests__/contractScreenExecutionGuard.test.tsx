import React from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import { Alert } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import { ApiClientError } from '../src/api/client';
import {
  loadPendingTradeIntent,
  resetPendingTradeIntentMemoryForTests,
} from '../src/services/pendingTradeIntent';
import {
  CONTRACT_CLOSE_ALL_CONFIRM_HIDDEN_STORAGE_KEY,
  CONTRACT_TRADE_CONFIRM_HIDDEN_STORAGE_KEY,
} from '../src/services/contractTradeConfirmPreference';

const mockNavigate = jest.fn();
const mockCancelContractOrder = jest.fn();
const mockOpenContractOrder = jest.fn();
const mockCloseContractSummaryOrder = jest.fn();
const mockUpdateContractPositionTpSl = jest.fn();
const mockFetchContractAccountSummary = jest.fn();
const mockFetchContractKlines = jest.fn();
const mockFetchContractOrders = jest.fn();
const mockFetchContractPositions = jest.fn();
const mockFetchContractSymbolRules = jest.fn();
const mockFetchContractTrades = jest.fn();
const mockUseContractKlineRealtime = jest.fn();
const mockUseContractMarketRealtime = jest.fn();
const mockWaitForExecutionLease = jest.fn();
const mockFetchTradeIdempotencyStatus = jest.fn();

let mockMarketScreenActive = true;
let mockPrivateRealtimeStatus = 'open';
let mockIsLoggedIn = true;
let mockUserId = 7;
let mockContractMarketState: Record<string, unknown>;
let mockRouteParams: Record<string, unknown> | undefined;
let mockOrderFormProps: Record<string, any> | null = null;
let mockBottomTabsProps: Record<string, any> | null = null;
let mockKlineChartProps: Record<string, any> | null = null;
let mockSymbolHeaderProps: Record<string, any> | null = null;
let mockMoreSheetProps: Record<string, any> | null = null;
let mockMarketSelectorProps: Record<string, any> | null = null;
let mockTpSlSheetProps: Record<string, any> | null = null;
let mockTopTabsProps: Record<string, any> | null = null;
let mockOrderBookProps: Record<string, any> | null = null;
let mockOrderConfirmProps: Record<string, any> | null = null;
let mockCloseAllConfirmProps: Record<string, any> | null = null;

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

jest.mock('../src/hooks/useContractMarketRealtime', () => ({
  useContractMarketRealtime: (...args: unknown[]) =>
    mockUseContractMarketRealtime(...args),
}));

jest.mock('../src/hooks/useContractKlineRealtime', () => ({
  useContractKlineRealtime: (...args: unknown[]) =>
    mockUseContractKlineRealtime(...args),
}));

jest.mock('../src/realtime/contractMarketRealtime', () => ({
  getContractMarketRealtimeStore: () => ({
    waitForExecutionLease: (...args: unknown[]) =>
      mockWaitForExecutionLease(...args),
  }),
}));

jest.mock('../src/hooks/usePrivateTradingRealtime', () => ({
  usePrivateTradingRealtime: () => mockPrivateRealtimeStatus,
}));

jest.mock('../src/api/contract', () => {
  const actual = jest.requireActual('../src/api/contract');
  return {
    ...actual,
    cancelContractOrder: (...args: unknown[]) =>
      mockCancelContractOrder(...args),
    closeContractSummaryOrder: (...args: unknown[]) =>
      mockCloseContractSummaryOrder(...args),
    fetchContractAccountSummary: (...args: unknown[]) =>
      mockFetchContractAccountSummary(...args),
    fetchContractKlines: (...args: unknown[]) =>
      mockFetchContractKlines(...args),
    fetchContractOrders: (...args: unknown[]) =>
      mockFetchContractOrders(...args),
    fetchContractOrdersPage: async (...args: unknown[]) => {
      const value = await mockFetchContractOrders(...args);
      if (value && !Array.isArray(value) && Array.isArray(value.items)) {
        return value;
      }
      const params = (args[0] || {}) as { page?: number; pageSize?: number };
      const items = Array.isArray(value) ? value : [];
      const page = params.page ?? 1;
      const pageSize = params.pageSize ?? 20;
      return {
        items,
        total: items.length,
        page,
        pageSize,
        hasMore: false,
        nextPage: null,
      };
    },
    fetchContractPositions: (...args: unknown[]) =>
      mockFetchContractPositions(...args),
    fetchContractSymbolRules: (...args: unknown[]) =>
      mockFetchContractSymbolRules(...args),
    fetchContractTrades: (...args: unknown[]) =>
      mockFetchContractTrades(...args),
    fetchContractTradesPage: async (...args: unknown[]) => {
      const value = await mockFetchContractTrades(...args);
      if (value && !Array.isArray(value) && Array.isArray(value.items)) {
        return value;
      }
      const items = Array.isArray(value) ? value : [];
      const pageSize = typeof args[1] === 'number' ? args[1] : 20;
      const page = typeof args[2] === 'number' ? args[2] : 1;
      return {
        items,
        total: items.length,
        page,
        pageSize,
        hasMore: false,
        nextPage: null,
      };
    },
    openContractOrder: (...args: unknown[]) => mockOpenContractOrder(...args),
    updateContractPositionTpSl: (...args: unknown[]) =>
      mockUpdateContractPositionTpSl(...args),
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

jest.mock('../src/components/contract/ContractOrderForm', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockOrderFormProps = props;
    return null;
  },
}));

jest.mock('../src/components/contract/ContractOrderConfirmModal', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockOrderConfirmProps = props;
    return null;
  },
}));

jest.mock('../src/components/contract/ContractCloseAllConfirmModal', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockCloseAllConfirmProps = props;
    return null;
  },
}));

jest.mock('../src/components/contract/ContractBottomTabs', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockBottomTabsProps = props;
    return null;
  },
}));
jest.mock('../src/components/contract/ContractMoreSheet', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockMoreSheetProps = props;
    return null;
  },
}));
jest.mock('../src/components/contract/ContractMarketSelectorSheet', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockMarketSelectorProps = props;
    return null;
  },
}));
jest.mock('../src/components/contract/ContractPositionTpSlSheet', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockTpSlSheetProps = props;
    return null;
  },
}));
jest.mock('../src/components/contract/ContractOrderBook', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockOrderBookProps = props;
    return null;
  },
}));
jest.mock('../src/components/contract/ContractSymbolHeader', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockSymbolHeaderProps = props;
    return null;
  },
}));
jest.mock('../src/components/contract/ContractTopTabs', () => ({
  __esModule: true,
  default: (props: Record<string, any>) => {
    mockTopTabsProps = props;
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

import ContractScreen from '../src/screens/contract/ContractScreen';

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
    marketView: {
      symbol: 'BTCUSDT_PERP',
      quote: {
        symbol: 'BTCUSDT_PERP',
        lastPrice: 101,
        markPrice: 100.5,
        indexPrice: 100,
        bidPrice: 100,
        askPrice: 101,
        changePercent: 0,
        pricePrecision: 2,
        executable: true,
        marketStatus: 'OPEN',
        executionBid: 100,
        executionAsk: 101,
        executionMode: 'LIVE_BBO',
        displayState: 'LIVE_TRADABLE',
        reasonCode: 'LIVE_BBO',
        snapshotAuthority: true,
      },
      depth: {
        symbol: 'BTCUSDT_PERP',
        bids: [{ price: 100, amount: 2 }],
        asks: [{ price: 101, amount: 3 }],
        pricePrecision: 2,
      },
      trades: [],
      executable: true,
      displayState: 'LIVE_TRADABLE',
      reasonCode: 'LIVE_BBO',
      snapshotAuthority: true,
      quoteFreshness: 'LIVE',
      depthFreshness: 'LIVE',
      tradesFreshness: 'RECENT',
      priceAgeMs: 100,
      executionTtlMs: 1_500,
      warnings: [],
    },
    lease: {
      executionBid: 100,
      executionAsk: 101,
      priceAgeMs: 100,
      executionTtlMs: 1_500,
      receivedAtMs: 10_000,
      expiresAtMs: 11_000,
    },
    executionRecovering: false,
    loading: false,
    error: null,
    executionGeneration: 1,
  };
}

async function renderReadyContractScreen() {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(<ContractScreen />);
    await Promise.resolve();
    await Promise.resolve();
  });
  await act(async () => {
    mockOrderFormProps?.onQuantityChange('1');
    mockOrderFormProps?.onBboPress();
  });
  return renderer!;
}

function openConfirmation() {
  act(() => {
    mockOrderFormProps?.onSubmitPress();
  });
  expect(mockOrderConfirmProps).toMatchObject({ visible: true });
  expect(mockOrderConfirmProps?.onConfirm).toBeDefined();
  return { onPress: mockOrderConfirmProps!.onConfirm };
}

async function openCloseAllConfirmation() {
  await act(async () => {
    await mockBottomTabsProps?.onCloseAllPositions();
  });
  expect(mockCloseAllConfirmProps).toMatchObject({ visible: true });
  expect(mockCloseAllConfirmProps?.onConfirm).toBeDefined();
  return { onPress: mockCloseAllConfirmProps!.onConfirm };
}

function cancelableOrder() {
  return {
    id: '41',
    orderId: 41,
    symbol: 'BTCUSDT_PERP',
    positionSide: 'LONG',
    action: 'OPEN',
    orderType: 'LIMIT',
    price: '100',
    quantity: '2',
    leverage: 10,
    marginAmount: '20',
    spreadFee: '0',
    filledQuantity: '0.5',
    status: 'OPEN',
    createdAt: null,
  };
}

function openPosition() {
  return {
    id: '7',
    symbol: 'BTCUSDT_PERP',
    side: 'LONG' as const,
    leverage: 10,
    quantity: '0.25',
    entryPrice: '100',
    markPrice: '101',
    marginAmount: '2.5',
    unrealizedPnl: '0.25',
    liquidationPrice: '90',
    takeProfitPrice: null,
    stopLossPrice: null,
    status: 'OPEN',
  };
}

function openCancelConfirmation(order = cancelableOrder()) {
  act(() => {
    mockBottomTabsProps?.onCancelOrder(order);
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

describe('ContractScreen execution confirmation lifecycle', () => {
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
    mockContractMarketState = executableMarketState();
    mockWaitForExecutionLease.mockResolvedValue(null);
    mockRouteParams = undefined;
    mockOrderFormProps = null;
    mockBottomTabsProps = null;
    mockKlineChartProps = null;
    mockSymbolHeaderProps = null;
    mockMoreSheetProps = null;
    mockMarketSelectorProps = null;
    mockTpSlSheetProps = null;
    mockTopTabsProps = null;
    mockOrderBookProps = null;
    mockOrderConfirmProps = null;
    mockCloseAllConfirmProps = null;
    mockUseContractKlineRealtime.mockReturnValue({
      items: [],
      loading: false,
      error: null,
      phase: 'live',
      source: 'REST+WS_NATIVE',
      mode: 'NATIVE',
      subscriptionReady: true,
      domainReady: true,
      gapDetected: false,
    });
    mockUseContractMarketRealtime.mockImplementation(
      () => mockContractMarketState,
    );
    jest.spyOn(Alert, 'alert').mockImplementation(jest.fn());
    mockFetchContractKlines.mockResolvedValue([]);
    mockFetchContractSymbolRules.mockResolvedValue({
      symbol: 'BTCUSDT_PERP',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      pricePrecision: 2,
      quantityPrecision: 6,
      minQuantity: 0.001,
      maxQuantity: 250,
      maxLeverage: 100,
      tpSlTriggerPriceType: 'MARK_PRICE',
    });
    mockFetchContractAccountSummary.mockResolvedValue({
      marginAsset: 'USDT',
      availableMargin: 100_000,
      usedMargin: 0,
      frozenMargin: 0,
      positionMargin: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      equity: 100_000,
    });
    mockFetchContractPositions.mockResolvedValue([]);
    mockFetchContractOrders.mockResolvedValue([]);
    mockFetchContractTrades.mockResolvedValue([]);
    mockCancelContractOrder.mockResolvedValue({
      orderId: 41,
      status: 'CANCELED',
    });
    mockOpenContractOrder.mockResolvedValue({
      orderId: 1,
      orderNo: 'C-1',
      status: 'OPEN',
      positionId: null,
    });
    mockCloseContractSummaryOrder.mockResolvedValue({
      orderIds: [71],
      status: 'FILLED',
      requestedQuantity: '0.25',
      closedQuantity: '0.25',
    });
    mockUpdateContractPositionTpSl.mockResolvedValue({
      positionId: 7,
      symbol: 'BTCUSDT_PERP',
      side: 'LONG',
      markPrice: '101',
      takeProfitPrice: '110',
      stopLossPrice: '95',
    });
  });

  it('navigates the chart action to market detail while the Kline owner is active', async () => {
    renderer = await renderReadyContractScreen();
    expect(mockUseContractKlineRealtime).toHaveBeenLastCalledWith(
      'BTCUSDT_PERP',
      '1m',
      'contract-screen-kline',
      true,
    );

    act(() => {
      mockSymbolHeaderProps?.onOpenChart();
    });
    expect(mockNavigate).toHaveBeenCalledWith('MarketDetail', {
      market: 'contract',
      symbol: 'BTCUSDT_PERP',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      displayLabel: 'BTC/USDT 永续',
      marketCategory: 'crypto',
      initialInterval: '1m',
    });
  });

  it('passes the retained Contract Klines into the detail preview', async () => {
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
    mockUseContractKlineRealtime.mockReturnValue({
      items: initialKlines,
      loading: false,
      error: null,
      phase: 'live',
      gapDetected: false,
      mode: 'NATIVE',
    });
    renderer = await renderReadyContractScreen();

    act(() => {
      mockSymbolHeaderProps?.onOpenChart();
    });

    expect(mockNavigate).toHaveBeenCalledWith(
      'MarketDetail',
      expect.objectContaining({ initialKlines }),
    );
  });

  it('keeps an authoritative closed-market status visible while execution is disabled', async () => {
    const closedState = executableMarketState();
    closedState.marketView.quote = {
      ...closedState.marketView.quote,
      executable: false,
      marketStatus: 'CLOSED',
      displayState: 'DISPLAY_ONLY',
    };
    closedState.marketView.executable = false;
    closedState.marketView.displayState = 'DISPLAY_ONLY';
    closedState.lease = null as unknown as typeof closedState.lease;
    mockContractMarketState = closedState;

    renderer = await renderReadyContractScreen();

    expect(mockSymbolHeaderProps?.marketStatus).toBe('已休市');
    expect(mockOrderFormProps?.submitDisabled).toBe(true);
  });

  it('keeps the buy action stable during a transient live lease renewal', async () => {
    renderer = await renderReadyContractScreen();

    expect(mockSymbolHeaderProps?.marketStatus).toBe('可交易');
    expect(mockSymbolHeaderProps).not.toHaveProperty('fundingRateText');
    expect(mockOrderFormProps?.submitDisabled).toBe(false);

    mockContractMarketState = {
      ...executableMarketState(),
      lease: null,
      executionRecovering: true,
      executionGeneration: 2,
    };
    await act(async () => {
      renderer?.update(<ContractScreen />);
    });

    expect(mockSymbolHeaderProps?.marketStatus).toBe('可交易');
    expect(mockOrderFormProps?.submitDisabled).toBe(false);
  });

  it('waits for a fresh execution lease before opening confirmation from a renewal gap', async () => {
    mockContractMarketState = {
      ...executableMarketState(),
      lease: null,
      executionRecovering: true,
      executionGeneration: 2,
    };
    mockWaitForExecutionLease.mockResolvedValue({
      lease: {
        executionBid: 100,
        executionAsk: 101,
        priceAgeMs: 100,
        executionTtlMs: 1_500,
        receivedAtMs: 10_000,
        expiresAtMs: 11_000,
      },
      executionGeneration: 2,
      sessionGeneration: 1,
    });
    renderer = await renderReadyContractScreen();
    await act(async () => {
      mockOrderFormProps?.onPriceChange('100');
    });
    await act(async () => {
      await mockOrderFormProps?.onSubmitPress();
    });

    expect(mockWaitForExecutionLease).toHaveBeenCalledTimes(1);
    expect(mockOrderConfirmProps).toMatchObject({visible: true});
    expect(mockOpenContractOrder).not.toHaveBeenCalled();
  });

  it('passes the complete authoritative depth to the order-book aggregator', async () => {
    const state = executableMarketState();
    const bids = Array.from({ length: 20 }, (_, index) => ({
      price: 100 - index * 0.01,
      amount: index + 1,
    }));
    const asks = Array.from({ length: 20 }, (_, index) => ({
      price: 101 + index * 0.01,
      amount: index + 1,
    }));
    mockContractMarketState = {
      ...state,
      marketView: {
        ...state.marketView,
        depth: { ...state.marketView.depth, bids, asks },
      },
    };

    renderer = await renderReadyContractScreen();

    expect(mockOrderBookProps?.bids).toEqual(bids);
    expect(mockOrderBookProps?.asks).toEqual(asks);
  });

  it('preserves the selected buy or sell side when switching open and close modes', async () => {
    renderer = await renderReadyContractScreen();
    expect(mockOrderFormProps).toMatchObject({
      actionMode: 'OPEN',
      direction: 'LONG',
    });

    act(() => {
      mockOrderFormProps?.onActionModeChange('CLOSE');
    });
    expect(mockOrderFormProps).toMatchObject({
      actionMode: 'CLOSE',
      direction: 'SHORT',
    });

    act(() => {
      mockOrderFormProps?.onActionModeChange('OPEN');
    });
    expect(mockOrderFormProps).toMatchObject({
      actionMode: 'OPEN',
      direction: 'LONG',
    });
  });

  it('opens and executes a confirmed market close from a position card action', async () => {
    const position = openPosition();
    mockFetchContractPositions.mockImplementation(async () =>
      mockCloseContractSummaryOrder.mock.calls.length > 0 ? [] : [position],
    );
    renderer = await renderReadyContractScreen();
    const formStateBeforePositionClose = {
      actionMode: mockOrderFormProps?.actionMode,
      direction: mockOrderFormProps?.direction,
      orderType: mockOrderFormProps?.orderType,
      price: mockOrderFormProps?.price,
      quantity: mockOrderFormProps?.quantity,
    };

    act(() => {
      mockBottomTabsProps?.onClosePosition(position);
    });

    expect({
      actionMode: mockOrderFormProps?.actionMode,
      direction: mockOrderFormProps?.direction,
      orderType: mockOrderFormProps?.orderType,
      price: mockOrderFormProps?.price,
      quantity: mockOrderFormProps?.quantity,
    }).toEqual(formStateBeforePositionClose);
    expect(mockOrderConfirmProps).toMatchObject({
      visible: true,
      quantityText: '0.25',
      baseAsset: 'BTC',
      actionMode: 'CLOSE',
      direction: 'LONG',
      orderType: 'MARKET',
      referencePrice: 100,
    });
    expect(
      (Alert.alert as jest.MockedFunction<typeof Alert.alert>).mock.calls.some(
        call => call[0] === '已填入平仓信息',
      ),
    ).toBe(false);

    const repricedState = executableMarketState();
    repricedState.marketView.quote.lastPrice = 106;
    repricedState.marketView.quote.askPrice = 106;
    repricedState.marketView.quote.bidPrice = 105;
    repricedState.marketView.quote.executionAsk = 106;
    repricedState.marketView.quote.executionBid = 105;
    repricedState.lease.executionAsk = 106;
    repricedState.lease.executionBid = 105;
    repricedState.executionGeneration = 2;
    mockContractMarketState = repricedState;
    await act(async () => {
      renderer?.update(<ContractScreen />);
    });
    expect(mockOrderConfirmProps).toMatchObject({
      visible: true,
      quantityText: '0.25',
      referencePrice: 105,
    });

    const confirmButton = { onPress: mockOrderConfirmProps?.onConfirm };
    await act(async () => {
      await confirmButton?.onPress?.();
    });

    expect(mockCloseContractSummaryOrder).toHaveBeenCalledTimes(1);
    expect(mockCloseContractSummaryOrder).toHaveBeenCalledWith({
      symbol: 'BTCUSDT_PERP',
      side: 'LONG',
      order_type: 'MARKET',
      client_order_id: expect.stringMatching(/^[a-z0-9][a-z0-9._-]{0,63}$/),
      price: undefined,
      quantity: '0.25',
    });
    expect(mockBottomTabsProps?.positions).toEqual([]);
  });

  it('uses the latest authoritative quantity when confirming a position-card close', async () => {
    const position = openPosition();
    mockFetchContractPositions.mockResolvedValue([position]);
    renderer = await renderReadyContractScreen();
    act(() => {
      mockBottomTabsProps?.onClosePosition(position);
    });
    expect(mockOrderConfirmProps).toMatchObject({
      visible: true,
      quantityText: '0.25',
    });
    mockFetchContractPositions.mockImplementation(async () =>
      mockCloseContractSummaryOrder.mock.calls.length === 0
        ? [{ ...position, quantity: '0.2' }]
        : [],
    );

    await act(async () => {
      await mockOrderConfirmProps?.onConfirm();
    });

    expect(mockCloseContractSummaryOrder).toHaveBeenCalledTimes(1);
    expect(mockCloseContractSummaryOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        side: 'LONG',
        order_type: 'MARKET',
        quantity: '0.2',
      }),
    );
  });

  it('allows a live market tick while a position-card close intent is persisted', async () => {
    const position = openPosition();
    mockFetchContractPositions.mockImplementation(async () =>
      mockCloseContractSummaryOrder.mock.calls.length === 0 ? [position] : [],
    );
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
    renderer = await renderReadyContractScreen();
    act(() => {
      mockBottomTabsProps?.onClosePosition(position);
    });

    await act(async () => {
      mockOrderConfirmProps?.onConfirm();
      await Promise.resolve();
    });
    const repricedState = executableMarketState();
    repricedState.marketView.quote.lastPrice = 106;
    repricedState.marketView.quote.askPrice = 106;
    repricedState.marketView.quote.bidPrice = 105;
    repricedState.marketView.quote.executionAsk = 106;
    repricedState.marketView.quote.executionBid = 105;
    repricedState.lease.executionAsk = 106;
    repricedState.lease.executionBid = 105;
    repricedState.executionGeneration = 2;
    mockContractMarketState = repricedState;
    await act(async () => {
      renderer?.update(<ContractScreen />);
      releaseStorage();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockCloseContractSummaryOrder).toHaveBeenCalledTimes(1);
    expect(
      (Alert.alert as jest.MockedFunction<typeof Alert.alert>).mock.calls.some(
        call => call[0] === '未发送订单',
      ),
    ).toBe(false);
  });

  it('bypasses the position-close modal after do-not-show is enabled', async () => {
    const position = openPosition();
    await AsyncStorage.setItem(CONTRACT_TRADE_CONFIRM_HIDDEN_STORAGE_KEY, '1');
    mockFetchContractPositions.mockImplementation(async () =>
      mockCloseContractSummaryOrder.mock.calls.length === 0 ? [position] : [],
    );
    renderer = await renderReadyContractScreen();

    await act(async () => {
      await mockBottomTabsProps?.onClosePosition(position);
    });

    expect(mockOrderConfirmProps?.visible).toBe(false);
    expect(mockCloseContractSummaryOrder).toHaveBeenCalledTimes(1);
  });

  it('confirms and closes every current-symbol position with protected side intents', async () => {
    const longPosition = openPosition();
    const shortPosition = {
      ...openPosition(),
      id: '8',
      side: 'SHORT' as const,
      quantity: '0.4',
    };
    mockFetchContractPositions.mockImplementation(async () => {
      if (mockCloseContractSummaryOrder.mock.calls.length === 0) {
        return [longPosition, shortPosition];
      }
      if (mockCloseContractSummaryOrder.mock.calls.length === 1) {
        return [shortPosition];
      }
      return [];
    });
    mockCloseContractSummaryOrder.mockImplementation(async payload => ({
      orderIds: [70 + mockCloseContractSummaryOrder.mock.calls.length],
      status: 'FILLED',
      requestedQuantity: payload.quantity,
      closedQuantity: payload.quantity,
    }));
    renderer = await renderReadyContractScreen();

    const confirmButton = await openCloseAllConfirmation();
    expect(mockCloseAllConfirmProps?.targets).toEqual([
      { side: 'LONG', quantity: '0.25', referencePrice: 100 },
      { side: 'SHORT', quantity: '0.4', referencePrice: 101 },
    ]);

    await act(async () => {
      await confirmButton?.onPress?.();
    });

    expect(mockCloseContractSummaryOrder).toHaveBeenCalledTimes(2);
    expect(mockCloseContractSummaryOrder).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        symbol: 'BTCUSDT_PERP',
        side: 'LONG',
        order_type: 'MARKET',
        quantity: '0.25',
        client_order_id: expect.stringMatching(/^[a-z0-9][a-z0-9._-]{0,63}$/),
      }),
    );
    expect(mockCloseContractSummaryOrder).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        symbol: 'BTCUSDT_PERP',
        side: 'SHORT',
        order_type: 'MARKET',
        quantity: '0.4',
        client_order_id: expect.stringMatching(/^[a-z0-9][a-z0-9._-]{0,63}$/),
      }),
    );
    expect(
      mockCloseContractSummaryOrder.mock.calls[0][0].client_order_id,
    ).not.toBe(mockCloseContractSummaryOrder.mock.calls[1][0].client_order_id);
    expect(
      await loadPendingTradeIntent('contract', '7', 'BTCUSDT_PERP'),
    ).toBeNull();
    expect(mockBottomTabsProps?.positions).toEqual([]);
  });

  it('refreshes once at confirmation and closes the latest authoritative quantity', async () => {
    const position = openPosition();
    mockFetchContractPositions.mockResolvedValue([position]);
    renderer = await renderReadyContractScreen();

    const confirmButton = await openCloseAllConfirmation();
    mockFetchContractPositions.mockImplementation(async () =>
      mockCloseContractSummaryOrder.mock.calls.length === 0
        ? [{ ...position, quantity: '0.2' }]
        : [],
    );

    await act(async () => {
      await confirmButton?.onPress?.();
    });

    expect(mockCloseContractSummaryOrder).toHaveBeenCalledTimes(1);
    expect(mockCloseContractSummaryOrder).toHaveBeenCalledWith(
      expect.objectContaining({ side: 'LONG', quantity: '0.2' }),
    );
    expect(
      (Alert.alert as jest.MockedFunction<typeof Alert.alert>).mock.calls.some(
        call => call[1] === '确认期间仓位数量已经变化，未继续提交，请重新确认',
      ),
    ).toBe(false);
  });

  it('keeps close-all reference prices live while the confirmation is open', async () => {
    mockFetchContractPositions.mockResolvedValue([openPosition()]);
    renderer = await renderReadyContractScreen();
    await openCloseAllConfirmation();
    expect(mockCloseAllConfirmProps?.targets).toEqual([
      { side: 'LONG', quantity: '0.25', referencePrice: 100 },
    ]);

    const repricedState = executableMarketState();
    repricedState.marketView.quote.lastPrice = 106;
    repricedState.marketView.quote.askPrice = 106;
    repricedState.marketView.quote.bidPrice = 105;
    repricedState.marketView.quote.executionAsk = 106;
    repricedState.marketView.quote.executionBid = 105;
    repricedState.lease.executionAsk = 106;
    repricedState.lease.executionBid = 105;
    repricedState.executionGeneration = 2;
    mockContractMarketState = repricedState;
    await act(async () => {
      renderer?.update(<ContractScreen />);
    });

    expect(mockCloseAllConfirmProps?.targets).toEqual([
      { side: 'LONG', quantity: '0.25', referencePrice: 105 },
    ]);
  });

  it('does not abort close-all when a normal market tick arrives during intent persistence', async () => {
    const position = openPosition();
    mockFetchContractPositions.mockImplementation(async () =>
      mockCloseContractSummaryOrder.mock.calls.length === 0 ? [position] : [],
    );
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
    renderer = await renderReadyContractScreen();
    const confirmButton = await openCloseAllConfirmation();

    await act(async () => {
      confirmButton.onPress?.();
      await Promise.resolve();
    });
    const repricedState = executableMarketState();
    repricedState.marketView.quote.lastPrice = 106;
    repricedState.marketView.quote.askPrice = 106;
    repricedState.marketView.quote.bidPrice = 105;
    repricedState.marketView.quote.executionAsk = 106;
    repricedState.marketView.quote.executionBid = 105;
    repricedState.lease.executionAsk = 106;
    repricedState.lease.executionBid = 105;
    repricedState.executionGeneration = 2;
    mockContractMarketState = repricedState;
    await act(async () => {
      renderer?.update(<ContractScreen />);
      releaseStorage();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockCloseContractSummaryOrder).toHaveBeenCalledTimes(1);
    expect(
      (Alert.alert as jest.MockedFunction<typeof Alert.alert>).mock.calls.some(
        call => call[0] === '未发送订单',
      ),
    ).toBe(false);
  });

  it('persists the close-all do-not-show choice', async () => {
    mockFetchContractPositions.mockResolvedValue([openPosition()]);
    renderer = await renderReadyContractScreen();
    await openCloseAllConfirmation();

    await act(async () => {
      mockCloseAllConfirmProps?.onSuppressChange(true);
      await Promise.resolve();
    });

    expect(
      await AsyncStorage.getItem(CONTRACT_CLOSE_ALL_CONFIRM_HIDDEN_STORAGE_KEY),
    ).toBe('1');
  });

  it('keeps close-all protected after an ambiguous transport failure', async () => {
    const position = openPosition();
    mockFetchContractPositions.mockResolvedValue([position]);
    mockCloseContractSummaryOrder.mockRejectedValue(
      new ApiClientError('请求超时，请稍后重试', 'TIMEOUT'),
    );
    renderer = await renderReadyContractScreen();

    const confirmButton = await openCloseAllConfirmation();
    await act(async () => {
      await confirmButton?.onPress?.();
    });

    expect(mockCloseContractSummaryOrder).toHaveBeenCalledTimes(1);
    const pending = await loadPendingTradeIntent(
      'contract',
      '7',
      'BTCUSDT_PERP',
    );
    expect(pending).toMatchObject({
      version: 2,
      payload: {
        action: 'CLOSE',
        symbol: 'BTCUSDT_PERP',
        positionSide: 'LONG',
        orderType: 'MARKET',
        quantity: '0.25',
      },
    });
    expect(mockBottomTabsProps?.closeAllPositionsDisabled).toBe(true);
  });

  it('keeps close-all protected when a market close is not fully filled', async () => {
    const position = openPosition();
    mockFetchContractPositions.mockResolvedValue([position]);
    mockCloseContractSummaryOrder.mockResolvedValue({
      orderIds: [71],
      status: 'PARTIALLY_FILLED',
      requestedQuantity: '0.25',
      closedQuantity: '0.1',
    });
    renderer = await renderReadyContractScreen();

    const confirmButton = await openCloseAllConfirmation();
    await act(async () => {
      await confirmButton?.onPress?.();
    });

    expect(mockCloseContractSummaryOrder).toHaveBeenCalledTimes(1);
    await expect(
      loadPendingTradeIntent('contract', '7', 'BTCUSDT_PERP'),
    ).resolves.toMatchObject({
      payload: { action: 'CLOSE', quantity: '0.25' },
    });
    expect(
      (Alert.alert as jest.MockedFunction<typeof Alert.alert>).mock.calls.some(
        call =>
          typeof call[1] === 'string' &&
          call[1].includes('仅成交 0.1/0.25 BTC'),
      ),
    ).toBe(true);
  });

  it('refreshes an expired private snapshot before preparing a position close', async () => {
    const position = openPosition();
    mockFetchContractPositions.mockResolvedValue([position]);
    renderer = await renderReadyContractScreen();
    const accountCallsBeforeClose =
      mockFetchContractAccountSummary.mock.calls.length;
    jest.setSystemTime(40_001);
    const liveExecutionState = executableMarketState();
    mockContractMarketState = {
      ...liveExecutionState,
      lease: {
        ...liveExecutionState.lease,
        receivedAtMs: 40_001,
        expiresAtMs: 100_000,
      },
      executionGeneration: 2,
    };
    mockFetchContractPositions.mockResolvedValue([
      { ...position, quantity: '0.2' },
    ]);
    await act(async () => {
      renderer?.update(<ContractScreen />);
    });

    await act(async () => {
      await mockBottomTabsProps?.onClosePosition(position);
      await Promise.resolve();
    });

    expect(mockFetchContractAccountSummary.mock.calls.length).toBeGreaterThan(
      accountCallsBeforeClose,
    );
    expect(
      (Alert.alert as jest.MockedFunction<typeof Alert.alert>).mock.calls.some(
        call => call[1] === '合约账户与持仓数据未就绪或已过期，请刷新后重试',
      ),
    ).toBe(false);
    expect(mockOrderConfirmProps).toMatchObject({
      visible: true,
      quantityText: '0.2',
      baseAsset: 'BTC',
    });
  });

  it('updates TP/SL through the real position mutation wrapper', async () => {
    const position = openPosition();
    mockFetchContractPositions.mockResolvedValue([position]);
    renderer = await renderReadyContractScreen();

    act(() => {
      mockBottomTabsProps?.onEditPositionTpSl(position);
    });
    expect(mockTpSlSheetProps).toMatchObject({
      position: {
        ...position,
        markPrice: '100.5',
        unrealizedPnl: '0.125',
      },
      pricePrecision: 2,
      referencePrice: 100.5,
      visible: true,
      takeProfitPrice: '',
      stopLossPrice: '',
    });

    const nextMarketState = executableMarketState();
    nextMarketState.marketView.quote.markPrice = 102.75;
    nextMarketState.lease = null as unknown as typeof nextMarketState.lease;
    mockContractMarketState = nextMarketState;
    await act(async () => {
      renderer?.update(<ContractScreen />);
    });
    expect(mockTpSlSheetProps?.referencePrice).toBe(102.75);

    act(() => {
      mockTpSlSheetProps?.onTakeProfitPriceChange('110');
      mockTpSlSheetProps?.onStopLossPriceChange('95');
    });
    await act(async () => {
      await mockTpSlSheetProps?.onSave();
    });

    expect(mockUpdateContractPositionTpSl).toHaveBeenCalledWith(position, {
      take_profit_price: '110',
      stop_loss_price: '95',
    });
    expect(mockTpSlSheetProps?.visible).toBe(false);
  });

  it('keeps the TP/SL latest-price reference synchronized with the chart price line', async () => {
    const position = openPosition();
    mockFetchContractPositions.mockResolvedValue([position]);
    mockFetchContractSymbolRules.mockResolvedValue({
      symbol: 'BTCUSDT_PERP',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      pricePrecision: 2,
      quantityPrecision: 6,
      minQuantity: 0.001,
      maxQuantity: 250,
      maxLeverage: 100,
      tpSlTriggerPriceType: 'LAST_PRICE',
    });
    renderer = await renderReadyContractScreen();

    act(() => {
      mockBottomTabsProps?.onEditPositionTpSl(position);
    });
    expect(mockKlineChartProps?.currentPrice).toBe(101);
    expect(mockTpSlSheetProps).toMatchObject({
      referencePrice: 101,
      referencePriceType: 'LAST_PRICE',
      visible: true,
    });

    const nextMarketState = executableMarketState();
    nextMarketState.marketView.quote.lastPrice = 103.25;
    nextMarketState.marketView.quote.markPrice = 102.75;
    mockContractMarketState = nextMarketState;
    await act(async () => {
      renderer?.update(<ContractScreen />);
    });

    expect(mockKlineChartProps?.currentPrice).toBe(103.25);
    expect(mockTpSlSheetProps?.referencePrice).toBe(103.25);
  });

  it('offers an explicit retry when contract rules fail to load', async () => {
    mockFetchContractSymbolRules.mockRejectedValueOnce(
      new Error('合约交易规则响应格式无效'),
    );

    renderer = await renderReadyContractScreen();
    const accessibilityLabel = '合约交易规则响应格式无效，点击重试';
    const retryButton = renderer.root.findByProps({ accessibilityLabel });

    await act(async () => {
      await retryButton.props.onPress();
      await Promise.resolve();
    });

    expect(mockFetchContractSymbolRules).toHaveBeenCalledTimes(2);
    expect(renderer.root.findAllByProps({ accessibilityLabel })).toHaveLength(
      0,
    );
  });

  it('does not show private synchronization guards to logged-out users', async () => {
    mockIsLoggedIn = false;
    renderer = await renderReadyContractScreen();

    expect(mockOrderFormProps?.feedbackText).toBe('');
    expect(mockOrderFormProps?.isLoggedIn).toBe(false);
    expect(mockOrderFormProps?.pendingIntentReviewVisible).toBe(false);
  });

  it('keeps initial private synchronization neutral while submission stays locked', () => {
    mockFetchContractAccountSummary.mockReturnValue(
      new Promise(() => undefined),
    );

    act(() => {
      renderer = ReactTestRenderer.create(<ContractScreen />);
    });

    expect(mockOrderFormProps?.submitDisabled).toBe(true);
    expect(mockOrderFormProps?.feedbackText).toBe('');
    expect(mockOrderFormProps?.feedbackTone).not.toBe('error');
  });

  it('keeps limit forms isolated from quote renders while market forms receive the execution price', async () => {
    await act(async () => {
      renderer = ReactTestRenderer.create(<ContractScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOrderFormProps?.orderType).toBe('LIMIT');
    expect(mockOrderFormProps?.price).toBe('');
    expect(mockOrderFormProps?.lastPrice).toBeNull();
    expect(mockOrderFormProps?.markPrice).toBeNull();

    await act(async () => {
      mockOrderFormProps?.onBboPress();
    });

    expect(mockOrderFormProps?.price).toBe('101');

    await act(async () => {
      mockOrderFormProps?.onOrderTypeChange('MARKET');
    });

    expect(mockOrderFormProps?.orderType).toBe('MARKET');
    expect(mockOrderFormProps?.lastPrice).toBe(101);
    expect(mockOrderFormProps?.markPrice).toBe(101);
  });

  it('replays a BBO request after a renewal gap and resizes an active percent draft', async () => {
    mockContractMarketState = {
      ...executableMarketState(),
      lease: null,
      executionRecovering: true,
      executionGeneration: 2,
    };
    await act(async () => {
      renderer = ReactTestRenderer.create(<ContractScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      mockOrderFormProps?.onPriceChange('1');
    });
    await act(async () => {
      mockOrderFormProps?.onPercentPress(25);
    });
    expect(mockOrderFormProps?.price).toBe('1');
    expect(mockOrderFormProps?.quantity).toBe('25000');
    expect(mockOrderFormProps?.selectedPercent).toBe(25);

    await act(async () => {
      mockOrderFormProps?.onBboPress();
    });
    expect(mockOrderFormProps?.price).toBe('1');
    expect(mockOrderFormProps?.feedbackText).toBe('实时重连中 · 保留最近数据');

    mockContractMarketState = {
      ...executableMarketState(),
      executionGeneration: 3,
    };
    await act(async () => {
      renderer?.update(<ContractScreen />);
      await Promise.resolve();
    });

    expect(mockOrderFormProps?.price).toBe('101');
    expect(mockOrderFormProps?.quantity).toBe('247.524752');
    expect(mockOrderFormProps?.selectedPercent).toBe(25);
    expect(mockOrderFormProps?.feedbackText).toBe('');
  });

  it('cancels a queued BBO fill after a manual price edit', async () => {
    mockContractMarketState = {
      ...executableMarketState(),
      lease: null,
      executionRecovering: true,
      executionGeneration: 2,
    };
    await act(async () => {
      renderer = ReactTestRenderer.create(<ContractScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      mockOrderFormProps?.onPriceChange('1');
      mockOrderFormProps?.onBboPress();
    });
    await act(async () => {
      mockOrderFormProps?.onPriceChange('2');
    });

    mockContractMarketState = {
      ...executableMarketState(),
      executionGeneration: 3,
    };
    await act(async () => {
      renderer?.update(<ContractScreen />);
      await Promise.resolve();
    });

    expect(mockOrderFormProps?.price).toBe('2');
  });

  it('stops percent resizing after the user manually edits quantity', async () => {
    renderer = await renderReadyContractScreen();

    await act(async () => {
      mockOrderFormProps?.onPercentPress(25);
    });
    expect(mockOrderFormProps?.quantity).toBe('247.524752');
    expect(mockOrderFormProps?.selectedPercent).toBe(25);

    await act(async () => {
      mockOrderFormProps?.onQuantityChange('3');
      mockOrderFormProps?.onPriceChange('202');
    });

    expect(mockOrderFormProps?.quantity).toBe('3');
    expect(mockOrderFormProps?.selectedPercent).toBeNull();
  });

  it('shows a nonblocking fallback notice when private realtime is reconnecting', async () => {
    mockPrivateRealtimeStatus = 'reconnecting';
    renderer = await renderReadyContractScreen();

    expect(mockSymbolHeaderProps?.marketStatus).toBe(
      '订单实时连接恢复中，页面仍会定时同步',
    );
    expect(mockOrderFormProps?.submitDisabled).toBe(false);
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
    renderer = await renderReadyContractScreen();
    const confirmButton = openConfirmation();

    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockOpenContractOrder).toHaveBeenCalledTimes(1);
    expect(mockOpenContractOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        client_order_id: expect.stringMatching(/^[a-z0-9][a-z0-9._-]{0,63}$/),
      }),
    );
  });

  it('keeps the market confirmation reference live while the modal is open', async () => {
    renderer = await renderReadyContractScreen();
    act(() => {
      mockOrderFormProps?.onOrderTypeChange('MARKET');
    });
    openConfirmation();
    expect(mockOrderConfirmProps).toMatchObject({
      visible: true,
      orderType: 'MARKET',
      quantity: 1,
      referencePrice: 101,
    });

    const repricedState = executableMarketState();
    repricedState.marketView.quote.lastPrice = 105;
    repricedState.marketView.quote.askPrice = 105;
    repricedState.marketView.quote.bidPrice = 104;
    repricedState.marketView.quote.executionAsk = 105;
    repricedState.marketView.quote.executionBid = 104;
    repricedState.lease.executionAsk = 105;
    repricedState.lease.executionBid = 104;
    repricedState.executionGeneration = 2;
    mockContractMarketState = repricedState;
    await act(async () => {
      renderer?.update(<ContractScreen />);
    });

    expect(mockOrderConfirmProps).toMatchObject({
      visible: true,
      quantity: 1,
      referencePrice: 105,
    });
  });

  it('allows a live market tick while the protected intent is being persisted', async () => {
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
    renderer = await renderReadyContractScreen();
    act(() => {
      mockOrderFormProps?.onOrderTypeChange('MARKET');
    });
    const confirmButton = openConfirmation();

    await act(async () => {
      confirmButton.onPress?.();
      await Promise.resolve();
    });
    const repricedState = executableMarketState();
    repricedState.marketView.quote.lastPrice = 106;
    repricedState.marketView.quote.askPrice = 106;
    repricedState.marketView.quote.bidPrice = 105;
    repricedState.marketView.quote.executionAsk = 106;
    repricedState.marketView.quote.executionBid = 105;
    repricedState.lease.executionAsk = 106;
    repricedState.lease.executionBid = 105;
    repricedState.executionGeneration = 2;
    mockContractMarketState = repricedState;
    await act(async () => {
      renderer?.update(<ContractScreen />);
      releaseStorage();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOpenContractOrder).toHaveBeenCalledTimes(1);
    expect(mockOpenContractOrder).toHaveBeenCalledWith(
      expect.objectContaining({ order_type: 'MARKET', price: undefined }),
    );
    expect(
      (Alert.alert as jest.MockedFunction<typeof Alert.alert>).mock.calls.some(
        call => call[0] === '未发送订单',
      ),
    ).toBe(false);
  });

  it('persists the do-not-show choice and bypasses later confirmations', async () => {
    renderer = await renderReadyContractScreen();
    openConfirmation();

    await act(async () => {
      mockOrderConfirmProps?.onSuppressChange(true);
      await Promise.resolve();
    });
    expect(
      await AsyncStorage.getItem(CONTRACT_TRADE_CONFIRM_HIDDEN_STORAGE_KEY),
    ).toBe('1');
    act(() => {
      mockOrderConfirmProps?.onCancel();
    });

    await act(async () => {
      mockOrderFormProps?.onSubmitPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOrderConfirmProps?.visible).toBe(false);
    expect(mockOpenContractOrder).toHaveBeenCalledTimes(1);
  });

  it('rejects a real contract open before confirmation when quantity is below the symbol minimum', async () => {
    mockFetchContractSymbolRules.mockResolvedValue({
      symbol: 'BTCUSDT_PERP',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      pricePrecision: 2,
      quantityPrecision: 6,
      minQuantity: 2,
      maxQuantity: 250,
      maxLeverage: 100,
      tpSlTriggerPriceType: 'MARK_PRICE',
    });
    renderer = await renderReadyContractScreen();

    act(() => {
      mockOrderFormProps?.onSubmitPress();
    });

    expect(Alert.alert).toHaveBeenCalledWith(
      '无法提交',
      expect.stringContaining('开仓数量不得低于 2 BTC'),
    );
    expect(mockOpenContractOrder).not.toHaveBeenCalled();
  });

  it('uses the current symbol leverage rule, clamps input and submits the selected value', async () => {
    mockFetchContractSymbolRules.mockResolvedValue({
      symbol: 'BTCUSDT_PERP',
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      pricePrecision: 2,
      quantityPrecision: 6,
      minQuantity: 0.001,
      maxQuantity: 250,
      maxLeverage: 3,
      tpSlTriggerPriceType: 'MARK_PRICE',
    });
    renderer = await renderReadyContractScreen();

    expect(mockOrderFormProps?.leverage).toBe(1);
    expect(mockOrderFormProps?.maxLeverage).toBe(3);

    act(() => {
      mockOrderFormProps?.onLeverageChange(2);
    });
    expect(mockOrderFormProps?.leverage).toBe(2);

    act(() => {
      mockOrderFormProps?.onLeverageChange(99);
    });
    expect(mockOrderFormProps?.leverage).toBe(3);

    const confirmButton = openConfirmation();
    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockOpenContractOrder).toHaveBeenCalledWith(
      expect.objectContaining({ leverage: 3 }),
    );
  });

  it('surfaces a private response contract failure in the account tabs', async () => {
    mockFetchContractAccountSummary.mockRejectedValue(
      new Error('合约账户响应格式无效，请刷新后重试'),
    );

    renderer = await renderReadyContractScreen();

    expect(mockBottomTabsProps?.error).toBe(
      '合约账户响应格式无效，请刷新后重试',
    );
    expect(mockOrderFormProps?.submitDisabled).toBe(true);
  });

  it('keeps critical account authority usable when history or fills fail', async () => {
    mockFetchContractTrades.mockRejectedValue(
      new Error('合约成交历史暂不可用'),
    );

    renderer = await renderReadyContractScreen();

    expect(mockOrderFormProps?.submitDisabled).toBe(false);
    expect(mockBottomTabsProps?.activeTab).toBe('positions');
    expect(mockBottomTabsProps?.error).toBeNull();

    act(() => {
      mockBottomTabsProps?.onChange('fills');
    });
    expect(mockBottomTabsProps?.activeTab).toBe('fills');
    expect(mockBottomTabsProps?.error).toBe('合约成交历史暂不可用');
  });

  it('forces a private refresh after returning to the active lifecycle', async () => {
    renderer = await renderReadyContractScreen();
    let resolveRefresh: ((value: unknown) => void) | undefined;
    mockFetchContractAccountSummary.mockReturnValueOnce(
      new Promise(resolve => {
        resolveRefresh = resolve;
      }),
    );

    mockMarketScreenActive = false;
    await act(async () => {
      renderer?.update(<ContractScreen />);
      await Promise.resolve();
    });
    mockMarketScreenActive = true;
    await act(async () => {
      renderer?.update(<ContractScreen />);
      await Promise.resolve();
    });

    expect(mockFetchContractAccountSummary).toHaveBeenCalledTimes(2);
    expect(mockOrderFormProps?.submitDisabled).toBe(true);

    await act(async () => {
      resolveRefresh?.({
        marginAsset: 'USDT',
        availableMargin: 100_000,
        usedMargin: 0,
        frozenMargin: 0,
        positionMargin: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        equity: 100_000,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOrderFormProps?.submitDisabled).toBe(false);
  });

  it('keeps fresh private authority usable during proactive refresh and fails closed at expiry', async () => {
    renderer = await renderReadyContractScreen();
    const longLeaseState = executableMarketState();
    mockContractMarketState = {
      ...longLeaseState,
      lease: {
        ...(longLeaseState.lease as Record<string, unknown>),
        expiresAtMs: 100_000,
      },
    };
    await act(async () => {
      renderer?.update(<ContractScreen />);
    });
    let resolveRefresh: ((value: unknown) => void) | undefined;
    mockFetchContractAccountSummary.mockReturnValueOnce(
      new Promise(resolve => {
        resolveRefresh = resolve;
      }),
    );

    await act(async () => {
      jest.advanceTimersByTime(25_000);
      await Promise.resolve();
    });

    expect(mockFetchContractAccountSummary).toHaveBeenCalledTimes(2);
    expect(mockFetchContractTrades).toHaveBeenCalledTimes(2);
    expect(mockOrderFormProps?.submitDisabled).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
    });

    expect(mockOrderFormProps?.submitDisabled).toBe(true);

    await act(async () => {
      resolveRefresh?.({
        marginAsset: 'USDT',
        availableMargin: 100_000,
        usedMargin: 0,
        frozenMargin: 0,
        positionMargin: 0,
        realizedPnl: 0,
        unrealizedPnl: 0,
        equity: 100_000,
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOrderFormProps?.submitDisabled).toBe(false);
  });

  it('does not flicker the submit gate on a failed background refresh before the snapshot really expires', async () => {
    renderer = await renderReadyContractScreen();
    const longLeaseState = executableMarketState();
    mockContractMarketState = {
      ...longLeaseState,
      lease: {
        ...(longLeaseState.lease as Record<string, unknown>),
        expiresAtMs: 100_000,
      },
    };
    await act(async () => {
      renderer?.update(<ContractScreen />);
    });
    mockFetchContractAccountSummary.mockRejectedValue(
      new Error('temporary private refresh failure'),
    );

    await act(async () => {
      jest.advanceTimersByTime(20_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockFetchContractAccountSummary).toHaveBeenCalledTimes(2);
    expect(mockOrderFormProps?.submitDisabled).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockFetchContractAccountSummary).toHaveBeenCalledTimes(3);
    expect(mockOrderFormProps?.submitDisabled).toBe(false);

    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockOrderFormProps?.submitDisabled).toBe(true);
  });

  it('keeps the quantity and reports failure when the open response cannot be verified', async () => {
    mockOpenContractOrder.mockRejectedValue(
      new Error('合约下单响应缺少有效订单标识或状态'),
    );
    renderer = await renderReadyContractScreen();
    const confirmButton = openConfirmation();

    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockOrderFormProps?.quantity).toBe('1');
    expect(Alert.alert).toHaveBeenCalledWith(
      '提交失败',
      '合约下单响应缺少有效订单标识或状态',
    );
    expect(
      (Alert.alert as jest.MockedFunction<typeof Alert.alert>).mock.calls.some(
        call => call[0] === '订单已提交',
      ),
    ).toBe(false);
  });

  it('locks the contract symbol when a submitted order times out with an unknown result', async () => {
    mockOpenContractOrder.mockRejectedValue(
      new ApiClientError('请求超时，请稍后重试', 'TIMEOUT'),
    );
    renderer = await renderReadyContractScreen();
    const confirmButton = openConfirmation();

    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockOpenContractOrder).toHaveBeenCalledTimes(1);
    expect(mockOrderFormProps?.quantity).toBe('1');
    expect(mockOrderFormProps?.submitDisabled).toBe(true);
    expect(Alert.alert).toHaveBeenCalledWith(
      '订单结果待确认',
      expect.stringContaining('当前交易对已开启交易保护'),
    );

    act(() => {
      mockOrderFormProps?.onSubmitPress();
    });
    expect(mockOpenContractOrder).toHaveBeenCalledTimes(1);
    expect(Alert.alert).toHaveBeenCalledWith(
      '无法提交',
      expect.stringContaining('结果待确认'),
    );
  });

  it('replays an ambiguous V2 contract intent with the same client id', async () => {
    let activeReads = 0;
    mockFetchContractOrders.mockImplementation(
      ({ status }: { status?: string }) => {
        if (status !== 'ACTIVE') return Promise.resolve([]);
        activeReads += 1;
        if (activeReads === 1) return Promise.resolve([]);
        return Promise.resolve([
          {
            ...cancelableOrder(),
            id: '51',
            orderId: 51,
            price: '100.5',
            quantity: '1',
            leverage: 1,
            filledQuantity: '0',
            createdAt: new Date(11_000).toISOString(),
          },
        ]);
      },
    );
    mockOpenContractOrder.mockRejectedValue(
      new ApiClientError(
        '合约下单响应缺少有效订单标识或状态',
        'INVALID_CONTRACT_ORDER_RESPONSE',
      ),
    );
    renderer = await renderReadyContractScreen();
    const confirmButton = openConfirmation();

    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockOrderFormProps?.submitDisabled).toBe(true);
    expect(mockOrderFormProps?.pendingIntentReviewVisible).toBe(true);
    expect(mockOrderFormProps?.quantity).toBe('1');
    expect(Alert.alert).toHaveBeenCalledWith(
      '订单结果待确认',
      expect.stringContaining('当前交易对已开启交易保护'),
    );

    const originalClientOrderId =
      mockOpenContractOrder.mock.calls[0]?.[0]?.client_order_id;
    mockOpenContractOrder.mockResolvedValue({
      orderId: 52,
      orderNo: 'C-52',
      status: 'OPEN',
      positionId: 9,
    });
    await act(async () => {
      await mockOrderFormProps?.onPendingIntentReviewPress();
    });
    const reviewCall = (
      Alert.alert as jest.MockedFunction<typeof Alert.alert>
    ).mock.calls.find(call => call[0] === '重试原订单');
    const confirmButtonAfterReview = reviewCall?.[2]?.[1];
    await act(async () => {
      await confirmButtonAfterReview?.onPress?.();
    });

    expect(mockOpenContractOrder).toHaveBeenCalledTimes(2);
    expect(mockOpenContractOrder.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({ client_order_id: originalClientOrderId }),
    );
    expect(mockOrderFormProps?.pendingIntentReviewVisible).toBe(false);
    expect(mockOrderFormProps?.quantity).toBe('');
  });

  it('keeps a corrupt contract lock when server authority cannot confirm completion', async () => {
    const storageKey =
      '@exchange-mobile/pending-trade-intent/v1:contract:7:BTCUSDT_PERP';
    const raw =
      '{"version":2,"clientOrderId":"m-corrupt-contract-id","payload":';
    await AsyncStorage.setItem(storageKey, raw);
    resetPendingTradeIntentMemoryForTests();

    renderer = await renderReadyContractScreen();
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
      '查询原订单结果',
      expect.stringContaining('只有确认订单已完成'),
      expect.any(Array),
    );
    const authorityPrompt = (
      Alert.alert as jest.MockedFunction<typeof Alert.alert>
    ).mock.calls.find(call => call[0] === '查询原订单结果');
    mockFetchTradeIdempotencyStatus.mockResolvedValueOnce({
      market: 'contract',
      clientOrderId: 'm-corrupt-contract-id',
      status: 'PENDING',
      operation: 'CONTRACT_OPEN',
      result: null,
      resultSymbol: null,
      createdAt: '2026-08-02T01:02:03Z',
      completedAt: null,
    });
    await act(async () => {
      await authorityPrompt?.[2]?.[1]?.onPress?.();
    });
    expect(Alert.alert).toHaveBeenCalledWith(
      '暂未解除交易保护',
      expect.stringContaining('仍在处理原订单'),
    );
    await expect(AsyncStorage.getItem(storageKey)).resolves.toBeNull();
    await expect(
      loadPendingTradeIntent('contract', '7', 'BTCUSDT_PERP'),
    ).rejects.toMatchObject({ kind: 'CORRUPT' });
    expect(mockOpenContractOrder).not.toHaveBeenCalled();
    expect(mockCloseContractSummaryOrder).not.toHaveBeenCalled();
  });

  it('clears a corrupt contract lock after an exact completed authority result', async () => {
    const storageKey =
      '@exchange-mobile/pending-trade-intent/v1:contract:7:BTCUSDT_PERP';
    const clientOrderId = 'm-corrupt-contract-completed';
    await AsyncStorage.setItem(
      storageKey,
      `{"version":2,"clientOrderId":"${clientOrderId}","payload":`,
    );
    resetPendingTradeIntentMemoryForTests();
    mockFetchTradeIdempotencyStatus.mockResolvedValueOnce({
      market: 'contract',
      clientOrderId,
      status: 'COMPLETED',
      operation: 'CONTRACT_OPEN',
      result: {
        order_id: 91,
        symbol: 'BTCUSDT_PERP',
        client_order_id: clientOrderId,
      },
      resultSymbol: 'BTCUSDT_PERP',
      createdAt: '2026-08-02T01:02:03Z',
      completedAt: '2026-08-02T01:02:04Z',
    });

    renderer = await renderReadyContractScreen();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await mockOrderFormProps?.onPendingIntentReviewPress();
    });
    const authorityPrompt = (
      Alert.alert as jest.MockedFunction<typeof Alert.alert>
    ).mock.calls.find(call => call[0] === '查询原订单结果');
    await act(async () => {
      await authorityPrompt?.[2]?.[1]?.onPress?.();
    });

    await expect(AsyncStorage.getItem(storageKey)).resolves.toBeNull();
    expect(mockOrderFormProps?.pendingIntentReviewVisible).toBe(false);
    expect(Alert.alert).toHaveBeenCalledWith(
      '订单查询完成',
      expect.stringContaining('交易保护已解除'),
    );
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
    renderer = await renderReadyContractScreen();
    const confirmButton = openConfirmation();
    let submitPromise!: Promise<void>;

    await act(async () => {
      submitPromise = Promise.resolve(confirmButton.onPress?.());
      await Promise.resolve();
    });
    mockMarketScreenActive = false;
    await act(async () => {
      renderer?.update(<ContractScreen />);
      await Promise.resolve();
    });
    await act(async () => {
      releaseStorage();
      await submitPromise;
    });

    expect(mockOpenContractOrder).not.toHaveBeenCalled();
  });

  it('opens the complete contract selector without a synthetic stock order book', async () => {
    mockRouteParams = {
      symbol: 'NVDA_PERP',
      baseAsset: 'NVDA',
      quoteAsset: 'USD',
      displayLabel: 'NVIDIA',
      marketCategory: 'stock',
    };
    renderer = await renderReadyContractScreen();

    act(() => {
      mockSymbolHeaderProps?.onSymbolPress();
    });

    expect(mockOrderBookProps).toBeNull();
    expect(mockMarketSelectorProps).toMatchObject({
      initialCategory: 'stock',
      visible: true,
    });
  });

  it('routes a selected crypto catalog item back into Contract', async () => {
    renderer = await renderReadyContractScreen();
    act(() => {
      mockSymbolHeaderProps?.onSymbolPress();
    });
    act(() => {
      mockMarketSelectorProps?.onSelect({
        symbol: 'ETHUSDT_PERP',
        displayName: 'ETH/USDT Perpetual CFD',
        displaySymbol: 'ETH/USDT',
        baseAsset: 'ETH',
        quoteAsset: 'USDT',
        category: 'CRYPTO',
        marketCategory: 'crypto',
        providerSymbol: 'ETHUSDT',
        logoUrl: null,
        marketStatus: 'OPEN',
      });
    });

    expect(mockNavigate).toHaveBeenCalledWith('Contract', {
      symbol: 'ETHUSDT_PERP',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      displayLabel: 'ETH/USDT Perpetual CFD',
      marketCategory: 'crypto',
    });
    expect(mockMarketSelectorProps?.visible).toBe(false);
  });

  it('routes real Contract More actions and switches orders to the current tab', async () => {
    renderer = await renderReadyContractScreen();

    expect(mockTopTabsProps?.tabs).toEqual([
      { key: 'contract', label: '合约' },
    ]);
    act(() => {
      mockMoreSheetProps?.onActionPress('fundHistory');
    });
    expect(mockNavigate).toHaveBeenCalledWith('AssetHistory');

    act(() => {
      mockBottomTabsProps?.onChange('history');
      mockMoreSheetProps?.onActionPress('orders');
    });
    expect(mockBottomTabsProps?.activeTab).toBe('current');
    expect(mockMoreSheetProps?.visible).toBe(false);
  });

  it('loads active and historical orders with the backend truth filters', async () => {
    renderer = await renderReadyContractScreen();

    expect(mockFetchContractOrders).toHaveBeenCalledWith({
      symbol: 'BTCUSDT_PERP',
      status: 'ACTIVE',
      pageSize: 100,
    });
    expect(mockFetchContractOrders).toHaveBeenCalledWith({
      symbol: 'BTCUSDT_PERP',
      statusGroup: 'HISTORY',
      pageSize: 10,
    });
  });

  it('loads the next history page without discarding the records already shown', async () => {
    const first = cancelableOrder();
    const second = { ...cancelableOrder(), id: '42', orderId: 42 };
    mockFetchContractOrders.mockImplementation(
      (params: { statusGroup?: string; page?: number }) => {
        if (params.statusGroup !== 'HISTORY') return Promise.resolve([]);
        if (params.page === 2) {
          return Promise.resolve({
            items: [second],
            total: 11,
            page: 2,
            pageSize: 10,
            hasMore: false,
            nextPage: null,
          });
        }
        return Promise.resolve({
          items: [first],
          total: 11,
          page: 1,
          pageSize: 10,
          hasMore: true,
          nextPage: 2,
        });
      },
    );

    renderer = await renderReadyContractScreen();
    act(() => mockBottomTabsProps?.onChange('history'));
    expect(mockBottomTabsProps?.hasMore).toBe(true);
    await act(async () => {
      await mockBottomTabsProps?.onLoadMore();
    });

    expect(mockFetchContractOrders).toHaveBeenCalledWith({
      symbol: 'BTCUSDT_PERP',
      status: undefined,
      statusGroup: 'HISTORY',
      page: 2,
      pageSize: 10,
    });
    expect(
      mockBottomTabsProps?.historyOrders.map((item: any) => item.id),
    ).toEqual(['41', '42']);
    expect(mockBottomTabsProps?.hasMore).toBe(false);
  });

  it('switches every contract owner to the routed symbol and isolates the old confirmation', async () => {
    renderer = await renderReadyContractScreen();
    act(() => {
      mockOrderFormProps?.onLeverageChange(25);
    });
    expect(mockOrderFormProps?.leverage).toBe(25);
    const oldConfirmButton = openConfirmation();

    mockRouteParams = {
      symbol: 'ETHUSDT_PERP',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      displayLabel: 'ETH/USDT 永续',
      marketCategory: 'cfd',
    };
    const nextMarketState = executableMarketState();
    mockContractMarketState = {
      ...nextMarketState,
      marketView: {
        ...(nextMarketState.marketView as Record<string, unknown>),
        symbol: 'ETHUSDT_PERP',
        quote: {
          ...(nextMarketState.marketView.quote as Record<string, unknown>),
          symbol: 'ETHUSDT_PERP',
          lastPrice: 201,
          markPrice: 200,
        },
        depth: {
          ...(nextMarketState.marketView.depth as Record<string, unknown>),
          symbol: 'ETHUSDT_PERP',
        },
      },
    };
    mockFetchContractSymbolRules.mockResolvedValue({
      symbol: 'ETHUSDT_PERP',
      baseAsset: 'ETH',
      quoteAsset: 'USDT',
      pricePrecision: 2,
      quantityPrecision: 6,
      minQuantity: 0.001,
      maxQuantity: 250,
      maxLeverage: 2,
      tpSlTriggerPriceType: 'LAST_PRICE',
    });
    mockOrderBookProps = null;

    await act(async () => {
      renderer?.update(<ContractScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockUseContractMarketRealtime).toHaveBeenLastCalledWith(
      'ETHUSDT_PERP',
      'contract-screen',
      true,
    );
    expect(mockUseContractKlineRealtime).toHaveBeenLastCalledWith(
      'ETHUSDT_PERP',
      '1m',
      'contract-screen-kline',
      true,
    );
    expect(mockFetchContractSymbolRules).toHaveBeenCalledWith('ETHUSDT_PERP');
    expect(mockFetchContractPositions).toHaveBeenCalledWith('ETHUSDT_PERP');
    expect(mockFetchContractOrders).toHaveBeenCalledWith({
      symbol: 'ETHUSDT_PERP',
      status: 'ACTIVE',
      pageSize: 100,
    });
    expect(mockFetchContractOrders).toHaveBeenCalledWith({
      symbol: 'ETHUSDT_PERP',
      statusGroup: 'HISTORY',
      pageSize: 10,
    });
    expect(mockFetchContractTrades).toHaveBeenCalledWith('ETHUSDT_PERP', 10);
    expect(mockOrderFormProps?.baseAsset).toBe('ETH');
    expect(mockOrderFormProps?.quoteAsset).toBe('USDT');
    expect(mockOrderFormProps?.price).toBe('');
    expect(mockOrderFormProps?.quantity).toBe('');
    expect(mockOrderFormProps?.leverage).toBe(1);
    expect(mockOrderFormProps?.maxLeverage).toBe(2);
    expect(mockOrderBookProps).toBeNull();

    await act(async () => {
      await oldConfirmButton.onPress?.();
    });
    expect(mockOpenContractOrder).not.toHaveBeenCalled();

    (Alert.alert as jest.MockedFunction<typeof Alert.alert>).mockClear();
    await act(async () => {
      mockOrderFormProps?.onQuantityChange('1');
      mockOrderFormProps?.onBboPress();
    });
    const nextConfirmButton = openConfirmation();
    await act(async () => {
      await nextConfirmButton.onPress?.();
    });

    expect(mockOpenContractOrder).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'ETHUSDT_PERP' }),
    );
  });

  it('confirms a cancel once and reloads private state from the server', async () => {
    renderer = await renderReadyContractScreen();
    const confirmButton = openCancelConfirmation();

    await act(async () => {
      await Promise.all([confirmButton.onPress?.(), confirmButton.onPress?.()]);
    });

    expect(mockCancelContractOrder).toHaveBeenCalledTimes(1);
    expect(mockCancelContractOrder).toHaveBeenCalledWith(41);
    expect(mockFetchContractOrders).toHaveBeenCalledTimes(4);
    expect(mockBottomTabsProps?.orderActionFeedback).toEqual({
      tone: 'success',
      text: '订单 #41 已撤销，状态：CANCELED',
    });
  });

  it('does not open confirmation or request transport for an invalid order id', async () => {
    renderer = await renderReadyContractScreen();

    act(() => {
      mockBottomTabsProps?.onCancelOrder({
        ...cancelableOrder(),
        orderId: null,
      });
    });

    expect(mockCancelContractOrder).not.toHaveBeenCalled();
    expect(
      (Alert.alert as jest.MockedFunction<typeof Alert.alert>).mock.calls.some(
        call => call[0] === '确认撤单',
      ),
    ).toBe(false);
  });

  it('retains the real cancel error without reloading away the current row', async () => {
    mockCancelContractOrder.mockRejectedValue(
      new Error('订单已成交，无法撤销'),
    );
    renderer = await renderReadyContractScreen();
    const confirmButton = openCancelConfirmation();

    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockFetchContractOrders).toHaveBeenCalledTimes(2);
    expect(mockBottomTabsProps?.orderActionFeedback).toEqual({
      tone: 'error',
      text: '订单已成交，无法撤销',
    });
    expect(Alert.alert).toHaveBeenCalledWith(
      '撤单失败',
      '订单已成交，无法撤销',
    );
  });

  it('keeps the active Kline interval idempotent and switches only to a new interval', async () => {
    renderer = await renderReadyContractScreen();

    expect(mockUseContractKlineRealtime).toHaveBeenLastCalledWith(
      'BTCUSDT_PERP',
      '1m',
      'contract-screen-kline',
      true,
    );
    act(() => {
      mockKlineChartProps?.onIntervalChange('1m');
    });

    expect(mockUseContractKlineRealtime).toHaveBeenLastCalledWith(
      'BTCUSDT_PERP',
      '1m',
      'contract-screen-kline',
      true,
    );
    expect(
      mockUseContractKlineRealtime.mock.calls.some(call => call[1] !== '1m'),
    ).toBe(false);

    act(() => {
      mockKlineChartProps?.onIntervalChange('5m');
    });
    expect(mockUseContractKlineRealtime).toHaveBeenLastCalledWith(
      'BTCUSDT_PERP',
      '1m',
      'contract-screen-kline',
      true,
    );
    act(() => {
      jest.advanceTimersByTime(180);
    });

    expect(mockUseContractKlineRealtime).toHaveBeenLastCalledWith(
      'BTCUSDT_PERP',
      '5m',
      'contract-screen-kline',
      true,
    );
  });

  it('coalesces rapid Kline interval taps to the last requested interval', async () => {
    renderer = await renderReadyContractScreen();

    act(() => {
      mockKlineChartProps?.onIntervalChange('5m');
      mockKlineChartProps?.onIntervalChange('15m');
      mockKlineChartProps?.onIntervalChange('4h');
      jest.advanceTimersByTime(180);
    });

    expect(mockUseContractKlineRealtime).toHaveBeenLastCalledWith(
      'BTCUSDT_PERP',
      '4h',
      'contract-screen-kline',
      true,
    );
    expect(
      mockUseContractKlineRealtime.mock.calls.some(
        call => call[1] === '5m' || call[1] === '15m',
      ),
    ).toBe(false);
  });

  it('keeps Kline errors isolated from execution authority and order submission', async () => {
    mockUseContractKlineRealtime.mockReturnValue({
      items: [],
      loading: false,
      error: 'Kline unavailable',
      phase: 'degraded',
      source: null,
      mode: 'NATIVE',
      subscriptionReady: false,
      domainReady: false,
      gapDetected: false,
    });
    renderer = await renderReadyContractScreen();

    expect(mockKlineChartProps?.error).toBe('Kline unavailable');
    expect(mockOrderFormProps?.submitDisabled).toBe(false);
    const confirmButton = openConfirmation();
    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockOpenContractOrder).toHaveBeenCalledTimes(1);
  });

  it('shows REST fallback status when retained WS bars are no longer domain-ready', async () => {
    mockUseContractKlineRealtime.mockReturnValue({
      items: [
        {
          openTime: 1_800_000_000_000,
          open: 100,
          high: 102,
          low: 98,
          close: 101,
          volume: 10,
        },
      ],
      loading: false,
      error: null,
      phase: 'degraded',
      source: 'REST+WS_NATIVE',
      mode: 'NATIVE',
      subscriptionReady: true,
      domainReady: false,
      gapDetected: false,
    });
    renderer = await renderReadyContractScreen();

    expect(mockKlineChartProps?.statusNote).toBe('REST 兜底 · 等待实时 K线');
  });

  it('passes screen inactivity independently to the Kline owner', async () => {
    mockMarketScreenActive = false;
    renderer = await renderReadyContractScreen();

    expect(mockUseContractKlineRealtime).toHaveBeenLastCalledWith(
      'BTCUSDT_PERP',
      '1m',
      'contract-screen-kline',
      false,
    );
  });

  it('rejects an old confirmation after focus is lost and restored', async () => {
    renderer = await renderReadyContractScreen();
    const confirmButton = openConfirmation();

    mockMarketScreenActive = false;
    await act(async () => {
      renderer?.update(<ContractScreen />);
    });
    mockMarketScreenActive = true;
    await act(async () => {
      renderer?.update(<ContractScreen />);
    });
    const alertCallCount = (
      Alert.alert as jest.MockedFunction<typeof Alert.alert>
    ).mock.calls.length;
    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockOpenContractOrder).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledTimes(alertCallCount);
  });

  it('rejects an old confirmation after the authenticated user changes', async () => {
    renderer = await renderReadyContractScreen();
    const confirmButton = openConfirmation();

    mockUserId = 8;
    await act(async () => {
      renderer?.update(<ContractScreen />);
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockOpenContractOrder).not.toHaveBeenCalled();
  });

  it('rejects an open confirmation after the screen unmounts', async () => {
    renderer = await renderReadyContractScreen();
    const confirmButton = openConfirmation();

    await act(async () => {
      renderer?.unmount();
    });
    renderer = null;
    const alertCallCount = (
      Alert.alert as jest.MockedFunction<typeof Alert.alert>
    ).mock.calls.length;
    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockOpenContractOrder).not.toHaveBeenCalled();
    expect(Alert.alert).toHaveBeenCalledTimes(alertCallCount);
  });

  it('keeps a confirmation live across an execution-authority reconnect', async () => {
    renderer = await renderReadyContractScreen();
    const confirmButton = openConfirmation();

    mockContractMarketState = {
      ...executableMarketState(),
      lease: null,
      executionGeneration: 2,
    };
    await act(async () => {
      renderer?.update(<ContractScreen />);
    });
    mockContractMarketState = {
      ...executableMarketState(),
      executionGeneration: 2,
    };
    await act(async () => {
      renderer?.update(<ContractScreen />);
    });

    await act(async () => {
      await confirmButton.onPress?.();
    });

    expect(mockOpenContractOrder).toHaveBeenCalledTimes(1);
  });
});
