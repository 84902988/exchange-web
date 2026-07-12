import {
  createInitialSpotPublicMarketStoreState,
  ingestDepth,
  ingestKlineCurrent,
  ingestSnapshot,
  ingestTicker,
  ingestTrade,
  updateTransportState,
} from './spotMarketStore.reducer';
import type {
  SpotDepthSnapshot,
  SpotKlineCurrentSnapshot,
  SpotMarketSnapshotInput,
  SpotMarketStoreDebugState,
  SpotMarketStoreDebugSymbolState,
  SpotPublicMarketDomain,
  SpotPublicMarketEquality,
  SpotPublicMarketSelector,
  SpotPublicMarketSelectorListener,
  SpotPublicMarketStoreListener,
  SpotPublicMarketStoreState,
  SpotTickerSnapshot,
  SpotTradesSnapshot,
  SubscriptionInterest,
  SubscriptionInterestHandle,
  SubscriptionInterestInput,
  TransportStatePatch,
} from './spotMarketStore.types';

function normalizeSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeInterval(value: unknown): string | null {
  const interval = String(value ?? '').trim();
  return interval || null;
}

function normalizeDomains(domains: readonly SpotPublicMarketDomain[]): SpotPublicMarketDomain[] {
  return Array.from(new Set(domains));
}

function buildInterestKey(
  symbol: string,
  domain: SpotPublicMarketDomain,
  interval: string | null,
): string {
  return domain === 'kline'
    ? `${symbol}:${domain}:${interval ?? ''}`
    : `${symbol}:${domain}`;
}

function getInterestKeys(
  symbol: string,
  domains: readonly SpotPublicMarketDomain[],
  interval: string | null,
): string[] {
  return domains.map((domain) => buildInterestKey(symbol, domain, interval));
}

function incrementRefCounts(
  current: Record<string, number>,
  keys: readonly string[],
): Record<string, number> {
  const next = { ...current };
  for (const key of keys) next[key] = (next[key] ?? 0) + 1;
  return next;
}

function decrementRefCounts(
  current: Record<string, number>,
  keys: readonly string[],
): Record<string, number> {
  const next = { ...current };
  for (const key of keys) {
    const remaining = (next[key] ?? 0) - 1;
    if (remaining > 0) next[key] = remaining;
    else delete next[key];
  }
  return next;
}

export class SpotPublicMarketStore {
  private state: SpotPublicMarketStoreState;
  private listeners = new Set<SpotPublicMarketStoreListener>();
  private interestSequence = 0;

  constructor(initialState: SpotPublicMarketStoreState = createInitialSpotPublicMarketStoreState()) {
    this.state = initialState;
  }

  getState(): SpotPublicMarketStoreState {
    return this.state;
  }

  subscribe(listener: SpotPublicMarketStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  select<TSelected>(selector: SpotPublicMarketSelector<TSelected>): TSelected {
    return selector(this.state);
  }

  subscribeSelector<TSelected>(
    selector: SpotPublicMarketSelector<TSelected>,
    listener: SpotPublicMarketSelectorListener<TSelected>,
    equality: SpotPublicMarketEquality<TSelected> = Object.is,
  ): () => void {
    let selected = selector(this.state);
    return this.subscribe((state) => {
      const nextSelected = selector(state);
      if (equality(selected, nextSelected)) return;
      const previousSelected = selected;
      selected = nextSelected;
      listener(nextSelected, previousSelected);
    });
  }

  acquireInterest(input: SubscriptionInterestInput): SubscriptionInterestHandle {
    const owner = String(input.owner ?? '').trim();
    const symbol = normalizeSymbol(input.symbol);
    const domains = normalizeDomains(input.domains);
    const interval = normalizeInterval(input.interval);

    if (!owner) throw new Error('Spot market subscription owner is required');
    if (!symbol) throw new Error('Spot market subscription symbol is required');
    if (!domains.length) throw new Error('At least one spot market domain is required');
    if (domains.includes('kline') && !interval) {
      throw new Error('Spot kline subscription interval is required');
    }

    const id = `spot-market-interest-${++this.interestSequence}`;
    const keys = getInterestKeys(symbol, domains, interval);
    const interest: SubscriptionInterest = {
      id,
      owner,
      symbol,
      domains,
      interval,
      keys,
      createdAtMs: Date.now(),
    };

    this.replaceState({
      ...this.state,
      interests: {
        ...this.state.interests,
        [id]: interest,
      },
      interestRefCounts: incrementRefCounts(this.state.interestRefCounts, keys),
      version: this.state.version + 1,
    });

    let released = false;
    return {
      id,
      interest,
      release: () => {
        if (released) return false;
        released = true;
        return this.releaseInterest(id);
      },
    };
  }

  releaseInterest(interestId: string): boolean {
    const interest = this.state.interests[interestId];
    if (!interest) return false;

    const interests = { ...this.state.interests };
    delete interests[interestId];
    this.replaceState({
      ...this.state,
      interests,
      interestRefCounts: decrementRefCounts(this.state.interestRefCounts, interest.keys),
      version: this.state.version + 1,
    });
    return true;
  }

  ingestSnapshot(input: SpotMarketSnapshotInput): void {
    this.replaceState(ingestSnapshot(this.state, input));
  }

  ingestTicker(snapshot: SpotTickerSnapshot): void {
    this.replaceState(ingestTicker(this.state, snapshot));
  }

  ingestDepth(snapshot: SpotDepthSnapshot): void {
    this.replaceState(ingestDepth(this.state, snapshot));
  }

  ingestTrade(snapshot: SpotTradesSnapshot): void {
    this.replaceState(ingestTrade(this.state, snapshot));
  }

  ingestKlineCurrent(snapshot: SpotKlineCurrentSnapshot): void {
    this.replaceState(ingestKlineCurrent(this.state, snapshot));
  }

  updateTransport(patch: TransportStatePatch): void {
    this.replaceState(updateTransportState(this.state, patch));
  }

  /** @internal Test isolation only. */
  resetForTests(): void {
    this.interestSequence = 0;
    this.replaceState(createInitialSpotPublicMarketStoreState());
  }

  private replaceState(nextState: SpotPublicMarketStoreState): void {
    if (nextState === this.state) return;
    const previousState = this.state;
    this.state = nextState;
    for (const listener of this.listeners) listener(nextState, previousState);
  }
}

export function createSpotPublicMarketStore(
  initialState?: SpotPublicMarketStoreState,
): SpotPublicMarketStore {
  return new SpotPublicMarketStore(initialState);
}

export const spotPublicMarketStore = createSpotPublicMarketStore();

function getSlotLastEventTime(
  acceptedEventTimeMs: number | null,
  acceptedReceivedAtMs: number | null,
): number | null {
  const candidates = [acceptedEventTimeMs, acceptedReceivedAtMs]
    .filter((value): value is number => Number.isFinite(value) && Number(value) > 0);
  return candidates.length ? Math.max(...candidates) : null;
}

/** @internal Unit-test diagnostics only. This is not exposed through any production API. */
export function getSpotMarketStoreDebugState(
  store: SpotPublicMarketStore = spotPublicMarketStore,
): SpotMarketStoreDebugState {
  const state = store.getState();
  const domainSnapshots: Record<string, SpotMarketStoreDebugSymbolState> = {};
  let currentSymbol: string | null = null;
  let currentSymbolAccessTime = -1;
  let lastEventTimeMs: number | null = null;

  for (const [symbol, symbolState] of Object.entries(state.symbols)) {
    const klineCurrentByInterval: SpotMarketStoreDebugSymbolState['klineCurrentByInterval'] = {};
    const eventTimes = [
      getSlotLastEventTime(
        symbolState.ticker.acceptedEventTimeMs,
        symbolState.ticker.acceptedReceivedAtMs,
      ),
      getSlotLastEventTime(
        symbolState.depth.acceptedEventTimeMs,
        symbolState.depth.acceptedReceivedAtMs,
      ),
      getSlotLastEventTime(
        symbolState.trades.acceptedEventTimeMs,
        symbolState.trades.acceptedReceivedAtMs,
      ),
    ];

    for (const [interval, slot] of Object.entries(symbolState.klineByInterval)) {
      klineCurrentByInterval[interval] = slot.snapshot;
      eventTimes.push(getSlotLastEventTime(slot.acceptedEventTimeMs, slot.acceptedReceivedAtMs));
    }

    const symbolEventTimes = eventTimes.filter(
      (value): value is number => Number.isFinite(value) && Number(value) > 0,
    );
    const symbolLastEventTimeMs = symbolEventTimes.length ? Math.max(...symbolEventTimes) : null;
    if (symbolLastEventTimeMs !== null) {
      lastEventTimeMs = lastEventTimeMs === null
        ? symbolLastEventTimeMs
        : Math.max(lastEventTimeMs, symbolLastEventTimeMs);
    }

    domainSnapshots[symbol] = {
      ticker: symbolState.ticker.snapshot,
      depth: symbolState.depth.snapshot,
      trades: symbolState.trades.snapshot,
      klineCurrentByInterval,
      lastEventTimeMs: symbolLastEventTimeMs,
    };

    if (symbolState.lastAccessedAtMs >= currentSymbolAccessTime) {
      currentSymbol = symbol;
      currentSymbolAccessTime = symbolState.lastAccessedAtMs;
    }
  }

  return {
    currentSymbol,
    domainSnapshots,
    lastEventTimeMs,
    subscriptionCount: Object.keys(state.interests).length,
    interestRefCounts: { ...state.interestRefCounts },
    transport: { ...state.transport },
  };
}

export type {
  SpotDomainSlot,
  SpotPublicMarketStoreState,
  SubscriptionInterest,
  TransportState,
} from './spotMarketStore.types';
