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

export type SpotMarketRealtimeEventType = 'snapshot' | 'trade' | 'depth';
export type SpotMarketRealtimeMessage =
  | SpotMarketSnapshotMessage
  | SpotMarketTradeMessage
  | SpotMarketDepthMessage;
export type SpotMarketRealtimeHandler = (message: SpotMarketRealtimeMessage) => void;

function buildSpotWsUrl(symbol: string) {
  const apiBase = getRuntimeApiBaseUrl();
  const url = new URL(apiBase);
  const protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${url.host}/market/ws/spot?symbol=${encodeURIComponent(symbol)}`;
}

function normalizeSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase();
}

class SpotMarketRealtimeClient {
  private ws: WebSocket | null = null;
  private connectTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private socketOpenedWithSymbol = '';
  private requestedSymbol = '';
  private closedByClient = false;
  private handlers = new Map<SpotMarketRealtimeEventType, Set<SpotMarketRealtimeHandler>>();

  setSymbol(symbol: string) {
    const nextSymbol = normalizeSymbol(symbol);
    if (!nextSymbol) return;

    const previousSymbol = this.requestedSymbol;
    this.requestedSymbol = nextSymbol;
    this.closedByClient = false;

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.scheduleConnect(nextSymbol);
      return;
    }

    if (previousSymbol !== nextSymbol) {
      if (this.socketOpenedWithSymbol && this.socketOpenedWithSymbol !== nextSymbol) {
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

  disconnect() {
    this.closedByClient = true;
    this.clearConnectTimer();
    this.clearReconnectTimer();
    this.socketOpenedWithSymbol = '';
    this.requestedSymbol = '';

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
      this.connect(this.requestedSymbol || symbol);
    }, 100);
  }

  private connect(symbol: string) {
    if (typeof window === 'undefined') return;

    this.clearConnectTimer();
    this.clearReconnectTimer();
    this.socketOpenedWithSymbol = symbol;

    const ws = new WebSocket(buildSpotWsUrl(symbol));
    this.ws = ws;

    ws.onopen = () => {
      const latestSymbol = this.requestedSymbol;
      if (latestSymbol && latestSymbol !== this.socketOpenedWithSymbol) {
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

      if (this.closedByClient || !this.requestedSymbol) return;

      this.clearReconnectTimer();
      this.reconnectTimer = window.setTimeout(() => {
        this.connect(this.requestedSymbol);
      }, 1500);
    };
  }

  private closeCurrentSocketForReconnect() {
    this.clearConnectTimer();
    this.clearReconnectTimer();
    this.socketOpenedWithSymbol = '';

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

  private clearConnectTimer() {
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }
}

export const spotMarketRealtime = new SpotMarketRealtimeClient();
