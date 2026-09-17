import React from 'react';
import ReactTestRenderer, { act } from 'react-test-renderer';
import BlackCardScreen from '../src/screens/home/BlackCardScreen';
import {createTranslator} from '../src/i18n';
import {branding} from '../src/config/brandingConfig';

describe('BlackCard screen', () => {
  it('renders externally configured content and substitutes the configured name', () => {
    const originalName = branding.displayName;
    try {
      branding.displayName = 'Example Trading';
      branding.blackCard.enabled = true;
      branding.blackCardTranslations['zh-CN'] = {
        'blackCard.marketing.heroTitle': '{{brandName}} 会员卡',
        'blackCard.marketing.heroSubtitle': '经确认的卡片介绍',
      };
      let renderer!: ReactTestRenderer.ReactTestRenderer;
      act(() => {
        renderer = ReactTestRenderer.create(<BlackCardScreen navigation={{goBack: jest.fn()} as never} route={{key: 'card', name: 'BlackCard'}} />);
      });
      const content = JSON.stringify(renderer.toJSON());
      expect(content).toContain('Example Trading 会员卡');
      expect(content).toContain('经确认的卡片介绍');
      expect(content).not.toContain('{{brandName}}');
      act(() => renderer.unmount());
    } finally {
      branding.displayName = originalName;
      branding.blackCard.enabled = false;
      branding.blackCardTranslations = {};
    }
  });
  it('shows an unpublished state without client claims or an application action', () => {
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
    expect(rendered).toContain('卡片服务信息尚未发布');
    expect(rendered).not.toContain('USDT');
    expect(rendered).not.toContain('mailto:');

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
    act(() => renderer!.unmount());
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
