import React from 'react';
import ReactTestRenderer, {act} from 'react-test-renderer';
import type {MarketInstrument} from '../src/api/market';
import TabbedMarketList, {
  selectHomeMarketRankingItems,
} from '../src/components/home/TabbedMarketList';

const mockToggle = jest.fn(async () => undefined);
const mockUseMarketFavorites = jest.fn();

jest.mock('../src/hooks/useMarketFavorites', () => ({
  useMarketFavorites: () => mockUseMarketFavorites(),
}));

function market({
  changePercent,
  displaySymbol,
  overviewRank,
  symbol,
}: {
  changePercent: number;
  displaySymbol: string;
  overviewRank?: number;
  symbol: string;
}): MarketInstrument {
  return {
    id: symbol,
    symbol,
    displaySymbol,
    name: displaySymbol,
    category: 'crypto',
    price: 100,
    changePercent,
    pricePrecision: 2,
    source: 'api',
    overviewRank,
  };
}

const markets = [
  market({symbol: 'BTCUSDT', displaySymbol: 'BTC', changePercent: 1, overviewRank: 0}),
  market({symbol: 'ETHUSDT', displaySymbol: 'ETH', changePercent: -2, overviewRank: 1}),
  market({symbol: 'RCBUSDT', displaySymbol: 'RCB', changePercent: 0, overviewRank: 2}),
  market({symbol: 'SOLUSDT', displaySymbol: 'SOL', changePercent: 5}),
];

describe('home market rankings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUseMarketFavorites.mockReturnValue({
      symbols: ['BTCUSDT'],
      loading: false,
      error: false,
      toggle: mockToggle,
    });
  });

  it('builds favorites, holdings, hot, gainers and losers from authoritative rows', () => {
    expect(
      selectHomeMarketRankingItems({
        items: markets,
        ranking: 'favorites',
        favoriteSymbols: ['ETHUSDT', 'BTCUSDT'],
        holdingSymbols: [],
      }).map(item => item.symbol),
    ).toEqual(['ETHUSDT', 'BTCUSDT']);

    expect(
      selectHomeMarketRankingItems({
        items: markets,
        ranking: 'holdings',
        favoriteSymbols: [],
        holdingSymbols: ['SOL', 'BTC'],
      }).map(item => item.symbol),
    ).toEqual(['SOLUSDT', 'BTCUSDT']);

    expect(
      selectHomeMarketRankingItems({
        items: markets,
        ranking: 'hot',
        favoriteSymbols: [],
        holdingSymbols: [],
      }).map(item => item.symbol),
    ).toEqual(['BTCUSDT', 'ETHUSDT', 'RCBUSDT', 'SOLUSDT']);

    expect(
      selectHomeMarketRankingItems({
        items: markets,
        ranking: 'gainers',
        favoriteSymbols: [],
        holdingSymbols: [],
      }).map(item => item.symbol),
    ).toEqual(['SOLUSDT', 'BTCUSDT']);

    expect(
      selectHomeMarketRankingItems({
        items: markets,
        ranking: 'losers',
        favoriteSymbols: [],
        holdingSymbols: [],
      }).map(item => item.symbol),
    ).toEqual(['ETHUSDT']);
  });

  it('switches ranking tabs and persists a star action without opening the row', () => {
    let renderer!: ReactTestRenderer.ReactTestRenderer;
    act(() => {
      renderer = ReactTestRenderer.create(
        <TabbedMarketList holdingSymbols={['SOL']} items={markets} />,
      );
    });

    const tabs = renderer.root.findAll(
      node =>
        node.props.accessibilityRole === 'tab' &&
        node.parent?.props.accessibilityRole !== 'tab',
    );
    expect(tabs).toHaveLength(5);

    act(() => tabs[0].props.onPress());
    expect(JSON.stringify(renderer.toJSON())).toContain('BTC');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('ETH');

    const favoriteButton = renderer.root.findByProps({
      accessibilityLabel: '从自选移除 BTC',
    });
    const stopPropagation = jest.fn();
    act(() => favoriteButton.props.onPress({stopPropagation}));
    expect(stopPropagation).toHaveBeenCalledTimes(1);
    expect(mockToggle).toHaveBeenCalledWith('BTCUSDT');

    act(() => tabs[1].props.onPress());
    expect(JSON.stringify(renderer.toJSON())).toContain('SOL');
    expect(JSON.stringify(renderer.toJSON())).not.toContain('BTC');

    act(() => renderer.unmount());
  });
});
