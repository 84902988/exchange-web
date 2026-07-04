'use client';

import { getRuntimeApiBaseUrl } from '@/lib/api/core/baseUrl';

type SpotMarketSnapshotMessage = {
  type: 'spot_market_snapshot';
  symbol?: string;
  depth?: unknown;
  trades?: unknown;
};

type SpotMarketTradeMessage = {
  type: 'spot_trade';
  symbol?: string;
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
export type SpotMarketConnectionStatus = 'connecting' | 'open' | 'closed';
export type SpotMarketRealtimeMessage =
  | SpotMarketSnapshotMessage
  | SpotMarketTradeMessage
  | SpotMarketDepthMessage
  | SpotMarketTickerMessage
  | SpotMarketKlineMessage;
export type SpotMarketRealtimeHandler = (message: SpotMarketRealtimeMessage) => void;
export type SpotMarketRealtimeStatusHandler = (status: SpotMarketConnectionStatus) => void;

function buildSpotWsUrl(symbol: string, interval = '1m') {
  const apiBase = getRuntimeApiBaseUrl();
  const url = new URL(apiBase);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const params = new URLSearchParams({
    symbol,
    interval,
  });
  return `${protocol}//${url.host}/market/ws/spot?${params.toString()}`;
}

function normalizeSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase();
}

function normalizeInterval(interval?: string | null) {
  const normalized = String(interval || '1m').trim();
  return ['1m', '5m', '15m', '1h', '4h', '1d'].includes(normalized) ? normalized : '1m';
}

class SpotMarketRealtimeClient {
  private ws: WebSocket | null = null;
  private connectTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private socketOpenedWithSymbol = '';
  private socketOpenedWithInterval = '1m';
  private requestedSymbol = '';
  private requestedInterval = '1m';
  private closedByClient = false;
  private handlers = new Map<SpotMarketRealtimeEventType, Set<SpotMarketRealtimeHandler>>();
  private statusHandlers = new Set<SpotMarketRealtimeStatusHandler>();
  private status: SpotMarketConnectionStatus = 'closed';

  setSymbol(symbol: string, interval = '1m') {
    const nextSymbol = normalizeSymbol(symbol);
    if (!nextSymbol) return;
    const nextInterval = normalizeInterval(interval);

    const previousSymbol = this.requestedSymbol;
    const previousInterval = this.requestedInterval;
    this.requestedSymbol = nextSymbol;
    this.requestedInterval = nextInterval;
    this.closedByClient = false;

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.scheduleConnect(nextSymbol);
      return;
    }

    if (previousSymbol !== nextSymbol || previousInterval !== nextInterval) {
      if (
        this.socketOpenedWithSymbol &&
        (this.socketOpenedWithSymbol !== nextSymbol || this.socketOpenedWithInterval !== nextInterval)
      ) {
        this.closeCurrentSocketForReconnect();
        this.scheduleConnect(nextSymbol);
        return;
      }

      this.sendSubscribeIfOpen(nextSymbol);
    }
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
    this.closedByClient = true;
    this.clearConnectTimer();
    this.clearReconnectTimer();
    this.socketOpenedWithSymbol = '';
    this.socketOpenedWithInterval = '1m';
    this.requestedSymbol = '';
    this.requestedInterval = '1m';
    this.setStatus('closed');

    if (!this.ws) return;

    const ws = this.ws;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.close(1000, 'client disconnect');
  }

  private scheduleConnect(symbol: string) {
    if (typeof window === 'undefined') return;

    this.clearConnectTimer();
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      if (this.closedByClient || !this.requestedSymbol) return;
      this.connect(this.requestedSymbol || symbol, this.requestedInterval);
    }, 100);
  }

  private connect(symbol: string, interval = '1m') {
    if (typeof window === 'undefined') return;

    this.clearConnectTimer();
    this.clearReconnectTimer();
    this.socketOpenedWithSymbol = symbol;
    this.socketOpenedWithInterval = normalizeInterval(interval);
    this.setStatus('connecting');

    const ws = new WebSocket(buildSpotWsUrl(symbol, this.socketOpenedWithInterval));
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus('open');
      const latestSymbol = this.requestedSymbol;
      const latestInterval = this.requestedInterval;
      if (
        latestSymbol &&
        (latestSymbol !== this.socketOpenedWithSymbol || latestInterval !== this.socketOpenedWithInterval)
      ) {
        if (latestInterval !== this.socketOpenedWithInterval) {
          this.closeCurrentSocketForReconnect();
          this.scheduleConnect(latestSymbol);
          return;
        }
        this.sendSubscribeIfOpen(latestSymbol);
      }
    };

    ws.onmessage = (event) => {
      if (event.data === 'pong') return;

      try {
        const message = JSON.parse(event.data) as SpotMarketRealtimeMessage;
        this.dispatch(message);
      } catch (err) {
        console.warn('[marketRealtime] spot WS parse error:', err);
      }
    };

    ws.onerror = () => {
      // ignore transient websocket errors in dev
    };

    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
      }
      this.setStatus('closed');

      if (this.closedByClient || !this.requestedSymbol) return;

      this.clearReconnectTimer();
      this.reconnectTimer = window.setTimeout(() => {
        this.connect(this.requestedSymbol, this.requestedInterval);
      }, 1500);
    };
  }

  private closeCurrentSocketForReconnect() {
    this.clearConnectTimer();
    this.clearReconnectTimer();
    this.socketOpenedWithSymbol = '';
    this.socketOpenedWithInterval = '1m';
    this.setStatus('closed');

    if (!this.ws) return;

    const ws = this.ws;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.close(1000, 'symbol changed');
  }

  private sendSubscribeIfOpen(symbol: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      this.ws.send(`subscribe:${symbol}`);
    } catch (err) {
      console.warn('[marketRealtime] spot subscribe failed:', err);
    }
  }

  private dispatch(message: SpotMarketRealtimeMessage) {
    if (message.type === 'spot_market_snapshot') {
      this.emit('snapshot', message);
      return;
    }

    if (message.type === 'spot_trade') {
      this.emit('trade', message);
      return;
    }

    if (message.type === 'spot_depth_update') {
      this.emit('depth', message);
      return;
    }

    if (message.type === 'spot_ticker_update') {
      this.emit('ticker', message);
      return;
    }

    if (message.type === 'spot_kline_update') {
      this.emit('kline', message);
    }
  }

  private emit(type: SpotMarketRealtimeEventType, message: SpotMarketRealtimeMessage) {
    const bucket = this.handlers.get(type);
    if (!bucket?.size) return;

    for (const handler of Array.from(bucket)) {
      handler(message);
    }
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setStatus(status: SpotMarketConnectionStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const handler of Array.from(this.statusHandlers)) {
      handler(status);
    }
  }

  private clearConnectTimer() {
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }
}

export const spotMarketRealtime = new SpotMarketRealtimeClient();
