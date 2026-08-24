import React from 'react';
import {StyleSheet, Text} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

import ResponsiveTabBarButton from '../src/components/navigation/ResponsiveTabBarButton';
import {__resetMainTabTransitionBudgetForTests} from '../src/performance/mainTabTransitionBudget';

describe('ResponsiveTabBarButton', () => {
  afterEach(() => {
    __resetMainTabTransitionBudgetForTests();
  });
  it('dispatches from the discrete press event', () => {
    const onPress = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <ResponsiveTabBarButton onPress={onPress}>
          <Text>行情</Text>
        </ResponsiveTabBarButton>,
      );
    });
    const button = renderer.root.findByProps({accessibilityRole: 'button'});
    const event = {};

    act(() => button.props.onPress(event));
    expect(onPress).toHaveBeenCalledTimes(1);

    const pressedStyle = StyleSheet.flatten(
      button.props.style({pressed: true}),
    );
    expect(pressedStyle.opacity).toBe(0.72);
    expect(pressedStyle.transform).toEqual([{scale: 0.97}]);
    act(() => renderer.unmount());
  });

  it('forwards the tab test id and press event', () => {
    const onPress = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <ResponsiveTabBarButton onPress={onPress} testID="assets-tab">
          <Text>资产</Text>
        </ResponsiveTabBarButton>,
      );
    });

    act(() => renderer.root.findByProps({testID: 'assets-tab'}).props.onPress({}));
    expect(onPress).toHaveBeenCalledTimes(1);
    act(() => renderer.unmount());
  });
});
