import type { SpotMarketConnectionStatus } from '@/services/marketRealtime';

export type SpotMarketHydrationInput = {
  price?: string | number | null;
  source?: string | null;
  restLoading: boolean;
  connectionStatus: SpotMarketConnectionStatus;
};

export type SpotMarketHydrationState = {
  hasValidPrice: boolean;
  hasLivePrice: boolean;
  isHydrating: boolean;
  isUnavailable: boolean;
};

function hasValidSpotPrice(value?: string | number | null) {
  if (value === null || value === undefined) return false;
  const normalized = String(value).replace(/,/g, '').trim();
  if (!normalized || normalized === '--') return false;
  const price = Number(normalized);
  return Number.isFinite(price) && price > 0;
}

export function resolveSpotMarketHydration(
  input: SpotMarketHydrationInput,
): SpotMarketHydrationState {
  const hasValidPrice = hasValidSpotPrice(input.price);
  const hasLivePrice = hasValidPrice && String(input.source || '').trim().toUpperCase() === 'LIVE_WS';
  const restUnavailable = !input.restLoading && !hasValidPrice;
  const websocketUnavailable = input.connectionStatus === 'closed';
  const isUnavailable = restUnavailable && websocketUnavailable;
  const isHydrating = (
    !hasLivePrice
    && !isUnavailable
    && (input.restLoading || input.connectionStatus !== 'closed')
  );

  return {
    hasValidPrice,
    hasLivePrice,
    isHydrating,
    isUnavailable,
  };
}
