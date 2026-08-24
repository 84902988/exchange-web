import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';

import type {MarketInstrument} from '../src/api/market';
import MarketRow from '../src/components/markets/MarketRow';

const marketOnlyItem: MarketInstrument = {
  id: 'api-XAGEURUSDT',
  symbol: 'XAGEURUSDT',
  displaySymbol: 'XAGEUR',
  name: 'XAGEUR',
  category: 'cfd',
  price: 28.4,
  changePercent: -0.2,
  pricePrecision: 2,
  source: 'api',
  tradable: false,
  tradeMarket: 'contract',
  tradeSymbol: null,
  tradeStatus: 'MARKET_DATA_ONLY',
};

describe('market row tradability', () => {
  it('does not present backend route status as a visible product category', () => {
    const onPress = jest.fn();
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <MarketRow item={marketOnlyItem} onPress={onPress} />,
      );
    });

    expect(JSON.stringify(renderer.toJSON())).not.toContain('仅行情');
    const row = renderer.root.findByProps({
      accessibilityLabel: 'XAGEUR，28.40',
    });
    expect(row.props.accessibilityRole).toBe('button');
    act(() => row.props.onPress());
    expect(onPress).toHaveBeenCalledWith(marketOnlyItem);

    act(() => renderer.unmount());
  });
});
