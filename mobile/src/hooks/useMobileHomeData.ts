import {startTransition, useCallback, useRef, useState} from 'react';
import {useFocusEffect} from '@react-navigation/native';
import {
  getCachedMobileContent,
  loadMobileContentBootstrap,
  type MobileContentSnapshot,
} from '../api/mobileContent';
import {
  fetchMobileMarkets,
  getCachedMobileMarkets,
  type MarketInstrument,
} from '../api/market';
import {defaultLocale} from '../i18n';
import {useApplicationActive} from './useApplicationState';

export const MOBILE_HOME_MARKET_REFRESH_MS = 5_000;

export type MobileHomeDataState = {
  content: MobileContentSnapshot | null;
  markets: MarketInstrument[];
  contentLoading: boolean;
  marketsLoading: boolean;
  contentError: string | null;
  marketsError: string | null;
};

export function useMobileHomeData(locale = defaultLocale) {
  const applicationActive = useApplicationActive();
  const generationRef = useRef(0);
  const [state, setState] = useState<MobileHomeDataState>(() =>
    initialMobileHomeDataState(locale),
  );

  useFocusEffect(
    useCallback(() => {
      if (!applicationActive) {
        return undefined;
      }
      const generation = ++generationRef.current;
      let active = true;
      const cachedContent = safeGetCachedContent(locale);
      const cachedMarkets = getCachedMobileMarkets();

      setState(() => {
        const nextContent = cachedContent;
        const nextMarkets = cachedMarkets;
        return {
          content: nextContent,
          markets: nextMarkets,
          contentLoading: !nextContent,
          marketsLoading: nextMarkets.length === 0,
          contentError: null,
          marketsError: null,
        };
      });

      Promise.resolve()
        .then(() => loadMobileContentBootstrap({locale}))
        .then(result => {
          if (!active || generation !== generationRef.current) {
            return;
          }
          startTransition(() => {
            setState(previous => ({
              ...previous,
              content: result.snapshot,
              contentLoading: false,
              contentError: result.error,
            }));
          });
        })
        .catch(() => {
          if (!active || generation !== generationRef.current) {
            return;
          }
          startTransition(() => {
            setState(previous => ({
              ...previous,
              content: null,
              contentLoading: false,
              contentError: '首页内容暂时不可用，请稍后重试。',
            }));
          });
        });

      let marketRefreshInFlight = false;
      const refreshMarkets = () => {
        if (marketRefreshInFlight) return;
        marketRefreshInFlight = true;
        Promise.resolve()
          .then(fetchMobileMarkets)
          .then(markets => {
            if (!active || generation !== generationRef.current) {
              return;
            }
            startTransition(() => {
              setState(previous => ({
                ...previous,
                markets,
                marketsLoading: false,
                marketsError: null,
              }));
            });
          })
          .catch(() => {
            if (!active || generation !== generationRef.current) {
              return;
            }
            startTransition(() => {
              setState(previous => ({
                ...previous,
                markets: [],
                marketsLoading: false,
                marketsError: '行情暂时不可用，请稍后重试。',
              }));
            });
          })
          .finally(() => {
            marketRefreshInFlight = false;
          });
      };

      refreshMarkets();
      const marketRefreshTimer = setInterval(
        refreshMarkets,
        MOBILE_HOME_MARKET_REFRESH_MS,
      );

      return () => {
        active = false;
        clearInterval(marketRefreshTimer);
        if (generationRef.current === generation) {
          generationRef.current += 1;
        }
      };
    }, [applicationActive, locale]),
  );

  return state;
}

function initialMobileHomeDataState(locale: string): MobileHomeDataState {
  const content = safeGetCachedContent(locale);
  const markets = getCachedMobileMarkets();
  return {
    content,
    markets,
    contentLoading: !content,
    marketsLoading: markets.length === 0,
    contentError: null,
    marketsError: null,
  };
}

function safeGetCachedContent(locale: string) {
  try {
    return getCachedMobileContent(locale);
  } catch {
    return null;
  }
}
