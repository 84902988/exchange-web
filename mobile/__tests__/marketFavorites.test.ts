import AsyncStorage from '@react-native-async-storage/async-storage';
import {branding} from '../src/config/branding';
import {
  __resetMarketFavoritesForTests,
  getCachedMarketFavoriteSymbols,
  loadMarketFavoriteSymbols,
  MARKET_FAVORITES_STORAGE_KEY,
  normalizeMarketFavoriteSymbols,
  subscribeMarketFavoriteSymbols,
  toggleMarketFavoriteSymbol,
} from '../src/services/marketFavorites';

describe('market favorite persistence', () => {
  afterEach(() => {
    branding.legacyFavoritesStorageKeys.length = 0;
  });
  it('migrates configured old favorites without overwriting a current empty list', async () => {
    branding.legacyFavoritesStorageKeys.push('example.old.favorites');
    await AsyncStorage.setItem('example.old.favorites', JSON.stringify({version: 1, symbols: ['btcusdt']}));
    await expect(loadMarketFavoriteSymbols()).resolves.toEqual(['BTCUSDT']);
    expect(JSON.parse((await AsyncStorage.getItem(MARKET_FAVORITES_STORAGE_KEY))!).symbols).toEqual(['BTCUSDT']);
    __resetMarketFavoritesForTests();
    await AsyncStorage.setItem(MARKET_FAVORITES_STORAGE_KEY, JSON.stringify({version: 1, symbols: []}));
    await expect(loadMarketFavoriteSymbols()).resolves.toEqual([]);
  });
  beforeEach(async () => {
    __resetMarketFavoritesForTests();
    await AsyncStorage.clear();
  });

  it('normalizes unique valid symbols and restores the versioned payload', async () => {
    expect(
      normalizeMarketFavoriteSymbols([' btcusdt ', 'BTCUSDT', '', '../bad']),
    ).toEqual(['BTCUSDT']);
    await AsyncStorage.setItem(
      MARKET_FAVORITES_STORAGE_KEY,
      JSON.stringify({version: 1, symbols: ['ethusdt', 'BTCUSDT']}),
    );

    await expect(loadMarketFavoriteSymbols()).resolves.toEqual([
      'ETHUSDT',
      'BTCUSDT',
    ]);
    expect(getCachedMarketFavoriteSymbols()).toEqual(['ETHUSDT', 'BTCUSDT']);
  });

  it('serializes a toggle, persists it and notifies subscribers', async () => {
    const listener = jest.fn();
    const unsubscribe = subscribeMarketFavoriteSymbols(listener);

    await loadMarketFavoriteSymbols();
    await toggleMarketFavoriteSymbol('BTCUSDT');
    expect(getCachedMarketFavoriteSymbols()).toEqual(['BTCUSDT']);
    expect(JSON.parse((await AsyncStorage.getItem(MARKET_FAVORITES_STORAGE_KEY))!)).toEqual({
      version: 1,
      symbols: ['BTCUSDT'],
    });
    expect(listener).toHaveBeenLastCalledWith(['BTCUSDT']);

    await toggleMarketFavoriteSymbol('BTCUSDT');
    expect(getCachedMarketFavoriteSymbols()).toEqual([]);
    unsubscribe();
  });
});
