import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import ContractOrderConfirmModal from '../src/components/contract/ContractOrderConfirmModal';

jest.mock('../src/i18n', () => ({
  useLanguage: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      key === 'contract.marketExecutionReference'
        ? `市价（当前执行参考 ${String(params?.price ?? '')}）`
        : key,
  }),
}));

describe('ContractOrderConfirmModal', () => {
  it('recalculates notional and margin when the live market price changes', () => {
    jest.useFakeTimers();
    const onSuppressChange = jest.fn();
    const baseProps = {
      visible: true,
      actionMode: 'OPEN' as const,
      direction: 'LONG' as const,
      orderType: 'MARKET' as const,
      quantity: 10,
      quantityText: '10',
      leverage: 200,
      referencePrice: 100,
      pricePrecision: 2,
      closableQuantity: null,
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      suppressChecked: false,
      submitting: false,
      onSuppressChange,
      onCancel: jest.fn(),
      onConfirm: jest.fn(),
    };
    let renderer: ReactTestRenderer.ReactTestRenderer;

    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractOrderConfirmModal {...baseProps} />,
      );
    });
    expect(
      renderer!.root.findByProps({ testID: 'contract-confirm-live-price' })
        .props.children,
    ).toBe('市价（当前执行参考 100 USDT）');
    expect(
      renderer!.root.findByProps({ testID: 'contract-confirm-live-notional' })
        .props.children,
    ).toBe('1,000 USDT');
    expect(
      renderer!.root.findByProps({ testID: 'contract-confirm-live-margin' })
        .props.children,
    ).toBe('5 USDT');

    act(() => {
      renderer!.update(
        <ContractOrderConfirmModal {...baseProps} referencePrice={110} />,
      );
    });
    expect(
      renderer!.root.findByProps({ testID: 'contract-confirm-live-price' })
        .props.children,
    ).toBe('市价（当前执行参考 110 USDT）');
    expect(
      renderer!.root.findByProps({ testID: 'contract-confirm-live-notional' })
        .props.children,
    ).toBe('1,100 USDT');
    expect(
      renderer!.root.findByProps({ testID: 'contract-confirm-live-margin' })
        .props.children,
    ).toBe('5.5 USDT');

    const suppressControl = renderer!.root.findByProps({
      accessibilityLabel: 'contract.dontShowAgain',
    });
    expect(suppressControl.props.disabled).toBe(true);
    act(() => suppressControl.props.onPress());
    expect(onSuppressChange).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(300));
    expect(
      renderer!.root.findByProps({
        accessibilityLabel: 'contract.dontShowAgain',
      }).props.disabled,
    ).toBe(false);
    act(() => {
      renderer!.root
        .findByProps({ accessibilityLabel: 'contract.dontShowAgain' })
        .props.onPress();
    });
    expect(onSuppressChange).toHaveBeenCalledWith(true);
    act(() => renderer!.unmount());
    jest.useRealTimers();
  });
});
