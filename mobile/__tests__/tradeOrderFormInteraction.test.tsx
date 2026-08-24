import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import TradeOrderForm from '../src/components/trade/TradeOrderForm';

describe('spot order form interaction', () => {
  it('keeps guarded submissions pressable so the screen can explain and retry', () => {
    const onSubmitPress = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <TradeOrderForm
          amount="0.001"
          availableText="-- USDT"
          baseAsset="BTC"
          estimatedFeeLabel="预计手续费"
          estimatedFeeText="≈ 0.05 USDT"
          feedbackText="正在同步账户与当前委托，暂不能提交"
          feedbackTone={null}
          isLoggedIn
          lastPrice={100}
          orderType="MARKET"
          price=""
          quoteAsset="USDT"
          side="BUY"
          submitDisabled
          submitting={false}
          onAmountChange={jest.fn()}
          onBboPress={jest.fn()}
          onLoginPress={jest.fn()}
          onOrderTypeChange={jest.fn()}
          onPercentPress={jest.fn()}
          onPriceChange={jest.fn()}
          onSideChange={jest.fn()}
          onSubmitPress={onSubmitPress}
        />,
      );
    });

    const submit = renderer.root.find(
      node => node.props.accessibilityLabel === '买入 BTC',
    );
    expect(submit.props.accessibilityState).toEqual({
      busy: false,
      disabled: false,
    });

    act(() => submit.props.onPress());
    expect(onSubmitPress).toHaveBeenCalledTimes(1);
  });

  it('keeps fixed metric and feedback slots while loading state settles', () => {
    const commonProps = {
      amount: '0',
      availableText: '-- USDT',
      baseAsset: 'BTC',
      estimatedFeeLabel: '预计手续费',
      feedbackTone: null,
      isLoggedIn: true,
      lastPrice: 100,
      orderType: 'LIMIT' as const,
      price: '0',
      quoteAsset: 'USDT',
      side: 'BUY' as const,
      submitDisabled: true,
      submitting: false,
      onAmountChange: jest.fn(),
      onBboPress: jest.fn(),
      onLoginPress: jest.fn(),
      onOrderTypeChange: jest.fn(),
      onPercentPress: jest.fn(),
      onPriceChange: jest.fn(),
      onSideChange: jest.fn(),
      onSubmitPress: jest.fn(),
    };
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <TradeOrderForm
          {...commonProps}
          estimatedFeeText="费率加载中"
          feedbackText="正在同步账户与当前委托，暂不能提交"
        />,
      );
    });

    const feedbackSlot = () =>
      renderer.root.findByProps({testID: 'trade-order-form-feedback-slot'});
    const metrics = () =>
      renderer.root.findByProps({testID: 'trade-order-form-metrics'});
    expect(feedbackSlot().props.style.height).toBe(32);
    expect(metrics().props.style.height).toBe(76);

    act(() => {
      renderer.update(
        <TradeOrderForm
          {...commonProps}
          availableText="906.64 USDT"
          estimatedFeeText="--"
          feedbackText=""
          submitDisabled={false}
        />,
      );
    });
    expect(feedbackSlot().props.style.height).toBe(32);
    expect(metrics().props.style.height).toBe(76);
    expect(
      feedbackSlot().findAllByProps({
        children: '正在同步账户与当前委托，暂不能提交',
      }),
    ).toHaveLength(0);
    act(() => renderer.unmount());
  });
});
