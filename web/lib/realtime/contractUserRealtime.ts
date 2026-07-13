'use client';

import { getRuntimeApiBaseUrl } from '../api/core/baseUrl';
import { getAccessToken } from '../api/core/token';

export type ContractUserRealtimeEventType = 'snapshot' | 'account' | 'positions' | 'orders' | 'trades';
export type ContractUserRealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';

export type ContractUserRealtimeMessage = {
  type: string;
  event_id?: string;
  seq?: number | string;
  server_ts?: string;
  symbol?: string;
  account?: unknown;
  summary?: unknown;
  positions?: unknown;
  position?: unknown;
  position_summaries?: unknown;
  position_summary?: unknown;
  orders?: unknown;
  order?: unknown;
  trades?: unknown;
  trade?: unknown;
  payload?: unknown;
  data?: unknown;
};

export type ContractUserRealtimeHandler = (message: ContractUserRealtimeMessage) => void;
export type ContractUserRealtimeStatusHandler = (status: ContractUserRealtimeStatus) => void;

type ContractUserSession = {
  isLoggedIn: boolean;
  identityKey: string | null;
  symbol: string;
};

function normalizeSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase();
}

function normalizeIdentity(identity: string | null) {
  return String(identity || '').trim();
}

function getPayload(message: ContractUserRealtimeMessage) {
  if (message.payload && typeof message.payload === 'object' && !Array.isArray(message.payload)) {
    return message.payload as Record<string, unknown>;
  }
  if (message.data && typeof message.data === 'object' && !Array.isArray(message.data)) {
    return message.data as Record<string, unknown>;
  }
  return message as Record<string, unknown>;
}

function messageHasPayload(message: ContractUserRealtimeMessage, keys: string[]) {
  const payload = getPayload(message);
  return keys.some((key) => payload[key] !== undefined || message[key as keyof ContractUserRealtimeMessage] !== undefined);
}

function appendSessionParams(rawUrl: string, symbol: string) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) return '';

  const accessToken = getAccessToken();
  try {
    const url = new URL(rawUrl);
    if (!url.searchParams.has('symbol')) {
      url.searchParams.set('symbol', normalizedSymbol);
    }
    if (accessToken && !url.searchParams.has('access_token')) {
      url.searchParams.set('access_token', accessToken);
    }
    return url.toString();
  } catch {
    const params = new URLSearchParams({ symbol: normalizedSymbol });
    if (accessToken) {
      params.set('access_token', accessToken);
    }
    return rawUrl.includes('?')
      ? `${rawUrl}&${params.toString()}`
      : `${rawUrl}?${params.toString()}`;
  }
}

function getConfiguredWsUrl(symbol: string) {
  const explicitUrl = process.env.NEXT_PUBLIC_CONTRACT_USER_WS_URL?.trim();
  if (explicitUrl) {
    return appendSessionParams(explicitUrl, symbol);
  }

  try {
    const url = new URL('/contract/ws/private', getRuntimeApiBaseUrl());
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return appendSessionParams(url.toString(), symbol);
  } catch {
    return '';
  }
}

export class ContractUserRealtimeClient {
  private ws: WebSocket | null = null;
  private connectTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private socketOpenedWithSymbol = '';
  private socketOpenedWithIdentity = '';
  private requestedSymbol = '';
  private currentIdentity = '';
  private closedByClient = false;
  private loggedIn = false;
  private handlers = new Map<ContractUserRealtimeEventType, Set<ContractUserRealtimeHandler>>();
  private statusHandlers = new Set<ContractUserRealtimeStatusHandler>();
  private status: ContractUserRealtimeStatus = 'idle';

  setSession(session: ContractUserSession) {
    const nextSymbol = normalizeSymbol(session.symbol);
    const nextIdentity = normalizeIdentity(session.identityKey);
    const identityChanged = this.currentIdentity !== nextIdentity;
    if (identityChanged) {
      this.disconnect();
    }
    this.loggedIn = session.isLoggedIn;

    if (!session.isLoggedIn || !nextIdentity || !nextSymbol) {
      this.disconnect();
      return;
    }

    this.currentIdentity = nextIdentity;
    const previousSymbol = this.requestedSymbol;
    this.requestedSymbol = nextSymbol;
    this.closedByClient = false;

    if (!getConfiguredWsUrl(nextSymbol)) {
      this.setStatus('disconnected');
      return;
    }

    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.scheduleConnect(nextSymbol);
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

  subscribeStatus(handler: ContractUserRealtimeStatusHandler) {
    this.statusHandlers.add(handler);
    handler(this.status);
    return () => {
      this.statusHandlers.delete(handler);
    };
  }

  getStatus() {
    return this.status;
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
    this.clearConnectTimer();
    this.clearReconnectTimer();
    this.socketOpenedWithSymbol = '';
    this.socketOpenedWithIdentity = '';
    this.requestedSymbol = '';
    this.currentIdentity = '';
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

  private scheduleConnect(symbol: string) {
    if (typeof window === 'undefined') return;

    this.clearConnectTimer();
    const scheduledIdentity = this.currentIdentity;
    this.connectTimer = window.setTimeout(() => {
      this.connectTimer = null;
      if (
        this.closedByClient ||
        !this.loggedIn ||
        !this.requestedSymbol ||
        !scheduledIdentity ||
        this.currentIdentity !== scheduledIdentity
      ) return;
      this.connect(this.requestedSymbol || symbol, scheduledIdentity);
    }, 100);
  }

  private connect(symbol: string, identity: string) {
    if (typeof window === 'undefined') return;
    if (!identity || identity !== this.currentIdentity) return;

    const wsUrl = getConfiguredWsUrl(symbol);
    if (!wsUrl) return;

    this.clearConnectTimer();
    this.clearReconnectTimer();
    this.socketOpenedWithSymbol = symbol;
    this.socketOpenedWithIdentity = identity;
    this.setStatus(this.status === 'disconnected' || this.status === 'reconnecting' ? 'reconnecting' : 'connecting');

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      if (identity !== this.currentIdentity) {
        ws.close(1000, 'stale identity');
        return;
      }
      this.setStatus('connected');
      const latestSymbol = this.requestedSymbol;
      if (latestSymbol && latestSymbol !== this.socketOpenedWithSymbol) {
        this.sendSubscribeIfOpen(latestSymbol);
      }
    };

    ws.onmessage = (event) => {
      if (identity !== this.currentIdentity || identity !== this.socketOpenedWithIdentity) return;
      if (event.data === 'pong' || event.data === 'ping') return;

      try {
        const message = JSON.parse(event.data) as ContractUserRealtimeMessage;
        this.dispatch(message);
      } catch (err) {
        console.warn('[contractUserRealtime] WS parse error:', err);
      }
    };

    ws.onerror = () => {
      this.setStatus('disconnected');
    };

    ws.onclose = () => {
      if (this.ws === ws) {
        this.ws = null;
      }

      if (this.closedByClient || !this.loggedIn || !this.requestedSymbol) {
        this.setStatus('idle');
        return;
      }

      this.clearReconnectTimer();
      this.setStatus('reconnecting');
      this.reconnectTimer = window.setTimeout(() => {
        this.connect(this.requestedSymbol, this.currentIdentity);
      }, 1500);
    };
  }

  private sendSubscribeIfOpen(symbol: string) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      this.ws.send(JSON.stringify({ type: 'subscribe', symbol }));
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

    if (
      type.includes('position')
      || messageHasPayload(message, ['position', 'positions', 'position_summaries', 'position_summary'])
    ) {
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

  private clearConnectTimer() {
    if (this.connectTimer !== null) {
      window.clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private setStatus(status: ContractUserRealtimeStatus) {
    if (this.status === status) return;
    this.status = status;
    for (const handler of Array.from(this.statusHandlers)) {
      handler(status);
    }
  }
}

export const contractUserRealtime = new ContractUserRealtimeClient();
