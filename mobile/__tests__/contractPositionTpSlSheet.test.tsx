import React from 'react';
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import ContractPositionTpSlSheet from '../src/components/contract/ContractPositionTpSlSheet';
import type {ContractPositionItem} from '../src/api/contract';

const position: ContractPositionItem = {
  id: '7',
  symbol: 'BTCUSDT_PERP',
  side: 'LONG',
  leverage: 10,
  quantity: '0.25',
  entryPrice: '100',
  markPrice: '101',
  marginAmount: '2.5',
  unrealizedPnl: '0.25',
  liquidationPrice: '90',
  takeProfitPrice: '110',
  stopLossPrice: '95',
  status: 'OPEN',
};

describe('ContractPositionTpSlSheet', () => {
  it('shows both server-backed prices and forwards edit/save actions', () => {
    const onTakeProfitPriceChange = jest.fn();
    const onStopLossPriceChange = jest.fn();
    const onSave = jest.fn();
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractPositionTpSlSheet
          error={null}
          position={position}
          pricePrecision={2}
          referencePrice={101}
          referencePriceType="MARK_PRICE"
          saving={false}
          stopLossPrice="95"
          takeProfitPrice="110"
          visible
          onClose={jest.fn()}
          onSave={onSave}
          onStopLossPriceChange={onStopLossPriceChange}
          onTakeProfitPriceChange={onTakeProfitPriceChange}
        />,
      );
    });

    const inputs = renderer!.root.findAllByType(TextInput);
    expect(renderer!.root.findByType(KeyboardAvoidingView).props.behavior).toBe(
      Platform.OS === 'ios' ? 'padding' : 'height',
    );
    expect(renderer!.root.findByType(ScrollView).props.keyboardShouldPersistTaps).toBe(
      'handled',
    );
    expect(inputs.map(input => input.props.value)).toEqual(['110', '95']);
    act(() => {
      inputs[0].props.onChangeText('111');
      inputs[1].props.onChangeText('94');
      renderer!.root.findByProps({testID: 'contract-tp-sl-save'}).props.onPress();
    });
    expect(onTakeProfitPriceChange).toHaveBeenCalledWith('111');
    expect(onStopLossPriceChange).toHaveBeenCalledWith('94');
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('steps one whole price point from the live mark price while preserving precision', () => {
    const onTakeProfitPriceChange = jest.fn();
    const onStopLossPriceChange = jest.fn();
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractPositionTpSlSheet
          error={null}
          position={{...position, markPrice: '4500.000'}}
          pricePrecision={3}
          referencePrice={4563.695}
          referencePriceType="LAST_PRICE"
          saving={false}
          stopLossPrice=""
          takeProfitPrice=""
          visible
          onClose={jest.fn()}
          onSave={jest.fn()}
          onStopLossPriceChange={onStopLossPriceChange}
          onTakeProfitPriceChange={onTakeProfitPriceChange}
        />,
      );
    });

    expect(renderer!.root.findByProps({testID: 'contract-tp-price-input'}).props.value).toBe('');
    expect(
      renderer!.root
        .findAllByType(Text)
        .map(node => node.props.children)
        .join(' '),
    ).toContain('当前最新价 4,563.695');
    for (const testID of [
      'contract-tp-price-input-decrement',
      'contract-tp-price-input-increment',
    ]) {
      const button = renderer!.root
        .findAllByProps({testID})
        .find(node => node.props.style !== undefined);
      expect(button).toBeDefined();
      const rawStyle =
        typeof button!.props.style === 'function'
          ? button!.props.style({pressed: false})
          : button!.props.style;
      const style = StyleSheet.flatten(rawStyle);
      expect(style.width).toBeGreaterThanOrEqual(44);
      expect(style.height).toBeGreaterThanOrEqual(44);
    }
    act(() => {
      renderer!.root
        .findByProps({testID: 'contract-tp-price-input-decrement'})
        .props.onPress();
      renderer!.root
        .findByProps({testID: 'contract-sl-price-input-increment'})
        .props.onPress();
    });

    expect(onTakeProfitPriceChange).toHaveBeenCalledWith('4562.695');
    expect(onStopLossPriceChange).toHaveBeenCalledWith('4564.695');
  });
});
