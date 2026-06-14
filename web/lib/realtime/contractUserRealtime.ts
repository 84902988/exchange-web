'use client';

export type ContractUserRealtimeEventType = 'snapshot' | 'account' | 'positions' | 'orders' | 'trades';

export type ContractUserRealtimeMessage = {
  type: string;
  symbol?: string;
  account?: unknown;
  summary?: unknown;
  positions?: unknown;
  position?: unknown;
  orders?: unknown;
  order?: unknown;
  trades?: unknown;
  trade?: unknown;
  data?: unknown;
};

export type ContractUserRealtimeHandler = (message: ContractUserRealtimeMessage) => void;

type ContractUserSession = {
  isLoggedIn: boolean;
  symbol: string;
};

function normalizeSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase();
}

function getConfiguredWsUrl(symbol: string) {
  const explicitUrl = process.env.NEXT_PUBLIC_CONTRACT_USER_WS_URL;
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

function getPayload(message: ContractUserRealtimeMessage) {
  return message.data && typeof message.data === 'object' && !Array.isArray(message.data)
    ? message.data as Record<string, unknown>
    : message as Record<string, unknown>;
}

function messageHasPayload(message: ContractUserRealtimeMessage, keys: string[]) {
  const payload = getPayload(message);
  return keys.some((key) => payload[key] !== undefined || message[key as keyof ContractUserRealtimeMessage] !== undefined);
}

class ContractUserRealtimeClient {
  private ws: WebSocket | null = null;
  private reconnectTimer: number | null = null;
  private socketOpenedWithSymbol = '';
  private requestedSymbol = '';
  private closedByClient = false;
  private loggedIn = false;
  private handlers = new Map<ContractUserRealtimeEventType, Set<ContractUserRealtimeHandler>>();

  setSession(session: ContractUserSession) {
    const nextSymbol = normalizeSymbol(session.symbol);
    this.loggedIn = session.isLoggedIn;

    if (!session.isLoggedIn || !nextSymbol) {
      this.disconnect();
      return;
    }

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

  subscribe(type: ContractUserRealtimeEventType, handler: ContractUserRealtimeHandler) {
    const bucket = this.handlers.get(type) ?? new Set<ContractUserRealtimeHandler>();
    bucket.add(handler);
    this.handlers.set(type, bucket);

    return () => {
      this.unsubscribe(type, handler);
    };
  }

  unsubscribe(type: ContractUserRealtimeEventType, handler: ContractUserRealtimeHandler) {
    const bucket = this.handlers.get(type);
    if (!bucket) return;

    bucket.delete(handler);
    if (bucket.size === 0) {
      this.handlers.delete(type);
    }
  }

  disconnect() {
    this.closedByClient = true;
    this.loggedIn = false;
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
        const message = JSON.parse(event.data) as ContractUserRealtimeMessage;
        this.dispatch(message);
      } catch (err) {
        console.warn('[contractUserRealtime] WS parse error:', err);
      }
    };

    ws.onerror = () => {
      // REST polling remains the authoritative fallback.
    };

    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
      }

      if (this.closedByClient || !this.loggedIn || !this.requestedSymbol) return;

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
      console.warn('[contractUserRealtime] subscribe failed:', err);
    }
  }

  private dispatch(message: ContractUserRealtimeMessage) {
    const type = String(message.type || '').toLowerCase();
    const isSnapshot = type.includes('snapshot');

    if (isSnapshot) {
      this.emit('snapshot', message);
    }

    if (type.includes('account') || type.includes('summary') || messageHasPayload(message, ['account', 'summary'])) {
      this.emit('account', message);
    }

    if (type.includes('position') || messageHasPayload(message, ['position', 'positions'])) {
      this.emit('positions', message);
    }

    if (type.includes('order') || messageHasPayload(message, ['order', 'orders'])) {
      this.emit('orders', message);
    }

    if (type.includes('trade') || type.includes('fill') || messageHasPayload(message, ['trade', 'trades'])) {
      this.emit('trades', message);
    }
  }

  private emit(type: ContractUserRealtimeEventType, message: ContractUserRealtimeMessage) {
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

export const contractUserRealtime = new ContractUserRealtimeClient();
