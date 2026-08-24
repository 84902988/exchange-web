import React from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {Search} from 'lucide-react-native';
import AppScreen from '../src/components/common/AppScreen';
import IconButton from '../src/components/common/IconButton';
import PrimaryButton from '../src/components/common/PrimaryButton';
import MarketRow from '../src/components/markets/MarketRow';

function render(element: React.ReactElement) {
  let renderer!: ReactTestRenderer.ReactTestRenderer;
  act(() => {
    renderer = ReactTestRenderer.create(element);
  });
  return renderer;
}

describe('shared mobile interaction feedback', () => {
  it('gives primary actions a compact pressed response without changing disabled state', () => {
    const renderer = render(<PrimaryButton title="确认" onPress={jest.fn()} />);
    const button = renderer.root.find(
      node =>
        node.props.accessibilityRole === 'button' &&
        typeof node.props.style === 'function',
    );
    const pressed = StyleSheet.flatten(button.props.style({pressed: true}));
    expect(pressed.opacity).toBeLessThan(1);
    expect(pressed.transform).toEqual([{scale: 0.985}]);
    expect(button.props.android_ripple.color).toBeTruthy();
    act(() => renderer.unmount());
  });

  it('gives icon and market-row controls visible touch acknowledgement', () => {
    const iconRenderer = render(
      <IconButton
        accessibilityLabel="搜索"
        icon={Search}
        onPress={jest.fn()}
      />,
    );
    const iconButton = iconRenderer.root.find(
      node =>
        node.props.accessibilityRole === 'button' &&
        typeof node.props.style === 'function',
    );
    expect(
      StyleSheet.flatten(iconButton.props.style({pressed: true})).transform,
    ).toEqual([{scale: 0.94}]);
    act(() => iconRenderer.unmount());

    const rowRenderer = render(
      <MarketRow
        item={{
          id: 'btc',
          symbol: 'BTCUSDT',
          displaySymbol: 'BTC/USDT',
          name: 'Bitcoin',
          category: 'crypto',
          price: 63000,
          changePercent: 1,
          pricePrecision: 2,
          source: 'api',
        }}
        onPress={jest.fn()}
      />,
    );
    const row = rowRenderer.root.find(
      node =>
        node.props.accessibilityRole === 'button' &&
        typeof node.props.style === 'function',
    );
    expect(StyleSheet.flatten(row.props.style({pressed: true})).opacity).toBeLessThan(1);
    act(() => rowRenderer.unmount());
  });

  it('keeps form actions tappable and dismisses the keyboard during scroll', () => {
    const renderer = render(<AppScreen>content</AppScreen>);
    const scroller = renderer.root.findByType(ScrollView);
    expect(scroller.props.keyboardShouldPersistTaps).toBe('handled');
    expect(['interactive', 'on-drag']).toContain(scroller.props.keyboardDismissMode);
    act(() => renderer.unmount());
  });
});
