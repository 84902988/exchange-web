import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import BlackCardScreen from '../src/screens/home/BlackCardScreen';
import {createTranslator} from '../src/i18n';

describe('BlackCard screen', () => {
  it('renders the complete static card page without a payment or application action', () => {
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

    const rendered = JSON.stringify(renderer!.toJSON());
    expect(rendered).toContain('Exchange 黑卡');
    expect(rendered).toContain('美国信托银行资产保障');
    expect(rendered).toContain('申请 Exchange Mastercard 需支付 500 USDT');
    expect(rendered).toContain('card@service.example');
    expect(rendered).toContain('不会扣费、冻结资产或自动提交申请');

    const buttons = renderer!.root.findAll(
      node => node.props.accessibilityRole === 'button',
    );
    expect(
      Array.from(new Set(buttons.map(node => node.props.accessibilityLabel))),
    ).toEqual(['返回']);
    act(() => {
      buttons[0].props.onPress();
    });
    expect(goBack).toHaveBeenCalledTimes(1);
  });

  it('provides the new static content in all supported languages', () => {
    expect(
      createTranslator('zh-TW')('blackCard.marketing.stepsTitle'),
    ).toBe('申請流程');
    expect(createTranslator('en')('blackCard.marketing.stepsTitle')).toBe(
      'Application process',
    );
    expect(createTranslator('ja')('blackCard.marketing.stepsTitle')).toBe(
      '申請手順',
    );
  });
});
