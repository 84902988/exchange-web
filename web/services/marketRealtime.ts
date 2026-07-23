'use client';

import { getRuntimeApiBaseUrl } from '@/lib/api/core/baseUrl';
import { markSpotKlinePerf } from '@/components/spot/tradingview/spotKlinePerf';
import { attachSpotMarketStoreTransportMirror } from '@/lib/realtime/spotMarketStore.transport';

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
  settlement_revision?: string;
  trade?: unknown;
  candle_preview?: SpotMarketCandlePreviewMessage;
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
  provider_generation?: number | string;
};

export type SpotMarketCandlePreviewMessage = {
  type: 'spot_candle_preview_update';
  symbol?: string;
  interval?: string;
  preview?: unknown;
  source?: string;
  provider?: string;
  provider_generation?: number | string;
  base_native_revision?: unknown;
  preview_seq?: number | string;
  received_at_ms?: number | string;
  settlement_revision?: string;
};

export type SpotMarketRealtimeEventType =
  | 'snapshot'
  | 'trade'
  | 'depth'
  | 'ticker'
  | 'kline'
  | 'preview';
export type SpotMarketRealtimeDomain = 'snapshot' | 'depth' | 'trades' | 'ticker' | 'kline';
export type SpotMarketConnectionStatus = 'connecting' | 'open' | 'closed';
export type SpotMarketRealtimeMessage =
  | SpotMarketSnapshotMessage
  | SpotMarketTradeMessage
  | SpotMarketDepthMessage
  | SpotMarketTickerMessage
  | SpotMarketKlineMessage
  | SpotMarketCandlePreviewMessage;
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
  lastActivityAtMs: number;
  reconnectAttempt: number;
  status: SpotMarketConnectionStatus;
  closedByClient: boolean;
  domains: Map<SpotMarketRealtimeDomain, Set<string>>;
  klineIntervals: Map<string, Set<string>>;
};

const BASE_INTERVAL = '1m';
const SPOT_WS_HEARTBEAT_INTERVAL_MS = 18_000;
const SPOT_WS_ACTIVITY_TIMEOUT_MS = 36_000;
const SPOT_WS_RECONNECT_BASE_MS = 1_500;
const SPOT_WS_RECONNECT_MAX_MS = 30_000;
const SPOT_WS_RECONNECT_JITTER_RATIO = 0.2;
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
  private heartbeatTimer: number | null = null;
  private lifecycleListenersAttached = false;

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
    this.stopHeartbeat();
    this.detachLifecycleListeners();
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
      lastActivityAtMs: 0,
      reconnectAttempt: 0,
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
    this.attachLifecycleListeners();

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
    let ws: WebSocket;
    try {
      ws = new WebSocket(buildSpotWsUrl(connection.symbol));
    } catch {
      this.setConnectionStatus(connection, 'closed');
      this.scheduleReconnect(connection);
      return;
    }
    connection.ws = ws;

    ws.onopen = () => {
      if (connection.ws !== ws) return;
      connection.lastActivityAtMs = Date.now();
      this.setConnectionStatus(connection, 'open');
      this.startHeartbeat();
      markSpotKlinePerf('ws_open', {
        symbol: connection.symbol,
        source: 'marketRealtime',
        duration_ms: Math.max(0, getMarketRealtimePerfNow() - connectStartedAt),
        activeKlineIntervals: Array.from(connection.klineIntervals.keys()),
      });
      this.sendActiveKlineSubscriptions(connection);
    };

    ws.onmessage = (event) => {
      if (connection.ws !== ws) return;
      connection.lastActivityAtMs = Date.now();
      connection.reconnectAttempt = 0;
      if (event.data === 'pong') return;

      try {
        const message = JSON.parse(event.data) as SpotMarketRealtimeMessage;
        this.dispatch(message, connection);
      } catch (err) {
        console.warn('[marketRealtime] spot WS parse error:', err);
      }
    };

    ws.onerror = () => {
      if (connection.ws !== ws) return;
      // ignore transient websocket errors in dev
    };

    ws.onclose = () => {
      if (connection.ws !== ws) return;
      connection.ws = null;
      this.setConnectionStatus(connection, 'closed');
      this.refreshHeartbeat();
      markSpotKlinePerf('ws_close', {
        symbol: connection.symbol,
        source: 'marketRealtime',
        duration_ms: Math.max(0, getMarketRealtimePerfNow() - connectStartedAt),
        closedByClient: connection.closedByClient,
        activeKlineIntervals: Array.from(connection.klineIntervals.keys()),
      });

      if (connection.closedByClient || !this.hasActiveConnectionDomains(connection)) return;

      this.scheduleReconnect(connection);
    };
  }

  private scheduleReconnect(connection: SpotMarketRealtimeConnection) {
    if (
      typeof window === 'undefined'
      || connection.closedByClient
      || !this.hasActiveConnectionDomains(connection)
    ) return;

    this.clearConnectionTimer(connection, 'reconnect');
    const baseDelay = Math.min(
      SPOT_WS_RECONNECT_BASE_MS * (2 ** connection.reconnectAttempt),
      SPOT_WS_RECONNECT_MAX_MS,
    );
    const jitter = 1 + ((Math.random() * 2 - 1) * SPOT_WS_RECONNECT_JITTER_RATIO);
    const delay = Math.round(Math.min(
      baseDelay * jitter,
      SPOT_WS_RECONNECT_MAX_MS,
    ));
    connection.reconnectAttempt += 1;
    connection.reconnectTimer = window.setTimeout(() => {
      connection.reconnectTimer = null;
      if (connection.closedByClient || !this.hasActiveConnectionDomains(connection)) return;
      this.connect(connection);
    }, delay);
  }

  private closeConnection(connection: SpotMarketRealtimeConnection, reason: string) {
    connection.closedByClient = true;
    this.clearConnectionTimer(connection, 'connect');
    this.clearConnectionTimer(connection, 'reconnect');
    connection.lastActivityAtMs = 0;
    connection.reconnectAttempt = 0;

    if (!connection.ws) {
      this.setConnectionStatus(connection, 'closed');
      this.cleanupIdleClientResources();
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
    this.cleanupIdleClientResources();
  }

  private startHeartbeat() {
    if (this.heartbeatTimer !== null || typeof window === 'undefined') return;
    this.heartbeatTimer = window.setInterval(() => {
      for (const connection of this.connections.values()) {
        this.checkConnectionHealth(connection);
      }
    }, SPOT_WS_HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat() {
    if (this.heartbeatTimer === null || typeof window === 'undefined') return;
    window.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private refreshHeartbeat() {
    const hasOpenConnection = Array.from(this.connections.values()).some(
      (connection) => connection.ws?.readyState === WebSocket.OPEN,
    );
    if (hasOpenConnection) {
      this.startHeartbeat();
    } else {
      this.stopHeartbeat();
    }
  }

  private checkConnectionHealth(connection: SpotMarketRealtimeConnection) {
    const ws = connection.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - connection.lastActivityAtMs >= SPOT_WS_ACTIVITY_TIMEOUT_MS) {
      this.reconnectStaleConnection(connection, ws);
      return;
    }
    try {
      ws.send('ping');
    } catch {
      this.reconnectStaleConnection(connection, ws);
    }
  }

  private reconnectStaleConnection(
    connection: SpotMarketRealtimeConnection,
    ws: WebSocket,
  ) {
    if (connection.ws !== ws) return;
    connection.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close(4000, 'spot market heartbeat timeout');
    } catch {
      // The retired socket must not prevent replacement if close itself fails.
    }
    this.setConnectionStatus(connection, 'closed');
    this.refreshHeartbeat();
    this.scheduleReconnect(connection);
  }

  private attachLifecycleListeners() {
    if (this.lifecycleListenersAttached || typeof window === 'undefined') return;
    window.addEventListener('online', this.handleConnectionOpportunity);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.lifecycleListenersAttached = true;
  }

  private detachLifecycleListeners() {
    if (!this.lifecycleListenersAttached || typeof window === 'undefined') return;
    window.removeEventListener('online', this.handleConnectionOpportunity);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.handleVisibilityChange);
    }
    this.lifecycleListenersAttached = false;
  }

  private handleConnectionOpportunity = () => {
    for (const connection of this.connections.values()) {
      if (!this.hasActiveConnectionDomains(connection) || connection.closedByClient) continue;
      if (connection.ws?.readyState === WebSocket.OPEN) {
        this.checkConnectionHealth(connection);
        continue;
      }
      if (
        connection.ws?.readyState === WebSocket.CONNECTING
        || connection.ws?.readyState === WebSocket.CLOSING
      ) continue;
      this.clearConnectionTimer(connection, 'reconnect');
      this.connect(connection);
    }
  };

  private handleVisibilityChange = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      this.handleConnectionOpportunity();
    }
  };

  private cleanupIdleClientResources() {
    this.refreshHeartbeat();
    const hasActiveConnection = Array.from(this.connections.values()).some(
      (connection) => this.hasActiveConnectionDomains(connection),
    );
    if (!hasActiveConnection) {
      this.detachLifecycleListeners();
    }
  }

  private dispatch(message: SpotMarketRealtimeMessage, connection: SpotMarketRealtimeConnection) {
    if (message.type === 'spot_market_snapshot') {
      if (this.shouldDispatch(message, connection, 'snapshot')) {
        this.emit('snapshot', message);
      }
      return;
    }

    if (message.type === 'spot_trade') {
      const preview = message.candle_preview;
      if (
        preview?.type === 'spot_candle_preview_update'
        && normalizeSymbol(preview.symbol || '') === connection.symbol
        && this.shouldDispatch(preview, connection, 'kline')
      ) {
        // Commit TradingView evidence before React paints the corresponding
        // trade state; both subscribers run in this single WebSocket task.
        this.emit('preview', preview);
      }
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
      return;
    }

    if (message.type === 'spot_candle_preview_update') {
      if (this.shouldDispatch(message, connection, 'kline')) {
        this.emit('preview', message);
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
    if (
      message.type !== 'spot_kline_update'
      && message.type !== 'spot_candle_preview_update'
    ) return BASE_INTERVAL;
    if (message.interval) return message.interval;
    if (message.type === 'spot_candle_preview_update') {
      const preview = getMessageObject(message.preview);
      return String(preview?.interval || BASE_INTERVAL);
    }
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
attachSpotMarketStoreTransportMirror(spotMarketRealtime);
