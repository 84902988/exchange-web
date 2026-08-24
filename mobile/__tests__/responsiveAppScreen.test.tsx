import React from 'react';
import {ScrollView, StyleSheet} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';

let mockWindowMetrics = {
  fontScale: 1,
  height: 568,
  width: 320,
  scale: 2,
};

jest.mock(
  'react-native/Libraries/Utilities/useWindowDimensions',
  () => ({
    __esModule: true,
    default: () => mockWindowMetrics,
  }),
);

import AppScreen from '../src/components/common/AppScreen';

describe('AppScreen responsive content container', () => {
  it('uses compact phone gutters and centers bounded tablet content after resize', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(<AppScreen>content</AppScreen>);
    });

    let contentStyle = StyleSheet.flatten(
      renderer.root.findByType(ScrollView).props.contentContainerStyle,
    );
    expect(contentStyle).toMatchObject({
      alignSelf: 'center',
      maxWidth: 720,
      paddingHorizontal: 12,
      width: '100%',
    });

    mockWindowMetrics = {
      fontScale: 1,
      height: 1024,
      width: 768,
      scale: 2,
    };
    act(() => {
      renderer.update(
        <AppScreen contentWidth="dashboard">content</AppScreen>,
      );
    });
    contentStyle = StyleSheet.flatten(
      renderer.root.findByType(ScrollView).props.contentContainerStyle,
    );
    expect(contentStyle).toMatchObject({
      alignSelf: 'center',
      maxWidth: 960,
      paddingHorizontal: 24,
      width: '100%',
    });

    act(() => renderer.unmount());
  });
});
