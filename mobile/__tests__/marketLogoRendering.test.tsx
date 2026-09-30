import React from 'react';
import {Image, StyleSheet, View} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {SvgCssUri} from 'react-native-svg/css';
import MarketLogo from '../src/components/markets/MarketLogo';

jest.mock('react-native-svg/css', () => ({SvgCssUri: () => null}));

describe('market logo fitting and source lifecycle', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  afterEach(() => { act(() => renderer?.unmount()); });

  function expectCircularMask(diameter: number) {
    const masks = renderer.root.findAllByType(View).filter(view => {
      const style = StyleSheet.flatten(view.props.style);
      return style?.overflow === 'hidden' && style.width === diameter;
    });
    expect(masks).toHaveLength(1);
    expect(StyleSheet.flatten(masks[0].props.style)).toMatchObject({
      width: diameter,
      height: diameter,
      borderRadius: diameter / 2,
    });
  }

  it.each([24, 30, 34])('contains raster artwork inside a circular mask at size %s', size => {
    act(() => { renderer = ReactTestRenderer.create(<MarketLogo label="TEST" logoUrl="https://example.com/wide.png" size={size} />); });
    const logo = renderer.root.findByType(Image);
    const style = StyleSheet.flatten(logo.props.style);
    expect(style.resizeMode).toBe('contain');
    expect(style.width).toBe(size - 4);
    expect(style.height).toBe(size - 4);
    expectCircularMask(size - 4);
  });

  it('keeps the SVG request stable on rerender and fits the full viewBox', () => {
    act(() => { renderer = ReactTestRenderer.create(<MarketLogo label="TEST" logoUrl="https://example.com/icon.svg" />); });
    const initial = renderer.root.findByType(SvgCssUri).props;
    expect(initial.preserveAspectRatio).toBe('xMidYMid meet');
    expectCircularMask(26);
    act(() => { renderer.update(<MarketLogo label="TEST" logoUrl="https://example.com/icon.svg" size={34} />); });
    expect(renderer.root.findByType(SvgCssUri).props.onError).toBe(initial.onError);
    expectCircularMask(30);
  });

  it('recovers after a failed source and ignores late errors from the previous SVG', () => {
    act(() => { renderer = ReactTestRenderer.create(<MarketLogo label="TEST" logoUrl="https://example.com/old.svg" />); });
    const oldError = renderer.root.findByType(SvgCssUri).props.onError;
    act(() => oldError(new Error('offline')));
    expect(renderer.root.findAllByType(SvgCssUri)).toHaveLength(0);
    act(() => { renderer.update(<MarketLogo label="TEST" logoUrl="https://example.com/new.svg" />); });
    act(() => oldError(new Error('late response')));
    expect(renderer.root.findByType(SvgCssUri).props.uri).toBe('https://example.com/new.svg');
  });
});
