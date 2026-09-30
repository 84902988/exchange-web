import { useEffect, useState } from 'react';
import { fetchMobileMarkets, getCachedMobileMarkets } from '../api/market';
import {
  fetchContractTradingCatalog,
  getCachedContractTradingCatalog,
} from '../api/tradingCatalog';
import { normalizeLogoUrl } from '../navigation/tradingRoute';

type Market = 'spot' | 'contract';
type LogoMetadata = { symbol: string; logoUrl?: string | null };

function findLogo(items: LogoMetadata[], symbol: string) {
  return normalizeLogoUrl(items.find(item => item.symbol === symbol)?.logoUrl);
}

function spotMetadata(items: ReturnType<typeof getCachedMobileMarkets>) {
  return items
    .filter(
      item =>
        item.tradeMarket === 'spot' ||
        (!item.tradeMarket && item.category === 'crypto'),
    )
    .map(item => ({
      symbol: item.tradeSymbol || item.symbol,
      logoUrl: item.logoUrl,
    }));
}

// Catalog data supplies presentation metadata only. It must never replace the
// route's instrument identity or live market/execution state.
export function useTradingMarketLogo(
  market: Market,
  symbol: string,
  routeLogoUrl: string | null | undefined,
  active: boolean,
) {
  const routeLogo = normalizeLogoUrl(routeLogoUrl);
  const key = `${market}:${symbol}`;
  const cachedLogo = findLogo(
    market === 'spot'
      ? spotMetadata(getCachedMobileMarkets())
      : getCachedContractTradingCatalog(),
    symbol,
  );
  const [loaded, setLoaded] = useState<{
    key: string;
    logoUrl: string | null;
  } | null>(null);

  useEffect(() => {
    if (!active || routeLogo) return;
    if (cachedLogo) {
      // Quote renders continue after the shared catalog TTL expires. Keep this
      // instrument's last resolved image during an offline metadata refresh.
      setLoaded({key, logoUrl: cachedLogo});
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const items =
          market === 'spot'
            ? spotMetadata(await fetchMobileMarkets())
            : await fetchContractTradingCatalog();
        if (!cancelled) setLoaded({ key, logoUrl: findLogo(items, symbol) });
      } catch {
        // A missing logo leaves the shared component's letter fallback intact.
        // It must not surface as a quote or trading error.
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [active, cachedLogo, key, market, routeLogo, symbol]);

  return (
    routeLogo || cachedLogo || (loaded?.key === key ? loaded.logoUrl : null)
  );
}
