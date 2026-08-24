import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import ContractMoreSheet from '../src/components/contract/ContractMoreSheet';
import TradeMoreSheet from '../src/components/trade/TradeMoreSheet';

const expectedLabels = ['充值', '提现', '划转', '资金流水', '资产', '订单'];
const placeholderLabels = [
  'VIP',
  '邀请',
  '设置/帮助',
  '帮助中心',
  '风险说明',
  '帮助',
  '合约账户',
];

function getTextLabels(renderer: ReactTestRenderer.ReactTestRenderer) {
  return renderer.root
    .findAllByType(Text)
    .map(node => node.props.children)
    .filter((value): value is string => typeof value === 'string');
}

function pressTextNode(node: ReactTestRenderer.ReactTestInstance | undefined) {
  let current = node;
  while (current && typeof current.props.onPress !== 'function') {
    current = current.parent ?? undefined;
  }
  current?.props.onPress();
}

describe('trading More sheets', () => {
  it.each([
    ['Trade', TradeMoreSheet],
    ['Contract', ContractMoreSheet],
  ] as const)('%s exposes only real destinations', (_name, Sheet) => {
    const onActionPress = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <Sheet
          visible
          onActionPress={onActionPress}
          onClose={jest.fn()}
        />,
      );
    });

    const labels = getTextLabels(renderer);
    expect(labels).toEqual(expect.arrayContaining(expectedLabels));
    for (const placeholder of placeholderLabels) {
      expect(labels).not.toContain(placeholder);
    }

    const depositLabel = renderer.root
      .findAllByType(Text)
      .find(node => node.props.children === '充值');
    act(() => {
      pressTextNode(depositLabel);
    });
    expect(onActionPress).toHaveBeenCalledWith('deposit');

    act(() => {
      renderer.unmount();
    });
  });
});
