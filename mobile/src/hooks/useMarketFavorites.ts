import {useCallback, useEffect, useState} from 'react';
import {
  getCachedMarketFavoriteSymbols,
  hasLoadedMarketFavoriteSymbols,
  loadMarketFavoriteSymbols,
  subscribeMarketFavoriteSymbols,
  toggleMarketFavoriteSymbol,
} from '../services/marketFavorites';

export function useMarketFavorites() {
  const [symbols, setSymbols] = useState(() =>
    getCachedMarketFavoriteSymbols(),
  );
  const [loading, setLoading] = useState(
    () => !hasLoadedMarketFavoriteSymbols(),
  );
  const [error, setError] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = subscribeMarketFavoriteSymbols(nextSymbols => {
      if (active) setSymbols(nextSymbols);
    });
    loadMarketFavoriteSymbols()
      .then(nextSymbols => {
        if (!active) return;
        setSymbols(nextSymbols);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setLoading(false);
        setError(true);
      });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  const toggle = useCallback(async (symbol: string) => {
    setError(false);
    try {
      await toggleMarketFavoriteSymbol(symbol);
    } catch {
      setError(true);
    }
  }, []);

  return {symbols, loading, error, toggle};
}
