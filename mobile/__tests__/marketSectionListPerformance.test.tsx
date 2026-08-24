import React from 'react';
import {Platform, SectionList} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import MarketSectionList from '../src/components/markets/MarketSectionList';

describe('MarketSectionList virtualization', () => {
  it('keeps large catalogs windowed instead of eagerly mounting every row', () => {
    const items = Array.from({length: 120}, (_, index) => ({
      id: `market-${index}`,
      symbol: `STOCK${index}`,
      displaySymbol: `STOCK${index}`,
      name: `Stock ${index}`,
      category: 'stock' as const,
      price: 100 + index,
      changePercent: 1,
      pricePrecision: 2,
      source: 'api' as const,
    }));
    let renderer!: ReactTestRenderer.ReactTestRenderer;

    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketSectionList
          sections={[{key: 'stock', title: '股票', items}]}
        />,
      );
    });
    const list = renderer.root.findByType(SectionList);

    expect(list.props.sections[0].data).toHaveLength(120);
    expect(list.props.initialNumToRender).toBe(12);
    expect(list.props.maxToRenderPerBatch).toBe(12);
    expect(list.props.windowSize).toBe(7);
    expect(list.props.removeClippedSubviews).toBe(Platform.OS === 'android');
    act(() => renderer.unmount());
  });
});
