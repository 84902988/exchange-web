import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import TradeBottomTabs from '../src/components/trade/TradeBottomTabs';

describe('TradeBottomTabs complete current-order management', () => {
  it('renders every loaded current order and keeps later orders cancelable', () => {
    const onCancelPress = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <TradeBottomTabs
          activeTab="current"
          cancelingOrderIds={[]}
          currentOrders={Array.from({length: 6}, (_, index) => ({
            id: String(index + 1),
            orderId: index + 1,
            symbol: 'BTCUSDT',
            side: 'BUY' as const,
            orderType: 'LIMIT',
            price: '100',
            amount: '1',
            filledAmount: '0',
            status: 'OPEN',
            createdAt: '2026-08-22T10:20:30',
          }))}
          error={null}
          fills={[]}
          historyOrders={[]}
          isLoggedIn
          onCancelPress={onCancelPress}
          onChange={jest.fn()}
          onLoginPress={jest.fn()}
        />,
      );
    });

    const sixthCancel = renderer.root.findByProps({
      accessibilityLabel: '撤销订单 6',
    });
    act(() => {
      sixthCancel.props.onPress();
    });
    expect(onCancelPress).toHaveBeenCalledWith(
      expect.objectContaining({orderId: 6}),
    );
    expect(
      renderer.root.findAllByProps({
        children: '委托时间 2026-08-22 10:20:30',
      }).length,
    ).toBeGreaterThan(0);
  });

  it('offers a retry action when order records fail to load', () => {
    const onRetryPress = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <TradeBottomTabs
          activeTab="history"
          cancelingOrderIds={[]}
          currentOrders={[]}
          error="历史委托加载失败，请稍后重试"
          fills={[]}
          historyOrders={[]}
          isLoggedIn
          onCancelPress={jest.fn()}
          onChange={jest.fn()}
          onLoginPress={jest.fn()}
          onRetryPress={onRetryPress}
        />,
      );
    });

    const retryButton = renderer.root
      .findAll(
        node =>
          node.props.accessibilityRole === 'button' &&
          typeof node.props.onPress === 'function',
      )
      .find(node =>
        node.findAllByProps({children: '重新加载'}).length > 0,
      );
    expect(retryButton).toBeDefined();
    act(() => {
      retryButton?.props.onPress();
    });
    expect(onRetryPress).toHaveBeenCalledTimes(1);
  });

  it('keeps loaded records visible while offering cursor-based load more', () => {
    const onLoadMore = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <TradeBottomTabs
          activeTab="history"
          cancelingOrderIds={[]}
          currentOrders={[]}
          error={null}
          fills={[]}
          hasMore
          historyOrders={[
            {
              id: '42',
              orderId: 42,
              symbol: 'BTCUSDT',
              side: 'BUY',
              orderType: 'LIMIT',
              price: '100',
              amount: '1',
              filledAmount: '1',
              status: 'FILLED',
            },
          ]}
          isLoggedIn
          onCancelPress={jest.fn()}
          onChange={jest.fn()}
          onLoadMore={onLoadMore}
          onLoginPress={jest.fn()}
        />,
      );
    });

    expect(
      renderer.root.findAllByProps({children: '100.00'}).length,
    ).toBeGreaterThan(0);
    const loadMoreButton = renderer.root.findByProps({
      accessibilityLabel: '加载更多记录',
    });
    act(() => loadMoreButton.props.onPress());
    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('labels order metrics and shows market orders as market instead of zero', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <TradeBottomTabs
          activeTab="history"
          amountPrecision={6}
          baseAsset="BTC"
          cancelingOrderIds={[]}
          currentOrders={[]}
          fills={[]}
          historyOrders={[
            {
              id: 'market-order',
              orderId: 51,
              symbol: 'BTCUSDT',
              side: 'SELL',
              orderType: 'MARKET',
              price: '0',
              amount: '0.0002',
              filledAmount: '0.00018',
              status: 'FILLED',
            },
          ]}
          isLoggedIn
          pricePrecision={1}
          quoteAsset="USDT"
          symbolLabel="BTC/USDT"
          onCancelPress={jest.fn()}
          onChange={jest.fn()}
          onLoginPress={jest.fn()}
        />,
      );
    });

    const row = renderer.root.findByProps({
      testID: 'spot-record-history-market-order',
    });
    expect(row.findAllByProps({children: '委托价'}).length).toBeGreaterThan(0);
    expect(
      row.findAllByProps({children: '已成交 / 委托数量'}).length,
    ).toBeGreaterThan(0);
    expect(row.findAllByProps({children: '市价'}).length).toBeGreaterThan(0);
    expect(row.findAllByProps({children: '0.0 USDT'})).toHaveLength(0);
    expect(
      row.findAllByProps({children: '0.00018 / 0.0002 BTC'}).length,
    ).toBeGreaterThan(0);
  });

  it('labels fill price and quantity with the backend-selected precision', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <TradeBottomTabs
          activeTab="fills"
          amountPrecision={6}
          baseAsset="BTC"
          cancelingOrderIds={[]}
          currentOrders={[]}
          fills={[
            {
              id: 'fill-1',
              symbol: 'BTCUSDT',
              side: 'BUY',
              price: '62794.8',
              amount: '0.00018',
              quoteAmount: '11.303064',
              createdAt: '2026-08-22T11:22:33',
            },
          ]}
          historyOrders={[]}
          isLoggedIn
          pricePrecision={1}
          quoteAsset="USDT"
          symbolLabel="BTC/USDT"
          onCancelPress={jest.fn()}
          onChange={jest.fn()}
          onLoginPress={jest.fn()}
        />,
      );
    });

    const row = renderer.root.findByProps({testID: 'spot-record-fills-fill-1'});
    expect(row.findAllByProps({children: '成交价'}).length).toBeGreaterThan(0);
    expect(row.findAllByProps({children: '成交数量'}).length).toBeGreaterThan(
      0,
    );
    expect(
      row.findAllByProps({children: '62,794.8 USDT'}).length,
    ).toBeGreaterThan(0);
    expect(row.findAllByProps({children: '0.00018 BTC'}).length).toBeGreaterThan(
      0,
    );
    expect(
      row.findAllByProps({children: '成交时间 2026-08-22 11:22:33'}).length,
    ).toBeGreaterThan(0);
  });
});
