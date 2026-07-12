import type {
  DomainCacheOrigin,
  DomainCompleteness,
  DomainFallbackReason,
  DomainFreshness,
  DomainFreshnessBasis,
  DomainName,
  DomainRevision,
  DomainSnapshot,
  DomainSource,
  DomainTransport,
} from '@/components/spot/spotDomainSnapshot';
import type {
  SpotDepthResponse,
  SpotMarketKlineItem,
  SpotMarketTickerItem,
  SpotMarketTradeItem,
} from '@/lib/api/modules/spot';
import {
  extractSpotTradeEventTimeMs,
  extractSpotTradesEventTimeMs,
} from '@/components/spot/spotMarketDomainSequencer';
import {
  applySpotTradeReceivedAtMs,
  resolveSpotTradeBatchReceivedAtMs,
  resolveSpotTradeIncrementalReceivedAtMs,
} from '@/components/spot/spotTradeRows';
import { ingestSpotTradesStoreEvent } from '@/components/spot/spotTradesStoreAdapter';
import {
  spotPublicMarketStore,
  type SpotPublicMarketStore,
} from './spotMarketStore';

type MirrorEventType = 'snapshot' | 'trade' | 'depth' | 'ticker' | 'kline';
type MirrorStatus = 'connecting' | 'open' | 'closed';

export interface SpotMarketMirrorTransport {
  subscribe: (type: MirrorEventType, handler: (message: unknown) => void) => () => void;
  subscribeStatus: (handler: (status: MirrorStatus) => void) => () => void;
}

const VALID_TRANSPORTS = new Set<DomainTransport>([
  'PROVIDER_WS',
  'PROVIDER_REST',
  'INTERNAL_EVENT',
  'DB_READ',
  'CACHE_READ',
  'NONE',
]);
const VALID_CACHE_ORIGINS = new Set<DomainCacheOrigin>([
  'NONE',
  'PROVIDER_MEMORY',
  'L1_MEMORY',
  'REDIS',
  'DATABASE',
  'LAST_GOOD_MEMORY',
  'HISTORY_BOUNDARY',
]);
const VALID_SOURCES = new Set<DomainSource>([
  'LIVE_WS',
  'REST_SNAPSHOT',
  'REST_HISTORY',
  'DB_CACHE',
  'INTERNAL',
  'LAST_GOOD',
  'MISSING',
]);
const VALID_FRESHNESS = new Set<DomainFreshness>([
  'LIVE',
  'RECENT',
  'STALE',
  'LAST_GOOD',
  'MISSING',
]);
const VALID_FALLBACK_REASONS = new Set<DomainFallbackReason>([
  'WS_MISS',
  'WS_STALE',
  'PROVIDER_COOLDOWN',
  'PROVIDER_TIMEOUT',
  'PROVIDER_EMPTY',
  'PROVIDER_ERROR',
  'CACHE_MISS',
  'CACHE_STALE',
  'REDIS_DOWN',
  'HISTORY_BOUNDARY',
  'BUDGET_EXHAUSTED',
  'INVALID_DATA',
  'UNKNOWN',
]);
const VALID_FRESHNESS_BASIS = new Set<DomainFreshnessBasis>([
  'RECEIVED_AT',
  'CACHE_UPDATED_AT',
  'DB_UPDATED_AT',
  'NOT_APPLICABLE',
]);

let mirrorSnapshotSequence = 0;
const attachments = new WeakMap<object, Map<SpotPublicMarketStore, () => void>>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeSymbol(value: unknown): string {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeInterval(value: unknown): string | null {
  const interval = String(value ?? '').trim();
  return interval || null;
}

function readText(records: readonly (Record<string, unknown> | null)[], key: string): string | null {
  for (const record of records) {
    const value = String(record?.[key] ?? '').trim();
    if (value) return value;
  }
  return null;
}

function readNumber(records: readonly (Record<string, unknown> | null)[], key: string): number | null {
  for (const record of records) {
    const value = Number(record?.[key]);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

function readBoolean(records: readonly (Record<string, unknown> | null)[], key: string): boolean | null {
  for (const record of records) {
    const value = record?.[key];
    if (value === true || value === false) return value;
    if (value === 1 || value === '1' || String(value).toLowerCase() === 'true') return true;
    if (value === 0 || value === '0' || String(value).toLowerCase() === 'false') return false;
  }
  return null;
}

function readEnum<TValue extends string>(
  records: readonly (Record<string, unknown> | null)[],
  key: string,
  validValues: ReadonlySet<TValue>,
): TValue | null {
  const value = readText(records, key)?.toUpperCase() as TValue | undefined;
  return value && validValues.has(value) ? value : null;
}

function getCompleteness(domain: DomainName, data: unknown): DomainCompleteness {
  const details: Record<string, unknown> = {};
  let status: DomainCompleteness['status'] = 'COMPLETE';
  let itemCount = 1;
  const missingFields: string[] = [];

  if (domain === 'trades') {
    const items = Array.isArray(data) ? data : [];
    itemCount = items.length;
    status = items.length ? 'COMPLETE' : 'EMPTY';
  } else if (domain === 'depth') {
    const depth = asRecord(data);
    if (!depth) {
      status = 'INVALID';
      itemCount = 0;
    } else {
      const bidCount = Array.isArray(depth.bids) ? depth.bids.length : 0;
      const askCount = Array.isArray(depth.asks) ? depth.asks.length : 0;
      details.bid_count = bidCount;
      details.ask_count = askCount;
      itemCount = bidCount + askCount;
      status = bidCount && askCount ? 'COMPLETE' : itemCount ? 'PARTIAL' : 'EMPTY';
    }
  } else if (domain === 'kline') {
    const kline = asRecord(data);
    const requiredFields = ['open', 'high', 'low', 'close', 'volume'];
    if (!kline) {
      status = 'INVALID';
      itemCount = 0;
      missingFields.push(...requiredFields);
    } else {
      missingFields.push(...requiredFields.filter((field) => kline[field] === null || kline[field] === undefined));
      status = missingFields.length ? 'PARTIAL' : 'COMPLETE';
    }
  } else if (!asRecord(data)) {
    status = 'INVALID';
    itemCount = 0;
  }

  return {
    status,
    has_data: itemCount > 0 && status !== 'INVALID',
    item_count: itemCount,
    missing_fields: missingFields,
    details,
  };
}

function getRevision(records: readonly (Record<string, unknown> | null)[]): DomainRevision | null {
  const epoch = readNumber(records, 'revision_epoch');
  const sequence = readNumber(records, 'revision_seq') ?? readNumber(records, 'sequence');
  const isClosed = readBoolean(records, 'is_closed');
  const closeStateSource = readText(records, 'close_state_source');
  if (epoch === null && sequence === null && isClosed === null && !closeStateSource) return null;
  return {
    epoch,
    sequence,
    is_closed: isClosed,
    close_state_source: closeStateSource,
  };
}

function makeSnapshot<TData>(params: {
  domain: DomainName;
  symbol: string;
  interval?: string | null;
  data: TData;
  payload: Record<string, unknown> | null;
  envelope: Record<string, unknown>;
}): DomainSnapshot<TData> {
  const metadataRecord = asRecord(params.payload?.metadata) ?? asRecord(params.envelope.metadata);
  const records = [metadataRecord, params.payload, params.envelope];
  const now = Date.now();
  const receivedAtMs = readNumber(records, 'received_at_ms') ?? now;
  const cacheUpdatedAtMs = readNumber(records, 'cache_updated_at_ms')
    ?? readNumber(records, 'updated_at_ms');
  const source = readEnum(records, 'source', VALID_SOURCES) ?? 'MISSING';
  const freshness = readEnum(records, 'freshness', VALID_FRESHNESS) ?? 'MISSING';
  const freshnessBasis = readEnum(records, 'freshness_basis', VALID_FRESHNESS_BASIS)
    ?? 'RECEIVED_AT';
  const ageBasis = cacheUpdatedAtMs ?? receivedAtMs;
  const snapshotId = readText(records, 'snapshot_id')
    ?? `spot-mirror-${params.symbol}-${params.domain}-${params.interval ?? 'none'}-${++mirrorSnapshotSequence}`;

  return {
    schema_version: 'spot-domain-snapshot/v1',
    snapshot_id: snapshotId,
    emitted_at_ms: now,
    data: params.data,
    metadata: {
      domain: params.domain,
      symbol: params.symbol,
      interval: params.interval ?? null,
      provider: readText(records, 'provider'),
      provider_symbol: readText(records, 'provider_symbol'),
      transport: readEnum(records, 'transport', VALID_TRANSPORTS) ?? 'PROVIDER_WS',
      cache_origin: readEnum(records, 'cache_origin', VALID_CACHE_ORIGINS) ?? 'NONE',
      source,
      freshness,
      fallback_reason: readEnum(records, 'fallback_reason', VALID_FALLBACK_REASONS),
      provider_event_time_ms: readNumber(records, 'provider_event_time_ms')
        ?? readNumber(records, 'event_time_ms'),
      received_at_ms: receivedAtMs,
      cache_updated_at_ms: cacheUpdatedAtMs,
      age_ms: readNumber(records, 'age_ms') ?? Math.max(0, now - ageBasis),
      ttl_ms: readNumber(records, 'ttl_ms'),
      stale: readBoolean(records, 'stale') ?? ['STALE', 'LAST_GOOD'].includes(freshness),
      provider_generation: readNumber(records, 'provider_generation'),
      revision: getRevision(records),
      completeness: getCompleteness(params.domain, params.data),
      freshness_basis: freshnessBasis,
    },
  };
}

function getMessageSymbol(
  envelope: Record<string, unknown>,
  payload: Record<string, unknown> | null,
): string {
  return normalizeSymbol(envelope.symbol ?? payload?.symbol);
}

function getTradeItems(value: unknown): SpotMarketTradeItem[] {
  if (Array.isArray(value)) return value as SpotMarketTradeItem[];
  const record = asRecord(value);
  if (Array.isArray(record?.items)) return record.items as SpotMarketTradeItem[];
  if (Array.isArray(record?.trades)) return record.trades as SpotMarketTradeItem[];
  return [];
}

function mirrorTradesBatch(
  store: SpotPublicMarketStore,
  envelope: Record<string, unknown>,
  tradesPayload: unknown,
): void {
  const tradesRecord = asRecord(tradesPayload);
  const symbol = getMessageSymbol(envelope, tradesRecord);
  if (!symbol) return;
  const rows = getTradeItems(tradesPayload);
  const receivedAtMs = resolveSpotTradeBatchReceivedAtMs(
    tradesPayload,
    rows,
    Date.now(),
  );
  const normalizedRows = applySpotTradeReceivedAtMs(rows, receivedAtMs);
  ingestSpotTradesStoreEvent(store, {
    symbol,
    domain: 'trades',
    provider: readText([tradesRecord, envelope], 'provider'),
    eventTimeMs: extractSpotTradesEventTimeMs(normalizedRows),
    receivedAtMs,
    transport: 'ws_snapshot',
    source: readText([tradesRecord, envelope], 'source')
      ?? (normalizedRows.length ? 'UNKNOWN' : 'MISSING'),
    freshness: readText([tradesRecord, envelope], 'freshness')
      ?? (normalizedRows.length ? 'RECENT' : 'MISSING'),
    data: normalizedRows,
  }, {
    providerSymbol: readText([tradesRecord, envelope], 'provider_symbol'),
  });
}

function mirrorTradeIncremental(
  store: SpotPublicMarketStore,
  envelope: Record<string, unknown>,
  trade: SpotMarketTradeItem,
): void {
  const tradeRecord = asRecord(trade);
  const symbol = getMessageSymbol(envelope, tradeRecord);
  if (!symbol) return;
  const receivedAtMs = resolveSpotTradeIncrementalReceivedAtMs(
    trade,
    envelope,
    Date.now,
  );
  const normalizedTrade = applySpotTradeReceivedAtMs([trade], receivedAtMs)[0];
  ingestSpotTradesStoreEvent(store, {
    symbol,
    domain: 'trades',
    provider: readText([tradeRecord, envelope], 'provider'),
    eventTimeMs: extractSpotTradeEventTimeMs(normalizedTrade),
    receivedAtMs: receivedAtMs ?? 0,
    transport: 'ws_incremental',
    source: readText([tradeRecord, envelope], 'source') ?? 'LIVE_WS',
    freshness: readText([tradeRecord, envelope], 'freshness') ?? 'LIVE',
    data: [normalizedTrade],
  }, {
    providerSymbol: readText([tradeRecord, envelope], 'provider_symbol'),
    incrementalTrade: normalizedTrade,
  });
}

function mirrorSnapshotMessage(store: SpotPublicMarketStore, envelope: Record<string, unknown>): void {
  const marketView = asRecord(envelope.market_view);
  const tickerPayload = asRecord(envelope.ticker ?? marketView?.ticker);
  const depthPayload = asRecord(envelope.depth ?? marketView?.depth);
  const tradesPayload = envelope.trades ?? marketView?.trades;
  const tradesRecord = asRecord(tradesPayload);
  const symbol = normalizeSymbol(
    envelope.symbol
      ?? marketView?.symbol
      ?? tickerPayload?.symbol
      ?? depthPayload?.symbol
      ?? tradesRecord?.symbol,
  );
  if (!symbol) return;

  store.ingestSnapshot({
    ticker: tickerPayload
      ? makeSnapshot<SpotMarketTickerItem>({
          domain: 'ticker', symbol, data: tickerPayload as SpotMarketTickerItem, payload: tickerPayload, envelope,
        })
      : null,
    depth: depthPayload
      ? makeSnapshot<SpotDepthResponse>({
          domain: 'depth', symbol, data: depthPayload as SpotDepthResponse, payload: depthPayload, envelope,
        })
      : null,
    trades: null,
  });
  if (tradesPayload !== null && tradesPayload !== undefined) {
    mirrorTradesBatch(store, { ...envelope, symbol }, tradesPayload);
  }
}

function mirrorEvent(
  store: SpotPublicMarketStore,
  eventType: MirrorEventType,
  rawMessage: unknown,
): void {
  const envelope = asRecord(rawMessage);
  if (!envelope) return;
  store.updateTransport({ lastMessageAtMs: Date.now() });
  if (eventType === 'snapshot') {
    mirrorSnapshotMessage(store, envelope);
    return;
  }

  const payloadKey = eventType === 'trade' ? 'trade' : eventType;
  const payload = asRecord(envelope[payloadKey]);
  const symbol = getMessageSymbol(envelope, payload);
  if (!symbol || !payload) return;

  if (eventType === 'ticker') {
    store.ingestTicker(makeSnapshot<SpotMarketTickerItem>({
      domain: 'ticker', symbol, data: payload as SpotMarketTickerItem, payload, envelope,
    }));
    return;
  }
  if (eventType === 'depth') {
    store.ingestDepth(makeSnapshot<SpotDepthResponse>({
      domain: 'depth', symbol, data: payload as SpotDepthResponse, payload, envelope,
    }));
    return;
  }
  if (eventType === 'trade') {
    mirrorTradeIncremental(store, { ...envelope, symbol }, payload as SpotMarketTradeItem);
    return;
  }

  const interval = normalizeInterval(envelope.interval ?? payload.interval);
  if (!interval) return;
  store.ingestKlineCurrent(makeSnapshot<SpotMarketKlineItem>({
    domain: 'kline', symbol, interval, data: payload as SpotMarketKlineItem, payload, envelope,
  }));
}

export function attachSpotMarketStoreTransportMirror(
  transport: SpotMarketMirrorTransport,
  store: SpotPublicMarketStore = spotPublicMarketStore,
): () => void {
  const transportKey = transport as object;
  const stores = attachments.get(transportKey) ?? new Map<SpotPublicMarketStore, () => void>();
  const existing = stores.get(store);
  if (existing) return existing;

  let previousStatus: MirrorStatus | null = null;
  const unsubscribers = (['snapshot', 'ticker', 'depth', 'trade', 'kline'] as const).map(
    (eventType) => transport.subscribe(eventType, (message) => mirrorEvent(store, eventType, message)),
  );
  unsubscribers.push(transport.subscribeStatus((status) => {
    const now = Date.now();
    store.updateTransport({
      status,
      generation: status === 'open' && previousStatus !== 'open'
        ? store.getState().transport.generation + 1
        : store.getState().transport.generation,
      connectedAtMs: status === 'open' ? now : store.getState().transport.connectedAtMs,
      disconnectedAtMs: status === 'closed' ? now : store.getState().transport.disconnectedAtMs,
      lastMessageAtMs: store.getState().transport.lastMessageAtMs,
      reconnectAttempt: status === 'connecting' && previousStatus === 'closed'
        ? store.getState().transport.reconnectAttempt + 1
        : store.getState().transport.reconnectAttempt,
      error: null,
    });
    previousStatus = status;
  }));

  const detach = () => {
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
    stores.delete(store);
    if (!stores.size) attachments.delete(transportKey);
  };
  stores.set(store, detach);
  attachments.set(transportKey, stores);
  return detach;
}
