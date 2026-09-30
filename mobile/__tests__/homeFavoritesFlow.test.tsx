import React from 'react';
import {TextInput} from 'react-native';
import ReactTestRenderer, {act} from 'react-test-renderer';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type {MarketInstrument} from '../src/api/market';
import TabbedMarketList from '../src/components/home/TabbedMarketList';
import MarketRow from '../src/components/common/MarketRow';
import {
  __resetMarketFavoritesForTests,
  MARKET_FAVORITES_STORAGE_KEY,
} from '../src/services/marketFavorites';

const markets: MarketInstrument[] = Array.from({length: 8}, (_, index) => ({
  id: `coin-${index}`, symbol: `COIN${index}USDT`, displaySymbol: `COIN${index}`,
  name: `Coin ${index}`, category: 'crypto', price: 1, changePercent: index,
  overviewRank: index, pricePrecision: 2, source: 'api',
}));

describe('home favorites add and manage flow', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  const onMarket = jest.fn();
  const buttons = () => renderer.root.findAll(node =>
    ['button', 'tab'].includes(node.props.accessibilityRole) &&
    node.parent?.props.accessibilityRole !== node.props.accessibilityRole,
  );
  const pressLabel = async (label: string) => {
    const button = buttons().find(node => node.props.accessibilityLabel === label)!;
    expect(button).toBeDefined();
    await act(async () => { await button.props.onPress({stopPropagation: jest.fn()}); });
  };
  const pressText = async (text: string) => {
    const button = buttons().find(node => node.findAll(child => child.props.children === text).length)!;
    expect(button).toBeDefined();
    await act(async () => { await button.props.onPress(); });
  };
  const mount = async () => {
    await act(async () => {
      renderer = ReactTestRenderer.create(<TabbedMarketList items={markets} onPress={onMarket} />);
    });
    const tab = buttons().filter(node => node.props.accessibilityRole === 'tab')[0];
    await act(async () => { tab.props.onPress(); });
  };
  beforeEach(async () => {
    jest.clearAllMocks();
    __resetMarketFavoritesForTests();
    await AsyncStorage.clear();
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    jest.restoreAllMocks();
  });

  it('adds a searched market beyond the top six, persists across remount and removes it', async () => {
    await mount();
    expect(renderer.root.findAllByType(MarketRow)).toHaveLength(0);
    await pressText('添加自选');
    await act(async () => {
      renderer.root.findByType(TextInput).props.onChangeText('coin7/usdt');
    });
    expect(renderer.root.findAllByType(MarketRow)).toHaveLength(1);
    await pressLabel('添加 COIN7 到自选');
    await pressText('完成');
    expect(renderer.root.findAllByType(MarketRow).map(row => row.props.item.symbol)).toEqual(['COIN7USDT']);
    expect(onMarket).not.toHaveBeenCalled();
    expect(JSON.parse((await AsyncStorage.getItem(MARKET_FAVORITES_STORAGE_KEY))!).symbols).toEqual(['COIN7USDT']);

    act(() => renderer.unmount());
    __resetMarketFavoritesForTests();
    await mount();
    expect(renderer.root.findAllByType(MarketRow)[0].props.item.symbol).toBe('COIN7USDT');
    // The star and trading row are siblings, not nested press targets.
    const star = buttons().find(node => node.props.accessibilityLabel === '从自选移除 COIN7')!;
    expect(star.parent?.props.onPress).toBeUndefined();
    await pressLabel('从自选移除 COIN7');
    expect(onMarket).not.toHaveBeenCalled();
    expect(renderer.root.findAllByType(MarketRow)).toHaveLength(0);
    expect(JSON.parse((await AsyncStorage.getItem(MARKET_FAVORITES_STORAGE_KEY))!).symbols).toEqual([]);
  });

  it('shows a failed save inside the picker and permits retry without a false selected state', async () => {
    await mount();
    await pressText('添加自选');
    jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk full'));
    await pressLabel('添加 COIN0 到自选');
    expect(renderer.root.findAll(node => node.props.accessibilityRole === 'alert').length).toBeGreaterThan(0);
    expect(buttons().find(node => node.props.accessibilityLabel === '添加 COIN0 到自选')?.props.accessibilityState.selected).toBe(false);
    await pressLabel('添加 COIN0 到自选');
    expect(buttons().find(node => node.props.accessibilityLabel === '从自选移除 COIN0')?.props.accessibilityState.selected).toBe(true);
    expect(renderer.root.findAll(node => node.props.accessibilityRole === 'alert')).toHaveLength(0);
  });

  it('shows all saved favorites instead of truncating them to six', async () => {
    await AsyncStorage.setItem(MARKET_FAVORITES_STORAGE_KEY, JSON.stringify({version: 1, symbols: markets.map(item => item.symbol)}));
    await mount();
    expect(renderer.root.findAllByType(MarketRow)).toHaveLength(8);
    await pressText('管理自选');
    expect(renderer.root.findByType(TextInput)).toBeDefined();
  });
});
