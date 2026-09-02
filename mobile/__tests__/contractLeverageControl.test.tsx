import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import {
  clampLeverage,
  getLeverageMarks,
} from '../src/components/contract/ContractLeverageSelectorSheet';
import ContractOrderForm, {
  calculateContractSpreadCost,
  isCompactContractOrderForm,
} from '../src/components/contract/ContractOrderForm';

function createProps(overrides: Record<string, unknown> = {}) {
  return {
    actionMode: 'OPEN' as const,
    direction: 'LONG' as const,
    orderType: 'LIMIT' as const,
    price: '100',
    quantity: '1',
    leverage: 1,
    maxLeverage: 3,
    availableMargin: 1_000,
    equity: 1_000,
    lastPrice: 100,
    markPrice: 100,
    spreadFeePrice: null,
    pricePrecision: 2,
    baseAsset: 'BTC',
    quoteAsset: 'USDT',
    isLoggedIn: true,
    submitting: false,
    submitDisabled: false,
    feedbackText: '',
    feedbackTone: null,
    onActionModeChange: jest.fn(),
    onDirectionChange: jest.fn(),
    onOrderTypeChange: jest.fn(),
    onPriceChange: jest.fn(),
    onQuantityChange: jest.fn(),
    onLeverageChange: jest.fn(),
    onPercentPress: jest.fn(),
    onBboPress: jest.fn(),
    onLoginPress: jest.fn(),
    onSubmitPress: jest.fn(),
    ...overrides,
  };
}

function findByAccessibilityLabel(
  renderer: ReactTestRenderer.ReactTestRenderer,
  label: string,
) {
  return renderer.root.find(node => node.props.accessibilityLabel === label);
}

describe('ContractOrderForm leverage control', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | null = null;

  afterEach(() => {
    act(() => {
      renderer?.unmount();
    });
    renderer = null;
  });

  it('uses the compact field layout on narrow screens or larger system text', () => {
    expect(isCompactContractOrderForm(359, 1)).toBe(true);
    expect(isCompactContractOrderForm(411, 1.3)).toBe(true);
    expect(isCompactContractOrderForm(411, 1)).toBe(false);
  });

  it('matches the web leverage marks without rendering every integer option', () => {
    expect(getLeverageMarks(50)).toEqual([1, 30, 50]);
    expect(getLeverageMarks(200)).toEqual([1, 30, 60, 90, 120, 150, 200]);
    expect(clampLeverage(201, 200)).toBe(200);
    expect(clampLeverage(9.9, 200)).toBe(9);
  });

  it('updates the spread cost from the single-side price and quantity', () => {
    expect(calculateContractSpreadCost(0.1, 1)).toBeCloseTo(0.1);
    expect(calculateContractSpreadCost(0.1, 10)).toBeCloseTo(1);
    expect(calculateContractSpreadCost(0.1, 0)).toBeNull();
    expect(calculateContractSpreadCost(null, 10)).toBeNull();
  });

  it('renders the quantity-adjusted spread cost in the order summary', () => {
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractOrderForm
          {...createProps({
            pricePrecision: 1,
            quantity: '0.1',
            spreadFeePrice: 0.1,
          })}
        />,
      );
    });

    const renderedText = () =>
      renderer!.root
        .findAllByType(Text)
        .map(node => node.props.children)
        .flat();

    expect(renderedText()).toContain('0.01 USDT');
    expect(renderedText()).not.toContain('0 USDT');

    act(() => {
      renderer?.update(
        <ContractOrderForm
          {...createProps({
            pricePrecision: 1,
            quantity: '1',
            spreadFeePrice: 0.1,
          })}
        />,
      );
    });

    expect(renderedText()).toContain('0.1 USDT');
    expect(renderedText()).not.toContain('0.01 USDT');
  });

  it('opens the bounded input and slider, then applies only after confirmation', () => {
    const onLeverageChange = jest.fn();
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractOrderForm {...createProps({ onLeverageChange })} />,
      );
    });

    const trigger = findByAccessibilityLabel(renderer!, '当前杠杆 1 倍');
    expect(trigger.props.disabled).toBe(false);
    expect(trigger.props.accessibilityRole).toBe('button');

    act(() => {
      trigger.props.onPress();
    });

    const slider = findByAccessibilityLabel(renderer!, '调整杠杆');
    expect(slider.props.accessibilityRole).toBe('adjustable');
    expect(slider.props.accessibilityValue).toMatchObject({
      min: 1,
      max: 3,
      now: 1,
    });
    expect(() => findByAccessibilityLabel(renderer!, '选择 4 倍杠杆')).toThrow();

    act(() => {
      findByAccessibilityLabel(renderer!, '输入杠杆倍数').props.onChangeText('3');
    });
    expect(onLeverageChange).not.toHaveBeenCalled();

    act(() => {
      findByAccessibilityLabel(renderer!, '确认 3 倍杠杆').props.onPress();
    });
    expect(onLeverageChange).toHaveBeenCalledTimes(1);
    expect(onLeverageChange).toHaveBeenCalledWith(3);
  });

  it('locks the selector until authoritative rules are available', () => {
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractOrderForm {...createProps({ leverage: 3 })} />,
      );
    });

    expect(findByAccessibilityLabel(renderer!, '当前杠杆 3 倍').props.disabled).toBe(
      false,
    );

    act(() => {
      renderer?.update(
        <ContractOrderForm
          {...createProps({ leverage: 1, maxLeverage: null })}
        />,
      );
    });

    expect(findByAccessibilityLabel(renderer!, '当前杠杆 1 倍').props.disabled).toBe(
      true,
    );
  });

  it('does not present a liquidation price in the pre-trade summary', () => {
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractOrderForm {...createProps({ leverage: 20 })} />,
      );
    });

    const texts = renderer!.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat();
    expect(texts).not.toContain('预估强平价');
    expect(texts).not.toContain('强平价格');
    expect(texts).not.toContain('成交后显示');
  });

  it('exposes the primary contract controls to assistive input', () => {
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractOrderForm {...createProps()} />,
      );
    });

    expect(
      findByAccessibilityLabel(renderer!, '选择买单方向').props.accessibilityState,
    ).toMatchObject({ selected: true });
    expect(
      findByAccessibilityLabel(renderer!, '填入当前最优价').props
        .accessibilityRole,
    ).toBe('button');
    expect(
      findByAccessibilityLabel(renderer!, '使用 100%').props.accessibilityRole,
    ).toBe('button');
    expect(
      findByAccessibilityLabel(renderer!, '提交买单').props.accessibilityState,
    ).toMatchObject({ busy: false, disabled: false });
  });

  it('exposes the active percent sizing choice', () => {
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractOrderForm {...createProps({ selectedPercent: 25 })} />,
      );
    });

    expect(
      findByAccessibilityLabel(renderer!, '使用 25%').props.accessibilityState,
    ).toMatchObject({ selected: true });
    expect(
      findByAccessibilityLabel(renderer!, '使用 50%').props.accessibilityState,
    ).toMatchObject({ selected: false });
  });

  it('keeps the submit action disabled until both price and quantity are valid', () => {
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractOrderForm
          {...createProps({
            price: '0',
            quantity: '0',
            submitDisabled: false,
          })}
        />,
      );
    });

    expect(
      findByAccessibilityLabel(renderer!, '提交买单').props.accessibilityState,
    ).toMatchObject({ disabled: true });

    act(() => {
      renderer?.update(
        <ContractOrderForm
          {...createProps({
            price: '100',
            quantity: '0',
            submitDisabled: false,
          })}
        />,
      );
    });
    expect(
      findByAccessibilityLabel(renderer!, '提交买单').props.accessibilityState,
    ).toMatchObject({ disabled: true });

    act(() => {
      renderer?.update(
        <ContractOrderForm
          {...createProps({
            price: '100',
            quantity: '1',
            submitDisabled: false,
          })}
        />,
      );
    });
    expect(
      findByAccessibilityLabel(renderer!, '提交买单').props.accessibilityState,
    ).toMatchObject({ disabled: false });
  });

  it('keeps buy and sell labels while mapping close orders to the opposite position side', () => {
    const onDirectionChange = jest.fn();
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractOrderForm
          {...createProps({
            actionMode: 'CLOSE',
            onDirectionChange,
          })}
        />,
      );
    });

    const texts = renderer!.root
      .findAllByType(Text)
      .map(node => node.props.children)
      .flat();
    expect(texts).toContain('买单');
    expect(texts).toContain('卖单');
    expect(texts).not.toContain('平多');
    expect(texts).not.toContain('平空');

    const buyCloseTab = renderer!.root.find(
      node =>
        node.props.accessibilityLabel === '选择买单方向' &&
        node.props.accessibilityState?.selected === false,
    );
    act(() => {
      buyCloseTab.props.onPress();
    });
    expect(onDirectionChange).toHaveBeenCalledWith('SHORT');
  });
});
