import React from 'react';
import {Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {ContractContent} from '../src/screens/assets/AssetsScreen';

describe('contract asset overview', () => {
  it('keeps margin balances but does not duplicate total PnL amounts', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <ContractContent
          account={{
            marginAsset: 'USDT',
            availableMargin: 90,
            usedMargin: 10,
            frozenMargin: 0,
            positionMargin: 10,
            realizedPnl: 8,
            unrealizedPnl: -2,
            equity: 100,
          }}
          accountValuation={{
            accountKey: 'contract',
            rowCount: 0,
            positiveAssetCount: 0,
            knownValueUsdt: 100,
            totalUsdt: 100,
            valuationComplete: true,
          }}
          error={null}
          hidden={false}
          loading={false}
          rows={[]}
          snapshotAvailable
          onRetryPress={jest.fn()}
        />,
      );
    });

    const text = renderer.root
      .findAllByType(Text)
      .flatMap(node => node.props.children)
      .filter(value => typeof value === 'string')
      .join(' ');
    expect(text).toContain('可用保证金');
    expect(text).toContain('占用保证金');
    expect(text).not.toContain('未实现盈亏');
    expect(text).not.toContain('已实现盈亏');

    act(() => renderer.unmount());
  });
});
