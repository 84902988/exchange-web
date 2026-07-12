import type {
  DomainSnapshot,
  DomainSnapshotMetadata,
} from '@/components/spot/spotDomainSnapshot';
import type {
  SpotDepthResponse,
  SpotMarketKlineItem,
  SpotMarketTickerItem,
  SpotMarketTradeItem,
} from '@/lib/api/modules/spot';

export type SpotPublicMarketDomain = 'ticker' | 'depth' | 'trades' | 'kline';

export type SpotDomainLifecycle =
  | 'idle'
  | 'hydrating'
  | 'ready'
  | 'stale'
  | 'missing'
  | 'error';

export type SpotTransportStatus = 'idle' | 'connecting' | 'open' | 'closed';

export interface TransportState {
  status: SpotTransportStatus;
  generation: number;
  connectedAtMs: number | null;
  disconnectedAtMs: number | null;
  lastMessageAtMs: number | null;
  reconnectAttempt: number;
  error: string | null;
}

export interface SpotDomainSlot<TData> {
  snapshot: DomainSnapshot<TData> | null;
  lifecycle: SpotDomainLifecycle;
  generation: number;
  acceptedEventTimeMs: number | null;
  acceptedReceivedAtMs: number | null;
  retiredProviders: readonly string[];
  error: string | null;
}

export interface SpotKlineCurrentSlot extends SpotDomainSlot<SpotMarketKlineItem> {
  interval: string;
  lastOpenTime: number | null;
  revisionEpoch: number | null;
  revisionSequence: number | null;
  sequence: number | null;
  isClosed: boolean | null;
}

export interface SpotSymbolMarketState {
  symbol: string;
  ticker: SpotDomainSlot<SpotMarketTickerItem>;
  depth: SpotDomainSlot<SpotDepthResponse>;
  trades: SpotDomainSlot<SpotMarketTradeItem[]>;
  klineByInterval: Record<string, SpotKlineCurrentSlot>;
  lastAccessedAtMs: number;
}

export interface SubscriptionInterest {
  id: string;
  owner: string;
  symbol: string;
  domains: readonly SpotPublicMarketDomain[];
  interval: string | null;
  keys: readonly string[];
  createdAtMs: number;
}

export interface SubscriptionInterestInput {
  owner: string;
  symbol: string;
  domains: readonly SpotPublicMarketDomain[];
  interval?: string | null;
}

export interface SubscriptionInterestHandle {
  id: string;
  interest: SubscriptionInterest;
  release: () => boolean;
}

export interface SpotPublicMarketStoreState {
  transport: TransportState;
  symbols: Record<string, SpotSymbolMarketState>;
  interests: Record<string, SubscriptionInterest>;
  interestRefCounts: Record<string, number>;
  version: number;
}

export type TransportStatePatch = Partial<Omit<TransportState, 'generation'>> & {
  generation?: number;
};

export interface SpotMarketSnapshotInput {
  ticker?: DomainSnapshot<SpotMarketTickerItem> | null;
  depth?: DomainSnapshot<SpotDepthResponse> | null;
  trades?: DomainSnapshot<SpotMarketTradeItem[]> | null;
  klineCurrent?: DomainSnapshot<SpotMarketKlineItem> | null;
}

export type SpotTickerSnapshot = DomainSnapshot<SpotMarketTickerItem>;
export type SpotDepthSnapshot = DomainSnapshot<SpotDepthResponse>;
export type SpotTradesSnapshot = DomainSnapshot<SpotMarketTradeItem[]>;
export type SpotKlineCurrentSnapshot = DomainSnapshot<SpotMarketKlineItem>;

export type SpotPublicMarketStoreListener = (
  state: SpotPublicMarketStoreState,
  previousState: SpotPublicMarketStoreState,
) => void;

export type SpotPublicMarketSelector<TSelected> = (
  state: SpotPublicMarketStoreState,
) => TSelected;

export type SpotPublicMarketSelectorListener<TSelected> = (
  selected: TSelected,
  previousSelected: TSelected,
) => void;

export type SpotPublicMarketEquality<TSelected> = (
  left: TSelected,
  right: TSelected,
) => boolean;

export interface SpotMarketStoreDebugSymbolState {
  ticker: DomainSnapshot<SpotMarketTickerItem> | null;
  depth: DomainSnapshot<SpotDepthResponse> | null;
  trades: DomainSnapshot<SpotMarketTradeItem[]> | null;
  klineCurrentByInterval: Record<string, DomainSnapshot<SpotMarketKlineItem> | null>;
  lastEventTimeMs: number | null;
}

export interface SpotMarketStoreDebugState {
  currentSymbol: string | null;
  domainSnapshots: Record<string, SpotMarketStoreDebugSymbolState>;
  lastEventTimeMs: number | null;
  subscriptionCount: number;
  interestRefCounts: Record<string, number>;
  transport: TransportState;
}

export type SpotSnapshotMetadata = DomainSnapshotMetadata;
