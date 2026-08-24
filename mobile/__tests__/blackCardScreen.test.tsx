import React from 'react';
import { Text } from 'react-native';
import ReactTestRenderer, { act } from 'react-test-renderer';
import BlackCardScreen from '../src/screens/home/BlackCardScreen';

describe('BlackCard screen', () => {
  it('renders a dedicated information-only page without an activation action', () => {
    const goBack = jest.fn();
    let renderer: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <BlackCardScreen
          navigation={{ goBack } as never}
          route={{ key: 'black-card', name: 'BlackCard' }}
        />,
      );
    });

    const text = renderer!.root
      .findAllByType(Text)
      .flatMap(node => node.props.children)
      .filter(value => typeof value === 'string')
      .join(' ');
    expect(text).toContain('BlackCard 专属页面');
    expect(text).toContain('本页面不会扣费、冻结资产或变更会员等级');
    expect(text).toContain('不构成权益承诺');
  });
});
