'use client';

export type ContractMarketRealtimeEventType = 'quote' | 'depth' | 'trade' | 'kline';

export type ContractMarketRealtimeMessage = {
  type: string;
  symbol?: string;
  quote?: unknown;
  depth?: unknown;
  trade?: unknown;
  trades?: unknown;
  kline?: unknown;
  data?: unknown;
};

export type ContractMarketRealtimeHandler = (message: ContractMarketRealtimeMessage) => void;

function normalizeSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase();
}

function getConfiguredWsUrl(symbol: string) {
  const explicitUrl = process.env.NEXT_PUBLIC_CONTRACT_MARKET_WS_URL;
  if (!explicitUrl) return '';

  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) return '';

  try {
    const url = new URL(explicitUrl);
    if (!url.searchParams.has('symbol')) {
      url.searchParams.set('symbol', normalizedSymbol);
    }
    return url.toString();
  } catch {
    return explicitUrl.includes('?')
      ? `${explicitUrl}&symbol=${encodeURIComponent(normalizedSymbol)}`
      : `${explicitUrl}?symbol=${encodeURIComponent(normalizedSymbol)}`;
  }
}

function getEventType(message: ContractMarketRealtimeMessage): ContractMarketRealtimeEventType | null {
  const type = String(message.type || '').toLowerCase();

  if (type.includes('quote')) return 'quote';
  if (type.includes('depth') || type.includes('orderbook')) return 'depth';
  if (type.includes('kline') || type.includes('candle')) return 'kline';
  if (type.includes('trade')) return 'trade';

  return null;
}

class ContractMarketRealtimeClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private socketOpenedWithSymbol = '';
  private requestedSymbol = '';
  private closedByClient = false;
  private handlers = new Map<ContractMarketRealtimeEventType, Set<ContractMarketRealtimeHandler>>();

  setSymbol(symbol: string) {
    const nextSymbol = normalizeSymbol(symbol);
    if (!nextSymbol) return;

    const previousSymbol = this.requestedSymbol;
    this.requestedSymbol = nextSymbol;
    this.closedByClient = false;

    if (!getConfiguredWsUrl(nextSymbol)) {
      return;
    }

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.connect(nextSymbol);
      return;
    }

    if (previousSymbol !== nextSymbol) {
      this.sendSubscribeIfOpen(nextSymbol);
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

  disconnect() {
    this.closedByClient = true;
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

  private connect(symbol: string) {
    if (typeof window === 'undefined') return;

    const wsUrl = getConfiguredWsUrl(symbol);
    if (!wsUrl) return;

    this.clearReconnectTimer();
    this.socketOpenedWithSymbol = symbol;

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      const latestSymbol = this.requestedSymbol;
      if (latestSymbol && latestSymbol !== this.socketOpenedWithSymbol) {
        this.sendSubscribeIfOpen(latestSymbol);
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
      // Keep REST polling as the authoritative fallback.
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

  private sendSubscribeIfOpen(symbol: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      this.ws.send(`subscribe:${symbol}`);
    } catch (err) {
      console.warn('[contractMarketRealtime] subscribe failed:', err);
    }
  }

  private dispatch(message: ContractMarketRealtimeMessage) {
    const eventType = getEventType(message);
    if (!eventType) return;
    this.emit(eventType, message);
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
}

export const contractMarketRealtime = new ContractMarketRealtimeClient();
