import type {
  ContractMarketViewDetail,
  ContractQuoteDisplayStatus,
} from '@/lib/api/modules/contract';

export type ContractMarketViewAuthorityState =
  | 'loading'
  | 'live'
  | 'pre_market'
  | 'after_hours'
  | 'closed'
  | 'holiday'
  | 'unavailable';

export type ContractMarketViewAuthority = {
  displayPrice: number | null;
  displayState: string | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  executionBid: number | null;
  executionAsk: number | null;
  executable: boolean | null;
  reasonCode: string | null;
};

export type ContractMarketViewAuthorityPresentation = {
  state: ContractMarketViewAuthorityState;
  status: ContractQuoteDisplayStatus;
  isLoading: boolean;
  isRealtime: boolean;
  isTradable: boolean;
  reason: string;
};

function toPositiveNumber(value?: string | number | null) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  const numberValue = Number(normalized);
  return Number.isFinite(numberValue) && numberValue > 0 ? numberValue : null;
}

function toNonNegativeNumber(value?: string | number | null) {
  if (value === undefined || value === null || value === '') return null;
  const normalized = typeof value === 'string' ? value.replace(/,/g, '').trim() : value;
  const numberValue = Number(normalized);
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : null;
}

export function normalizeContractMarketViewDisplayState(value?: string | null) {
  const normalized = String(value || '').trim().toUpperCase();
  return normalized || null;
}

export function readContractMarketViewAuthority(
  marketView?: ContractMarketViewDetail | null,
): ContractMarketViewAuthority {
  return {
    displayPrice: toPositiveNumber(marketView?.display_price),
    displayState: normalizeContractMarketViewDisplayState(marketView?.display_state),
    bestBid: toPositiveNumber(marketView?.best_bid),
    bestAsk: toPositiveNumber(marketView?.best_ask),
    spread: toNonNegativeNumber(marketView?.spread),
    executionBid: toPositiveNumber(marketView?.execution_bid),
    executionAsk: toPositiveNumber(marketView?.execution_ask),
    executable: typeof marketView?.executable === 'boolean' ? marketView.executable : null,
    reasonCode: String(marketView?.reason_code || '').trim() || null,
  };
}

export function resolveContractMarketViewAuthorityPresentation({
  marketView,
  loading = false,
}: {
  marketView?: ContractMarketViewDetail | null;
  loading?: boolean;
}): ContractMarketViewAuthorityPresentation {
  const authority = readContractMarketViewAuthority(marketView);
  const displayState = authority.displayState;

  if (!marketView || displayState === 'LOADING') {
    if (loading || displayState === 'LOADING') {
      return {
        state: 'loading',
        status: 'LOADING',
        isLoading: true,
        isRealtime: false,
        isTradable: false,
        reason: 'MARKET_VIEW_LOADING',
      };
    }
    return {
      state: 'unavailable',
      status: 'UNAVAILABLE',
      isLoading: false,
      isRealtime: false,
      isTradable: false,
      reason: 'MARKET_VIEW_UNAVAILABLE',
    };
  }

  if (displayState === 'PRE_MARKET') {
    return nonTradingPresentation('pre_market', displayState);
  }
  if (displayState === 'AFTER_HOURS') {
    return nonTradingPresentation('after_hours', displayState);
  }
  if (
    displayState === 'CLOSED'
    || displayState === 'MARKET_CLOSED'
    || displayState === 'CLOSED_LAST_GOOD_TRADABLE'
    || displayState === 'CLOSED_LAST_GOOD_DISPLAY_ONLY'
  ) {
    return nonTradingPresentation('closed', displayState);
  }
  if (displayState === 'HOLIDAY') {
    return nonTradingPresentation('holiday', displayState);
  }

  const liveState = displayState === 'LIVE_TRADABLE'
    || displayState === 'REGULAR_OPEN';
  const hasExecutableBbo = authority.executionBid !== null
    && authority.executionAsk !== null
    && authority.executionAsk >= authority.executionBid;
  if (
    liveState
    && authority.displayPrice !== null
    && authority.executable === true
    && hasExecutableBbo
  ) {
    return {
      state: 'live',
      status: 'LIVE',
      isLoading: false,
      isRealtime: true,
      isTradable: true,
      reason: `MARKET_VIEW_${displayState}`,
    };
  }

  return {
    state: 'unavailable',
    status: 'UNAVAILABLE',
    isLoading: false,
    isRealtime: false,
    isTradable: false,
    reason: `MARKET_VIEW_${displayState || 'UNAVAILABLE'}`,
  };
}

export function shouldExposeContractMarketDepth(
  presentation: ContractMarketViewAuthorityPresentation,
) {
  return presentation.state === 'live'
    || presentation.state === 'pre_market'
    || presentation.state === 'after_hours';
}

function nonTradingPresentation(
  state: Exclude<ContractMarketViewAuthorityState, 'loading' | 'live' | 'unavailable'>,
  displayState: string,
): ContractMarketViewAuthorityPresentation {
  return {
    state,
    status: 'UNAVAILABLE',
    isLoading: false,
    isRealtime: false,
    isTradable: false,
    reason: `MARKET_VIEW_${displayState}`,
  };
}
