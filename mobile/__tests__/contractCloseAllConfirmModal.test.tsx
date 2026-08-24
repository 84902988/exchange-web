import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import ContractCloseAllConfirmModal from '../src/components/contract/ContractCloseAllConfirmModal';

jest.mock('../src/i18n', () => ({
  useLanguage: () => ({
    t: (key: string) => key,
  }),
}));

describe('ContractCloseAllConfirmModal', () => {
  it('recalculates live execution references and notionals without reopening', () => {
    jest.useFakeTimers();
    const onSuppressChange = jest.fn();
    const baseProps = {
      visible: true,
      targets: [
        { side: 'LONG' as const, quantity: '10', referencePrice: 100 },
        { side: 'SHORT' as const, quantity: '2', referencePrice: 101 },
      ],
      baseAsset: 'BTC',
      quoteAsset: 'USDT',
      pricePrecision: 2,
      suppressChecked: false,
      submitting: false,
      onSuppressChange,
      onCancel: jest.fn(),
      onConfirm: jest.fn(),
    };
    let renderer: ReactTestRenderer.ReactTestRenderer;

    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractCloseAllConfirmModal {...baseProps} />,
      );
    });
    expect(
      renderer!.root.findByProps({ testID: 'contract-close-all-long-price' })
        .props.children,
    ).toBe('100 USDT');
    expect(
      renderer!.root.findByProps({ testID: 'contract-close-all-long-notional' })
        .props.children,
    ).toBe('1,000 USDT');

    act(() => {
      renderer!.update(
        <ContractCloseAllConfirmModal
          {...baseProps}
          targets={[
            { side: 'LONG', quantity: '10', referencePrice: 105 },
            { side: 'SHORT', quantity: '2', referencePrice: 106 },
          ]}
        />,
      );
    });
    expect(
      renderer!.root.findByProps({ testID: 'contract-close-all-long-price' })
        .props.children,
    ).toBe('105 USDT');
    expect(
      renderer!.root.findByProps({ testID: 'contract-close-all-long-notional' })
        .props.children,
    ).toBe('1,050 USDT');

    const suppressControl = renderer!.root.findByProps({
      accessibilityLabel: 'contract.closeAllDontShowAgain',
    });
    expect(suppressControl.props.disabled).toBe(true);
    act(() => suppressControl.props.onPress());
    expect(onSuppressChange).not.toHaveBeenCalled();
    act(() => jest.advanceTimersByTime(300));
    expect(
      renderer!.root.findByProps({
        accessibilityLabel: 'contract.closeAllDontShowAgain',
      }).props.disabled,
    ).toBe(false);
    act(() => {
      renderer!.root
        .findByProps({
          accessibilityLabel: 'contract.closeAllDontShowAgain',
        })
        .props.onPress();
    });
    expect(onSuppressChange).toHaveBeenCalledWith(true);
    act(() => renderer!.unmount());
    jest.useRealTimers();
  });
});
