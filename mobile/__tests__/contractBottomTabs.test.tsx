import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import ContractBottomTabs from '../src/components/contract/ContractBottomTabs';
import type {
  ContractOrderItem,
  ContractPositionItem,
  ContractTradeItem,
} from '../src/api/contract';

function order(overrides: Partial<ContractOrderItem> = {}): ContractOrderItem {
  return {
    id: '31',
    orderId: 31,
    symbol: 'BTCUSDT_PERP',
    positionSide: 'LONG',
    action: 'OPEN',
    orderType: 'LIMIT',
    price: '100',
    quantity: '2',
    leverage: 10,
    marginAmount: '20',
    spreadFee: '0',
    filledQuantity: '0',
    status: 'OPEN',
    createdAt: null,
    ...overrides,
  };
}

function renderTabs({
  activeTab = 'current',
  currentOrders = [order()],
  historyOrders = [],
  onCancelOrder = jest.fn(),
  hasMore = false,
  loadingMore = false,
  onLoadMore = jest.fn(),
}: {
  activeTab?: 'current' | 'history';
  currentOrders?: ContractOrderItem[];
  historyOrders?: ContractOrderItem[];
  onCancelOrder?: jest.Mock;
  hasMore?: boolean;
  loadingMore?: boolean;
  onLoadMore?: jest.Mock;
} = {}) {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(
      <ContractBottomTabs
        activeTab={activeTab}
        currentOrders={currentOrders}
        fills={[]}
        historyOrders={historyOrders}
        hasMore={hasMore}
        isLoggedIn
        loadingMore={loadingMore}
        positions={[]}
        onCancelOrder={onCancelOrder}
        onChange={jest.fn()}
        onLoadMore={onLoadMore}
        onLoginPress={jest.fn()}
      />,
    );
  });
  return { renderer: renderer!, onCancelOrder, onLoadMore };
}

describe('ContractBottomTabs cancel action', () => {
  it('offers a real cancel action only on the current-order tab', () => {
    const current = order();
    const { renderer, onCancelOrder } = renderTabs({
      currentOrders: [current],
    });
    const button = renderer.root.findByProps({
      testID: 'contract-cancel-order-31',
    });

    expect(button.props.disabled).toBe(false);
    act(() => {
      button.props.onPress();
    });
    expect(onCancelOrder).toHaveBeenCalledWith(current);

    act(() => {
      renderer.update(
        <ContractBottomTabs
          activeTab="history"
          currentOrders={[]}
          fills={[]}
          historyOrders={[current]}
          isLoggedIn
          positions={[]}
          onCancelOrder={onCancelOrder}
          onChange={jest.fn()}
          onLoginPress={jest.fn()}
        />,
      );
    });
    expect(
      renderer.root.findAllByProps({
        testID: 'contract-cancel-order-31',
      }),
    ).toHaveLength(0);
  });

  it('renders an invalid numeric id as disabled and never emits a request action', () => {
    const invalid = order({ id: 'invalid', orderId: null });
    const { renderer, onCancelOrder } = renderTabs({
      currentOrders: [invalid],
    });
    const button = renderer.root.findByProps({
      testID: 'contract-cancel-order-invalid',
    });

    expect(button.props.disabled).toBe(true);
    act(() => {
      button.props.onPress();
    });
    expect(onCancelOrder).not.toHaveBeenCalled();
  });

  it('does not expose cancel for an active but backend-noncancelable PENDING order', () => {
    const pending = order({ status: 'PENDING' });
    const { renderer } = renderTabs({ currentOrders: [pending] });

    expect(
      renderer.root.findAllByProps({
        testID: 'contract-cancel-order-31',
      }),
    ).toHaveLength(0);
  });

  it('formats order price and quantity with the active symbol precisions', () => {
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractBottomTabs
          activeTab="history"
          currentOrders={[]}
          fills={[]}
          historyOrders={[
            order({
              id: 'xau-history',
              createdAt: '2026-08-22T10:20:30',
              price: '3000.000000000000000000',
              quantity: '0.010000000000000000',
              status: 'FILLED',
            }),
          ]}
          isLoggedIn
          pricePrecision={2}
          positions={[]}
          quantityPrecision={6}
          onChange={jest.fn()}
          onLoginPress={jest.fn()}
        />,
      );
    });

    const text = renderer!.root
      .findByProps({ testID: 'contract-record-xau-history' })
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat();
    expect(text).toEqual(
      expect.arrayContaining([
        '3000.00',
        '0.010000',
        '委托时间 2026-08-22 10:20:30',
      ]),
    );
    expect(text.join(' ')).not.toContain('000000000000000000');
  });

  it('shows the fill timestamp with fill semantics', () => {
    const fill: ContractTradeItem = {
      id: 'xau-fill',
      symbol: 'XAUUSDT_PERP',
      positionSide: 'LONG',
      action: 'CLOSE',
      price: '4087.23',
      quantity: '0.01',
      notional: '40.8723',
      leverage: 10,
      marginAmount: '4.08723',
      feeAmount: '0.01',
      spreadFee: '0',
      realizedPnl: '1.25',
      createdAt: '2026-08-22T11:22:33',
    };
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractBottomTabs
          activeTab="fills"
          currentOrders={[]}
          fills={[fill]}
          historyOrders={[]}
          isLoggedIn
          positions={[]}
          onChange={jest.fn()}
          onLoginPress={jest.fn()}
        />,
      );
    });

    const text = renderer!.root
      .findByProps({ testID: 'contract-record-xau-fill' })
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat();
    expect(text).toEqual(
      expect.arrayContaining(['成交时间 2026-08-22 11:22:33']),
    );
  });

  it('labels forced-liquidation, take-profit, and stop-loss closes by cause', () => {
    const baseFill: ContractTradeItem = {
      id: 'cause-base',
      symbol: 'ETHUSDT_PERP',
      positionSide: 'LONG',
      action: 'CLOSE',
      price: '2428.85',
      quantity: '0.1',
      notional: '242.885',
      leverage: 200,
      marginAmount: '1.26',
      feeAmount: '0',
      spreadFee: '0',
      realizedPnl: '-1.26',
      createdAt: '2026-08-23T03:14:26',
    };
    const fills: ContractTradeItem[] = [
      { ...baseFill, id: 'liquidation', closeReason: 'LIQUIDATION' },
      { ...baseFill, id: 'take-profit', closeReason: 'TAKE_PROFIT' },
      { ...baseFill, id: 'stop-loss', closeReason: 'STOP_LOSS' },
    ];
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractBottomTabs
          activeTab="fills"
          currentOrders={[]}
          fills={fills}
          historyOrders={[]}
          isLoggedIn
          positions={[]}
          onChange={jest.fn()}
          onLoginPress={jest.fn()}
        />,
      );
    });

    const titleFor = (id: string) =>
      renderer!.root
        .findByProps({ testID: `contract-record-${id}` })
        .findAllByType(Text)
        .map(node => node.props.children)
        .flat();
    expect(titleFor('liquidation')).toContain('强平多仓');
    expect(titleFor('take-profit')).toContain('止盈多仓');
    expect(titleFor('stop-loss')).toContain('止损多仓');
  });

  it('keeps every active order visible and cancelable beyond the old four-row cap', () => {
    const currentOrders = Array.from({ length: 7 }, (_, index) =>
      order({
        id: String(index + 1),
        orderId: index + 1,
      }),
    );
    const { renderer } = renderTabs({ currentOrders });

    const visibleOrderIds = new Set(
      renderer.root
        .findAll(
          node =>
            typeof node.props.testID === 'string' &&
            node.props.testID.startsWith('contract-cancel-order-'),
        )
        .map(node => node.props.testID),
    );
    expect(visibleOrderIds.size).toBe(7);
    expect(
      renderer.root.findByProps({ testID: 'contract-cancel-order-7' }).props
        .disabled,
    ).toBe(false);
  });
});

describe('ContractBottomTabs position risk authority', () => {
  it('exposes one close-all action only for a non-empty position tab', () => {
    const onCloseAllPositions = jest.fn();
    const position: ContractPositionItem = {
      id: 'position-close-all',
      symbol: 'BTCUSDT_PERP',
      side: 'LONG',
      leverage: 20,
      quantity: '0.25',
      entryPrice: '63000',
      markPrice: '63200',
      marginAmount: '787.5',
      unrealizedPnl: '50',
      liquidationPrice: '60123',
      takeProfitPrice: null,
      stopLossPrice: null,
      status: 'OPEN',
      openedAt: '2026-08-22T09:08:07',
    };
    let renderer: ReactTestRenderer.ReactTestRenderer;

    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractBottomTabs
          activeTab="positions"
          currentOrders={[]}
          fills={[]}
          historyOrders={[]}
          isLoggedIn
          positions={[position]}
          onChange={jest.fn()}
          onCloseAllPositions={onCloseAllPositions}
          onLoginPress={jest.fn()}
        />,
      );
    });

    const button = renderer!.root.findByProps({
      testID: 'contract-close-all-positions',
    });
    expect(button.props.accessibilityLabel).toBe(
      '市价平掉当前交易对全部仓位',
    );
    expect(button.props.disabled).toBe(false);
    act(() => {
      button.props.onPress();
    });
    expect(onCloseAllPositions).toHaveBeenCalledTimes(1);

    act(() => {
      renderer!.update(
        <ContractBottomTabs
          activeTab="current"
          currentOrders={[]}
          fills={[]}
          historyOrders={[]}
          isLoggedIn
          positions={[position]}
          onChange={jest.fn()}
          onCloseAllPositions={onCloseAllPositions}
          onLoginPress={jest.fn()}
        />,
      );
    });
    expect(
      renderer!.root.findAllByProps({
        testID: 'contract-close-all-positions',
      }),
    ).toHaveLength(0);
  });

  it('shows leverage, margin, unrealized pnl and TP/SL without liquidation price', () => {
    const position: ContractPositionItem = {
      id: 'position-7',
      symbol: 'BTCUSDT_PERP',
      side: 'LONG',
      leverage: 20,
      quantity: '0.25',
      entryPrice: '63000.10',
      markPrice: '63200.20',
      marginAmount: '787.50',
      unrealizedPnl: '50.025',
      liquidationPrice: '60123.45',
      takeProfitPrice: '65000',
      stopLossPrice: '61000',
      status: 'OPEN',
      openedAt: '2026-08-22T09:08:07',
    };
    let renderer: ReactTestRenderer.ReactTestRenderer;

    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractBottomTabs
          activeTab="positions"
          currentOrders={[]}
          fills={[]}
          historyOrders={[]}
          isLoggedIn
          pricePrecision={2}
          positions={[position]}
          quantityPrecision={3}
          onChange={jest.fn()}
          onLoginPress={jest.fn()}
        />,
      );
    });

    const positionCard = renderer!.root.findByProps({
      testID: 'contract-position-position-7',
    });
    const texts = positionCard
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat();
    expect(texts).toEqual(
      expect.arrayContaining([
        '20x',
        '保证金',
        '787.5',
        '未实现盈亏',
        '50.03',
        '止盈价',
        '65000.00',
        '止损价',
        '61000.00',
        '开仓时间 2026-08-22 09:08:07',
      ]),
    );
    expect(texts).not.toContain('强平价格');
    expect(texts).not.toContain('60123.45');
  });

  it('rounds noisy backend position decimals with the active symbol rules', () => {
    const position: ContractPositionItem = {
      id: 'position-xau',
      symbol: 'XAUUSDT',
      side: 'LONG',
      leverage: 20,
      quantity: '1.000000000000000000',
      entryPrice: '4095.450000000000000000',
      markPrice: '4349.310000000000000000',
      marginAmount: '20.477250000000000000',
      unrealizedPnl: '253.865000000000000000',
      liquidationPrice: '4074.972750000000000000',
      takeProfitPrice: '4500.000000000000000000',
      stopLossPrice: '4000.555000000000000000',
      status: 'OPEN',
    };
    let renderer: ReactTestRenderer.ReactTestRenderer;

    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractBottomTabs
          activeTab="positions"
          currentOrders={[]}
          fills={[]}
          historyOrders={[]}
          isLoggedIn
          pricePrecision={2}
          positions={[position]}
          quantityPrecision={3}
          onChange={jest.fn()}
          onLoginPress={jest.fn()}
        />,
      );
    });

    const text = renderer!.root
      .findByProps({ testID: 'contract-position-position-xau' })
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat();
    expect(text).toEqual(
      expect.arrayContaining([
        '1',
        '4095.45',
        '4349.31',
        '20.48',
        '253.87',
        '4500.00',
        '4000.56',
      ]),
    );
    expect(text.join(' ')).not.toContain('4074.97');
    expect(text.join(' ')).not.toContain('0000000000');
  });

  it('exposes direct close and TP/SL actions on each position card', () => {
    const position: ContractPositionItem = {
      id: '7',
      symbol: 'BTCUSDT_PERP',
      side: 'LONG',
      leverage: 20,
      quantity: '0.25',
      entryPrice: '63000.10',
      markPrice: '63200.20',
      marginAmount: '787.50',
      unrealizedPnl: '50.025',
      liquidationPrice: '60123.45',
      takeProfitPrice: null,
      stopLossPrice: null,
      status: 'OPEN',
    };
    const onClosePosition = jest.fn();
    const onEditPositionTpSl = jest.fn();
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractBottomTabs
          activeTab="positions"
          currentOrders={[]}
          fills={[]}
          historyOrders={[]}
          isLoggedIn
          positions={[position]}
          onChange={jest.fn()}
          onClosePosition={onClosePosition}
          onEditPositionTpSl={onEditPositionTpSl}
          onLoginPress={jest.fn()}
        />,
      );
    });

    act(() => {
      renderer!.root.findByProps({testID: 'contract-close-position-7'}).props.onPress();
      renderer!.root.findByProps({testID: 'contract-tp-sl-position-7'}).props.onPress();
    });
    expect(onClosePosition).toHaveBeenCalledWith(position);
    expect(onEditPositionTpSl).toHaveBeenCalledWith(position);
  });
});

describe('ContractBottomTabs pagination', () => {
  it('keeps every loaded history row and requests the next page explicitly', () => {
    const historyOrders = Array.from({ length: 25 }, (_, index) =>
      order({
        id: String(index + 1),
        orderId: index + 1,
        price: String(10_000 + index),
        status: 'FILLED',
      }),
    );
    const { renderer, onLoadMore } = renderTabs({
      activeTab: 'history',
      historyOrders,
      hasMore: true,
    });

    const text = renderer.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat()
      .join(' ');
    expect(text).toContain('10024');
    expect(text).not.toContain('当前仅展示最近 20 条');

    const loadMore = renderer.root.findByProps({
      testID: 'contract-records-load-more',
    });
    expect(loadMore.props.accessibilityState).toEqual({
      busy: false,
      disabled: false,
    });
    act(() => loadMore.props.onPress());
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('exposes retry for an initial record failure', () => {
    const onRetryPress = jest.fn();
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractBottomTabs
          activeTab="history"
          currentOrders={[]}
          error="历史委托加载失败"
          fills={[]}
          historyOrders={[]}
          isLoggedIn
          positions={[]}
          onChange={jest.fn()}
          onLoginPress={jest.fn()}
          onRetryPress={onRetryPress}
        />,
      );
    });

    act(() => {
      renderer!.root
        .findByProps({ testID: 'contract-records-retry' })
        .props.onPress();
    });
    expect(onRetryPress).toHaveBeenCalledTimes(1);
  });
});
