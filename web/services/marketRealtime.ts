'use client';

import { getRuntimeApiBaseUrl } from '@/lib/api/core/baseUrl';
import { markSpotKlinePerf } from '@/components/spot/tradingview/spotKlinePerf';

type SpotMarketSnapshotMessage = {
  type: 'spot_market_snapshot';
  symbol?: string;
  depth?: unknown;
  trades?: unknown;
};

export type SpotMarketTradeMessage = {
  type: 'spot_trade';
  symbol?: string;
  provider?: string;
  provider_symbol?: string;
  source?: string;
  freshness?: string;
  updated_at_ms?: number | string;
  trade?: unknown;
};

type SpotMarketDepthMessage = {
  type: 'spot_depth_update';
  symbol?: string;
  depth?: unknown;
};

type SpotMarketTickerMessage = {
  type: 'spot_ticker_update';
  symbol?: string;
  ticker?: unknown;
};

export type SpotMarketKlineMessage = {
  type: 'spot_kline_update';
  symbol?: string;
  interval?: string;
  kline?: unknown;
  source?: string;
  updated_at?: string;
};

export type SpotMarketRealtimeEventType = 'snapshot' | 'trade' | 'depth' | 'ticker' | 'kline';
export type SpotMarketRealtimeDomain = 'snapshot' | 'depth' | 'trades' | 'ticker' | 'kline';
export type SpotMarketConnectionStatus = 'connecting' | 'open' | 'closed';
export type SpotMarketRealtimeMessage =
  | SpotMarketSnapshotMessage
  | SpotMarketTradeMessage
  | SpotMarketDepthMessage
  | SpotMarketTickerMessage
  | SpotMarketKlineMessage;
export type SpotMarketRealtimeHandler = (message: SpotMarketRealtimeMessage) => void;
export type SpotMarketRealtimeStatusHandler = (status: SpotMarketConnectionStatus) => void;
export type SpotMarketRealtimeSubscriptionOptions = {
  symbol: string;
  domains: SpotMarketRealtimeDomain[];
  interval?: string | null;
  owner?: string;
};

export type SpotMarketRealtimeKlineIntervalSyncOptions = {
  symbol: string;
  interval: string;
  owner: string;
};

export type SpotMarketRealtimeKlineIntervalSyncResult = {
  symbol: string;
  interval: string;
  owner: string;
  previousInterval: string | null;
  subscriptionId: string;
  changed: boolean;
};

export type SpotMarketRealtimeKlineIntervalReleaseOptions = {
  symbol: string;
  owner: string;
};

export type SpotMarketRealtimeKlineIntervalReleaseResult = {
  symbol: string;
  owner: string;
  previousInterval: string | null;
  released: boolean;
};

type SpotMarketRealtimeSubscriptionEntry = {
  connectionKey: string;
  domain: SpotMarketRealtimeDomain;
  interval?: string;
};

type SpotMarketRealtimeSubscription = {
  id: string;
  symbol: string;
  interval: string;
  owner?: string;
  entries: SpotMarketRealtimeSubscriptionEntry[];
};

type SpotMarketRealtimeConnection = {
  key: string;
  symbol: string;
  ws: WebSocket | null;
  connectTimer: number | null;
  reconnectTimer: number | null;
  status: SpotMarketConnectionStatus;
  closedByClient: boolean;
  domains: Map<SpotMarketRealtimeDomain, Set<string>>;
  klineIntervals: Map<string, Set<string>>;
};

const BASE_INTERVAL = '1m';
const SPOT_KLINE_INTERVAL_ALIASES: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1dutc': '1Dutc',
  '1w': '1w',
  '1wutc': '1Wutc',
  '1M': '1M',
  '1mutc': '1Mutc',
};
const SPOT_KLINE_INTERVALS = new Set(Object.values(SPOT_KLINE_INTERVAL_ALIASES));

function buildSpotWsUrl(symbol: string) {
  const apiBase = getRuntimeApiBaseUrl();
  const url = new URL(apiBase);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({
    symbol,
  });
  return `${protocol}//${url.host}/market/ws/spot?${params.toString()}`;
}

function normalizeSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase();
}

function normalizeSpotRealtimeInterval(interval?: string | null) {
  const raw = String(interval || '1m').trim();
  const key = raw === '1M' ? raw : raw.toLowerCase();
  const normalized = SPOT_KLINE_INTERVAL_ALIASES[key] || raw;
  return SPOT_KLINE_INTERVALS.has(normalized) ? normalized : BASE_INTERVAL;
}

function normalizeDomain(domain: SpotMarketRealtimeDomain): SpotMarketRealtimeDomain {
  if (domain === 'trades') return 'trades';
  return domain;
}

function makeConnectionKey(symbol: string) {
  return symbol;
}

function getMessageObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

function getMarketRealtimePerfNow() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

class SpotMarketRealtimeClient {
  private connections = new Map<string, SpotMarketRealtimeConnection>();
  private subscriptions = new Map<string, SpotMarketRealtimeSubscription>();
  private nextSubscriptionId = 1;
  private legacySubscriptionId: string | null = null;
  private handlers = new Map<SpotMarketRealtimeEventType, Set<SpotMarketRealtimeHandler>>();
  private statusHandlers = new Set<SpotMarketRealtimeStatusHandler>();
  private status: SpotMarketConnectionStatus = 'closed';

  setSymbol(symbol: string, interval = '1m') {
    if (this.legacySubscriptionId) {
      this.releaseSubscription(this.legacySubscriptionId);
    }

    this.legacySubscriptionId = this.acquireSubscription({
      symbol,
      interval,
      domains: ['snapshot', 'depth', 'trades', 'ticker', 'kline'],
      owner: 'legacy-setSymbol',
    });
  }

  acquireSubscription(options: SpotMarketRealtimeSubscriptionOptions): string {
    const symbol = normalizeSymbol(options.symbol);
    if (!symbol) return '';

    const interval = normalizeSpotRealtimeInterval(options.interval);
    const domains = Array.from(new Set(options.domains.map(normalizeDomain)));
    if (!domains.length) return '';

    if (options.owner && domains.includes('kline')) {
      this.releaseOwnerKlineEntries(symbol, options.owner);
    }

    const id = `${options.owner || 'spot-market'}:${this.nextSubscriptionId++}`;
    const entries: SpotMarketRealtimeSubscriptionEntry[] = [];
    const touchedConnections = new Set<string>();

    for (const domain of domains) {
      const connection = this.ensureConnection(symbol);
      touchedConnections.add(connection.key);

      if (domain === 'kline') {
        const bucket = connection.klineIntervals.get(interval) ?? new Set<string>();
        const wasEmpty = bucket.size === 0;
        bucket.add(id);
        connection.klineIntervals.set(interval, bucket);
        entries.push({ connectionKey: connection.key, domain, interval });
        if (wasEmpty) {
          this.sendKlineSubscription(connection, 'subscribe', interval);
        }
        continue;
      }

      const bucket = connection.domains.get(domain) ?? new Set<string>();
      bucket.add(id);
      connection.domains.set(domain, bucket);
      entries.push({ connectionKey: connection.key, domain });
    }

    this.subscriptions.set(id, {
      id,
      symbol,
      interval,
      owner: options.owner,
      entries,
    });

    for (const connectionKey of touchedConnections) {
      const connection = this.connections.get(connectionKey);
      if (connection) {
        this.ensureConnectionOpen(connection);
      }
    }

    return id;
  }

  syncKlineInterval(
    options: SpotMarketRealtimeKlineIntervalSyncOptions,
  ): SpotMarketRealtimeKlineIntervalSyncResult | null {
    const symbol = normalizeSymbol(options.symbol);
    const owner = String(options.owner || '').trim();
    if (!symbol || !owner) return null;

    const interval = normalizeSpotRealtimeInterval(options.interval);
    const currentState = this.getOwnerKlineState(symbol, owner);
    if (
      currentState.intervals.length === 1 &&
      currentState.intervals[0] === interval &&
      currentState.subscriptionId
    ) {
      return {
        symbol,
        interval,
        owner,
        previousInterval: interval,
        subscriptionId: currentState.subscriptionId,
        changed: false,
      };
    }

    const previousInterval = currentState.intervals[0] ?? null;
    const subscriptionId = this.acquireSubscription({
      symbol,
      interval,
      domains: ['kline'],
      owner,
    });
    if (!subscriptionId) return null;

    return {
      symbol,
      interval,
      owner,
      previousInterval,
      subscriptionId,
      changed: true,
    };
  }

  releaseKlineIntervalOwner(
    options: SpotMarketRealtimeKlineIntervalReleaseOptions,
  ): SpotMarketRealtimeKlineIntervalReleaseResult | null {
    const symbol = normalizeSymbol(options.symbol);
    const owner = String(options.owner || '').trim();
    if (!symbol || !owner) return null;

    const currentState = this.getOwnerKlineState(symbol, owner);
    const releasedIntervals = this.releaseOwnerKlineEntries(symbol, owner, true);
    return {
      symbol,
      owner,
      previousInterval: currentState.intervals[0] ?? releasedIntervals[0] ?? null,
      released: releasedIntervals.length > 0,
    };
  }

  private getOwnerKlineState(symbol: string, owner: string) {
    const intervals: string[] = [];
    let subscriptionId = '';

    for (const subscription of this.subscriptions.values()) {
      if (subscription.symbol !== symbol || subscription.owner !== owner) continue;

      for (const entry of subscription.entries) {
        if (entry.domain !== 'kline') continue;
        const interval = normalizeSpotRealtimeInterval(entry.interval || subscription.interval);
        if (!intervals.includes(interval)) {
          intervals.push(interval);
        }
        if (!subscriptionId) {
          subscriptionId = subscription.id;
        }
      }
    }

    return { intervals, subscriptionId };
  }

  private releaseOwnerKlineEntries(
    symbol: string,
    owner: string,
    closeIdleConnections = false,
  ) {
    const releasedIntervals: string[] = [];
    const touchedConnections = new Set<string>();

    for (const subscription of Array.from(this.subscriptions.values())) {
      if (subscription.symbol !== symbol || subscription.owner !== owner) continue;

      const remainingEntries: SpotMarketRealtimeSubscriptionEntry[] = [];
      for (const entry of subscription.entries) {
        if (entry.domain !== 'kline') {
          remainingEntries.push(entry);
          continue;
        }

        const connection = this.connections.get(entry.connectionKey);
        if (!connection) continue;

        const interval = normalizeSpotRealtimeInterval(entry.interval || subscription.interval);
        touchedConnections.add(entry.connectionKey);
        if (!releasedIntervals.includes(interval)) {
          releasedIntervals.push(interval);
        }
        const bucket = connection.klineIntervals.get(interval);
        bucket?.delete(subscription.id);
        if (bucket && bucket.size === 0) {
          connection.klineIntervals.delete(interval);
          this.sendKlineSubscription(connection, 'unsubscribe', interval);
        }
      }

      subscription.entries = remainingEntries;
      if (!subscription.entries.length) {
        this.subscriptions.delete(subscription.id);
      }
    }

    if (closeIdleConnections) {
      for (const connectionKey of touchedConnections) {
        const connection = this.connections.get(connectionKey);
        if (connection && !this.hasActiveConnectionDomains(connection)) {
          this.closeConnection(connection, 'subscription released');
          this.connections.delete(connection.key);
        }
      }
      this.refreshAggregateStatus();
    }

    return releasedIntervals;
  }

  releaseSubscription(subscriptionId: string) {
    if (!subscriptionId) return;
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;

    this.subscriptions.delete(subscriptionId);
    if (this.legacySubscriptionId === subscriptionId) {
      this.legacySubscriptionId = null;
    }

    for (const entry of subscription.entries) {
      const connection = this.connections.get(entry.connectionKey);
      if (!connection) continue;

      if (entry.domain === 'kline') {
        const interval = entry.interval || subscription.interval;
        const bucket = connection.klineIntervals.get(interval);
        bucket?.delete(subscriptionId);
        if (bucket && bucket.size === 0) {
          connection.klineIntervals.delete(interval);
          this.sendKlineSubscription(connection, 'unsubscribe', interval);
        }
      } else {
        const bucket = connection.domains.get(entry.domain);
        bucket?.delete(subscriptionId);
        if (bucket && bucket.size === 0) {
          connection.domains.delete(entry.domain);
        }
      }

      if (!this.hasActiveConnectionDomains(connection)) {
        this.closeConnection(connection, 'subscription released');
        this.connections.delete(connection.key);
      }
    }

    this.refreshAggregateStatus();
  }

  subscribe(type: SpotMarketRealtimeEventType, handler: SpotMarketRealtimeHandler) {
    const bucket = this.handlers.get(type) ?? new Set<SpotMarketRealtimeHandler>();
    bucket.add(handler);
    this.handlers.set(type, bucket);

    return () => {
      this.unsubscribe(type, handler);
    };
  }

  unsubscribe(type: SpotMarketRealtimeEventType, handler: SpotMarketRealtimeHandler) {
    const bucket = this.handlers.get(type);
    if (!bucket) return;

    bucket.delete(handler);
    if (bucket.size === 0) {
      this.handlers.delete(type);
    }
  }

  subscribeStatus(handler: SpotMarketRealtimeStatusHandler) {
    this.statusHandlers.add(handler);
    handler(this.status);

    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  isConnected() {
    return this.status === 'open';
  }

  disconnect() {
    for (const connection of Array.from(this.connections.values())) {
      this.closeConnection(connection, 'client disconnect');
    }
    this.connections.clear();
    this.subscriptions.clear();
    this.legacySubscriptionId = null;
    this.setStatus('closed');
  }

  private ensureConnection(symbol: string) {
    const key = makeConnectionKey(symbol);
    const existing = this.connections.get(key);
    if (existing) return existing;

    const connection: SpotMarketRealtimeConnection = {
      key,
      symbol,
      ws: null,
      connectTimer: null,
      reconnectTimer: null,
      status: 'closed',
      closedByClient: false,
      domains: new Map<SpotMarketRealtimeDomain, Set<string>>(),
      klineIntervals: new Map<string, Set<string>>(),
    };
    this.connections.set(key, connection);
    return connection;
  }

  private ensureConnectionOpen(connection: SpotMarketRealtimeConnection) {
    if (typeof window === 'undefined') return;
    connection.closedByClient = false;

    if (
      connection.ws &&
      (connection.ws.readyState === WebSocket.OPEN || connection.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this.clearConnectionTimer(connection, 'reconnect');

    if (connection.connectTimer !== null) return;

    connection.connectTimer = window.setTimeout(() => {
      connection.connectTimer = null;
      if (connection.closedByClient || !this.hasActiveConnectionDomains(connection)) return;
      this.connect(connection);
    }, 100);
  }

  private connect(connection: SpotMarketRealtimeConnection) {
    if (typeof window === 'undefined') return;
    if (!this.hasActiveConnectionDomains(connection)) return;

    this.clearConnectionTimer(connection, 'connect');
    this.clearConnectionTimer(connection, 'reconnect');
    this.setConnectionStatus(connection, 'connecting');

    const connectStartedAt = getMarketRealtimePerfNow();
    markSpotKlinePerf('ws_connect_start', {
      symbol: connection.symbol,
      source: 'marketRealtime',
      activeKlineIntervals: Array.from(connection.klineIntervals.keys()),
    });
    const ws = new WebSocket(buildSpotWsUrl(connection.symbol));
    connection.ws = ws;

    ws.onopen = () => {
      if (connection.ws !== ws) return;
      this.setConnectionStatus(connection, 'open');
      markSpotKlinePerf('ws_open', {
        symbol: connection.symbol,
        source: 'marketRealtime',
        duration_ms: Math.max(0, getMarketRealtimePerfNow() - connectStartedAt),
        activeKlineIntervals: Array.from(connection.klineIntervals.keys()),
      });
      this.sendActiveKlineSubscriptions(connection);
    };

    ws.onmessage = (event) => {
      if (event.data === 'pong') return;

      try {
        const message = JSON.parse(event.data) as SpotMarketRealtimeMessage;
        this.dispatch(message, connection);
      } catch (err) {
        console.warn('[marketRealtime] spot WS parse error:', err);
      }
    };

    ws.onerror = () => {
      // ignore transient websocket errors in dev
    };

    ws.onclose = () => {
      if (connection.ws === ws) {
        connection.ws = null;
      }
      this.setConnectionStatus(connection, 'closed');
      markSpotKlinePerf('ws_close', {
        symbol: connection.symbol,
        source: 'marketRealtime',
        duration_ms: Math.max(0, getMarketRealtimePerfNow() - connectStartedAt),
        closedByClient: connection.closedByClient,
        activeKlineIntervals: Array.from(connection.klineIntervals.keys()),
      });

      if (connection.closedByClient || !this.hasActiveConnectionDomains(connection)) return;

      this.clearConnectionTimer(connection, 'reconnect');
      connection.reconnectTimer = window.setTimeout(() => {
        connection.reconnectTimer = null;
        this.connect(connection);
      }, 1500);
    };
  }

  private closeConnection(connection: SpotMarketRealtimeConnection, reason: string) {
    connection.closedByClient = true;
    this.clearConnectionTimer(connection, 'connect');
    this.clearConnectionTimer(connection, 'reconnect');

    if (!connection.ws) {
      this.setConnectionStatus(connection, 'closed');
      return;
    }

    const ws = connection.ws;
    connection.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.close(1000, reason);
    this.setConnectionStatus(connection, 'closed');
  }

  private dispatch(message: SpotMarketRealtimeMessage, connection: SpotMarketRealtimeConnection) {
    if (message.type === 'spot_market_snapshot') {
      if (this.shouldDispatch(message, connection, 'snapshot')) {
        this.emit('snapshot', message);
      }
      return;
    }

    if (message.type === 'spot_trade') {
      if (this.shouldDispatch(message, connection, 'trades')) {
        this.emit('trade', message);
      }
      return;
    }

    if (message.type === 'spot_depth_update') {
      if (this.shouldDispatch(message, connection, 'depth')) {
        this.emit('depth', message);
      }
      return;
    }

    if (message.type === 'spot_ticker_update') {
      if (this.shouldDispatch(message, connection, 'ticker')) {
        this.emit('ticker', message);
      }
      return;
    }

    if (message.type === 'spot_kline_update') {
      const messageInterval = normalizeSpotRealtimeInterval(this.getMessageInterval(message));
      const messageSymbol = this.getMessageSymbol(message) || connection.symbol;
      markSpotKlinePerf('kline_message_received', {
        symbol: messageSymbol,
        interval: messageInterval,
        source: 'marketRealtime',
        connectionSymbol: connection.symbol,
        activeKlineIntervals: Array.from(connection.klineIntervals.keys()),
      });
      if (this.shouldDispatch(message, connection, 'kline')) {
        this.emit('kline', message);
      } else if (messageSymbol === connection.symbol) {
        markSpotKlinePerf('ignored_kline_interval', {
          symbol: messageSymbol,
          interval: messageInterval,
          source: 'marketRealtime',
          connectionSymbol: connection.symbol,
          activeKlineIntervals: Array.from(connection.klineIntervals.keys()),
          note: 'no active subscriber for kline interval',
        });
      }
    }
  }

  private shouldDispatch(
    message: SpotMarketRealtimeMessage,
    connection: SpotMarketRealtimeConnection,
    domain: SpotMarketRealtimeDomain,
  ) {
    const messageSymbol = this.getMessageSymbol(message);
    if (messageSymbol && messageSymbol !== connection.symbol) return false;

    if (domain === 'kline') {
      const messageInterval = normalizeSpotRealtimeInterval(this.getMessageInterval(message));
      return Boolean(connection.klineIntervals.get(messageInterval)?.size);
    }

    if (!connection.domains.get(domain)?.size) return false;

    return true;
  }

  private getMessageSymbol(message: SpotMarketRealtimeMessage) {
    if ('symbol' in message) {
      const symbol = normalizeSymbol(message.symbol || '');
      if (symbol) return symbol;
    }

    if (message.type === 'spot_depth_update') {
      const depth = getMessageObject(message.depth);
      return normalizeSymbol(String(depth?.symbol || ''));
    }

    if (message.type === 'spot_ticker_update') {
      const ticker = getMessageObject(message.ticker);
      return normalizeSymbol(String(ticker?.symbol || ''));
    }

    return '';
  }

  private getMessageInterval(message: SpotMarketRealtimeMessage) {
    if (message.type !== 'spot_kline_update') return BASE_INTERVAL;
    if (message.interval) return message.interval;
    const kline = getMessageObject(message.kline);
    return String(kline?.interval || BASE_INTERVAL);
  }

  private hasActiveConnectionDomains(connection: SpotMarketRealtimeConnection) {
    for (const bucket of connection.domains.values()) {
      if (bucket.size > 0) return true;
    }
    for (const bucket of connection.klineIntervals.values()) {
      if (bucket.size > 0) return true;
    }
    return false;
  }

  private sendActiveKlineSubscriptions(connection: SpotMarketRealtimeConnection) {
    for (const interval of connection.klineIntervals.keys()) {
      this.sendKlineSubscription(connection, 'subscribe', interval);
    }
  }

  private sendKlineSubscription(
    connection: SpotMarketRealtimeConnection,
    op: 'subscribe' | 'unsubscribe',
    interval: string,
  ) {
    const ws = connection.ws;
    const normalizedInterval = normalizeSpotRealtimeInterval(interval);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      markSpotKlinePerf(op === 'subscribe' ? 'kline_subscribe' : 'kline_unsubscribe', {
        symbol: connection.symbol,
        interval: normalizedInterval,
        source: 'marketRealtime',
        note: 'ws not open',
        wsReadyState: ws?.readyState ?? null,
      });
      return;
    }

    try {
      ws.send(JSON.stringify({
        op,
        domain: 'kline',
        interval: normalizedInterval,
      }));
      markSpotKlinePerf(op === 'subscribe' ? 'kline_subscribe' : 'kline_unsubscribe', {
        symbol: connection.symbol,
        interval: normalizedInterval,
        source: 'marketRealtime',
        wsReadyState: ws.readyState,
      });
    } catch (err) {
      if (process.env.NODE_ENV !== 'production') {
        console.warn('[marketRealtime] spot WS subscription send failed:', err);
      }
    }
  }

  private emit(type: SpotMarketRealtimeEventType, message: SpotMarketRealtimeMessage) {
    const bucket = this.handlers.get(type);
    if (!bucket?.size) return;

    for (const handler of Array.from(bucket)) {
      handler(message);
    }
  }

  private clearConnectionTimer(
    connection: SpotMarketRealtimeConnection,
    timer: 'connect' | 'reconnect',
  ) {
    const timerId = timer === 'connect' ? connection.connectTimer : connection.reconnectTimer;
    if (timerId !== null) {
      window.clearTimeout(timerId);
      if (timer === 'connect') {
        connection.connectTimer = null;
      } else {
        connection.reconnectTimer = null;
      }
    }
  }

  private setConnectionStatus(
    connection: SpotMarketRealtimeConnection,
    status: SpotMarketConnectionStatus,
  ) {
    connection.status = status;
    this.refreshAggregateStatus();
  }

  private refreshAggregateStatus() {
    let nextStatus: SpotMarketConnectionStatus = 'closed';
    for (const connection of this.connections.values()) {
      if (connection.status === 'open') {
        nextStatus = 'open';
        break;
      }
      if (connection.status === 'connecting') {
        nextStatus = 'connecting';
      }
    }
    this.setStatus(nextStatus);
  }

  private setStatus(status: SpotMarketConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const handler of Array.from(this.statusHandlers)) {
      handler(status);
    }
  }
}

export const spotMarketRealtime = new SpotMarketRealtimeClient();
