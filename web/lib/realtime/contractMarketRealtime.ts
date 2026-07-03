'use client';

import { getRuntimeApiBaseUrl } from '@/lib/api/core/baseUrl';

export type ContractMarketRealtimeEventType = 'quote' | 'depth' | 'trade' | 'kline' | 'state';
export type ContractMarketRealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export type ContractMarketRealtimeMessage = {
  type: string;
  symbol?: string;
  interval?: string;
  quote?: unknown;
  depth?: unknown;
  trade?: unknown;
  trades?: unknown;
  kline?: unknown;
  market_state?: unknown;
  kline_current_candle?: unknown;
  data?: unknown;
};

export type ContractMarketRealtimeHandler = (message: ContractMarketRealtimeMessage) => void;
export type ContractMarketRealtimeStatusHandler = (status: ContractMarketRealtimeStatus) => void;

type ContractMarketSession = {
  symbol: string;
  interval?: string;
};

function normalizeSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase();
}

function normalizeInterval(interval?: string) {
  return String(interval || '1m').trim().toLowerCase() || '1m';
}

function appendMarketParams(rawUrl: string, symbol: string, interval?: string) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) return '';

  const normalizedInterval = normalizeInterval(interval);

  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has('symbol')) {
      url.searchParams.set('symbol', normalizedSymbol);
    }
    if (!url.searchParams.has('interval')) {
      url.searchParams.set('interval', normalizedInterval);
    }
    return url.toString();
  } catch {
    const params = new URLSearchParams({ symbol: normalizedSymbol, interval: normalizedInterval });
    return rawUrl.includes('?')
      ? `${rawUrl}&${params.toString()}`
      : `${rawUrl}?${params.toString()}`;
  }
}

function getConfiguredWsUrl(symbol: string, interval?: string) {
  const explicitUrl = process.env.NEXT_PUBLIC_CONTRACT_MARKET_WS_URL?.trim();
  if (explicitUrl) {
    return appendMarketParams(explicitUrl, symbol, interval);
  }

  try {
    const url = new URL('/contract/market/ws', getRuntimeApiBaseUrl());
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return appendMarketParams(url.toString(), symbol, interval);
  } catch {
    return '';
  }
}

function getEventType(message: ContractMarketRealtimeMessage): ContractMarketRealtimeEventType | null {
  const type = String(message.type || '').toLowerCase();

  if (type.includes('market_state')) return 'state';
  if (type.includes('quote')) return 'quote';
  if (type.includes('depth') || type.includes('orderbook')) return 'depth';
  if (type.includes('kline') || type.includes('candle')) return 'kline';
  if (type.includes('trade')) return 'trade';

  return null;
}

class ContractMarketRealtimeClient {
  private ws: WebSocket | null = null;
  private connectTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private socketOpenedWithSymbol = '';
  private socketOpenedWithInterval = '1m';
  private requestedSymbol = '';
  private requestedInterval = '1m';
  private closedByClient = false;
  private handlers = new Map<ContractMarketRealtimeEventType, Set<ContractMarketRealtimeHandler>>();
  private statusHandlers = new Set<ContractMarketRealtimeStatusHandler>();
  private status: ContractMarketRealtimeStatus = 'idle';

  setSymbol(symbol: string) {
    this.setSession({ symbol, interval: this.requestedInterval });
  }

  setSession(session: ContractMarketSession) {
    const nextSymbol = normalizeSymbol(session.symbol);
    if (!nextSymbol) return;
    const nextInterval = normalizeInterval(session.interval);

    const previousSymbol = this.requestedSymbol;
    const previousInterval = this.requestedInterval;
    this.requestedSymbol = nextSymbol;
    this.requestedInterval = nextInterval;
    this.closedByClient = false;

    if (!getConfiguredWsUrl(nextSymbol, nextInterval)) {
      this.setStatus('disconnected');
      return;
    }

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.scheduleConnect(nextSymbol, nextInterval);
      return;
    }

    if (previousSymbol !== nextSymbol || previousInterval !== nextInterval) {
      this.sendSubscribeIfOpen(nextSymbol, nextInterval);
    }
  }

  subscribe(type: ContractMarketRealtimeEventType, handler: ContractMarketRealtimeHandler) {
    const bucket = this.handlers.get(type) ?? new Set<ContractMarketRealtimeHandler>();
    bucket.add(handler);
    this.handlers.set(type, bucket);

    return () => {
      this.unsubscribe(type, handler);
    };
  }

  unsubscribe(type: ContractMarketRealtimeEventType, handler: ContractMarketRealtimeHandler) {
    const bucket = this.handlers.get(type);
    if (!bucket) return;

    bucket.delete(handler);
    if (bucket.size === 0) {
      this.handlers.delete(type);
    }
  }

  subscribeStatus(handler: ContractMarketRealtimeStatusHandler) {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  getStatus() {
    return this.status;
  }

  disconnect() {
    this.closedByClient = true;
    this.clearConnectTimer();
    this.clearReconnectTimer();
    this.socketOpenedWithSymbol = '';
    this.socketOpenedWithInterval = '1m';
    this.requestedSymbol = '';
    this.requestedInterval = '1m';
    this.setStatus('idle');

    if (!this.ws) return;

    const ws = this.ws;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.close(1000, 'client disconnect');
  }

  private scheduleConnect(symbol: string, interval: string) {
    if (typeof window === 'undefined') return;

    this.clearConnectTimer();
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      if (this.closedByClient || !this.requestedSymbol) return;
      this.connect(this.requestedSymbol || symbol, this.requestedInterval || interval);
    }, 100);
  }

  private connect(symbol: string, interval: string) {
    if (typeof window === 'undefined') return;

    const wsUrl = getConfiguredWsUrl(symbol, interval);
    if (!wsUrl) return;

    this.clearConnectTimer();
    this.clearReconnectTimer();
    this.socketOpenedWithSymbol = symbol;
    this.socketOpenedWithInterval = normalizeInterval(interval);
    this.setStatus(this.status === 'disconnected' || this.status === 'reconnecting' ? 'reconnecting' : 'connecting');

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus('connected');
      const latestSymbol = this.requestedSymbol;
      const latestInterval = this.requestedInterval;
      if (
        latestSymbol &&
        (latestSymbol !== this.socketOpenedWithSymbol || latestInterval !== this.socketOpenedWithInterval)
      ) {
        this.sendSubscribeIfOpen(latestSymbol, latestInterval);
      }
    };

    ws.onmessage = (event) => {
      if (event.data === 'pong' || event.data === 'ping') return;

      try {
        const message = JSON.parse(event.data) as ContractMarketRealtimeMessage;
        this.dispatch(message);
      } catch (err) {
        console.warn('[contractMarketRealtime] WS parse error:', err);
      }
    };

    ws.onerror = () => {
      this.setStatus('disconnected');
    };

    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
      }

      if (this.closedByClient || !this.requestedSymbol) {
        this.setStatus('idle');
        return;
      }

      this.clearReconnectTimer();
      this.setStatus('reconnecting');
      this.reconnectTimer = window.setTimeout(() => {
        this.connect(this.requestedSymbol, this.requestedInterval);
      }, 1500);
    };
  }

  private sendSubscribeIfOpen(symbol: string, interval = '1m') {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      this.ws.send(JSON.stringify({ type: 'subscribe', symbol, interval: normalizeInterval(interval) }));
    } catch (err) {
      console.warn('[contractMarketRealtime] subscribe failed:', err);
    }
  }

  private dispatch(message: ContractMarketRealtimeMessage) {
    if (String(message.type || '').toLowerCase() === 'contract_market_snapshot') {
      this.dispatchSnapshot(message);
      return;
    }
    const eventType = getEventType(message);
    if (!eventType) return;
    this.emit(eventType, message);
  }

  private dispatchSnapshot(message: ContractMarketRealtimeMessage) {
    const data = message.data && typeof message.data === 'object'
      ? message.data as Record<string, unknown>
      : {};
    const symbol = message.symbol;
    const interval = message.interval;
    const marketState = data.market_state;
    if (marketState) {
      this.emit('state', {
        type: 'contract_market_state',
        symbol,
        interval,
        data: marketState,
        market_state: marketState,
        kline_current_candle: (marketState as Record<string, unknown>).kline_current_candle,
      });
    }
    const quote = data.quote;
    if (quote) {
      this.emit('quote', { type: 'contract_quote', symbol, interval, data: quote, quote });
    }
    const depth = data.depth;
    if (depth) {
      this.emit('depth', { type: 'contract_depth', symbol, interval, data: depth, depth });
    }
    const trades = Array.isArray(data.trades) ? data.trades : [];
    if (trades.length > 0) {
      this.emit('trade', { type: 'contract_trade', symbol, interval, data: trades, trades });
    }
    const klines = data.klines && typeof data.klines === 'object'
      ? data.klines as Record<string, unknown>
      : {};
    const kline = interval ? klines[interval] : Object.values(klines)[0];
    if (kline) {
      this.emit('kline', { type: 'contract_kline_update', symbol, interval, data: kline, kline });
    }
  }

  private emit(type: ContractMarketRealtimeEventType, message: ContractMarketRealtimeMessage) {
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

  private clearConnectTimer() {
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private setStatus(status: ContractMarketRealtimeStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const handler of Array.from(this.statusHandlers)) {
      handler(status);
    }
  }
}

export const contractMarketRealtime = new ContractMarketRealtimeClient();
