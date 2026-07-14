'use client';

import { getRuntimeApiBaseUrl } from '@/lib/api/core/baseUrl';

export type ContractMarketRealtimeEventType = 'quote' | 'depth' | 'trade' | 'kline' | 'state';
export type ContractMarketRealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
export type ContractMarketRealtimeDomain = 'market' | 'kline';

export type ContractMarketRealtimeMessage = {
  type: string;
  domain?: ContractMarketRealtimeDomain | string | null;
  symbol?: string;
  interval?: string;
  source?: string | null;
  quote_source?: string | null;
  kline_mode?: string | null;
  price_source?: string | null;
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

export type ContractMarketSession = {
  symbol: string;
  interval?: string;
};

export type ContractKlineRealtimeSession = {
  symbol: string;
  interval: string;
};

type ContractRealtimeProtocolMode = 'idle' | 'legacy' | 'domain';

type ContractKlineOwner = ContractKlineRealtimeSession & {
  id: number;
  releaseEvents: () => void;
  retired: boolean;
};

function normalizeSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase();
}

export function normalizeContractMarketInterval(interval?: string) {
  const normalized = String(interval || '1m').trim();
  if (normalized === '1M') return '1M';
  return normalized.toLowerCase() || '1m';
}

function appendMarketParams(rawUrl: string, symbol: string, interval?: string) {
  const normalizedSymbol = normalizeSymbol(symbol);
  if (!normalizedSymbol) return '';

  const normalizedInterval = normalizeContractMarketInterval(interval);

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

function normalizeDomain(domain?: string | null) {
  const normalized = String(domain || '').trim().toLowerCase();
  return normalized === 'market' || normalized === 'kline' ? normalized : null;
}

export function isContractMarketDomainMessage(message: ContractMarketRealtimeMessage) {
  return normalizeDomain(message.domain) === 'market';
}

export function isContractKlineDomainMessage(message: ContractMarketRealtimeMessage) {
  return normalizeDomain(message.domain) === 'kline';
}

export class ContractMarketRealtimeClient {
  private ws: WebSocket | null = null;
  private connectTimer: number | null = null;
  private reconnectTimer: number | null = null;
  private socketOpenedWithSymbol = '';
  private socketOpenedWithInterval = '1m';
  private requestedSymbol = '';
  private requestedInterval = '1m';
  private protocolMode: ContractRealtimeProtocolMode = 'idle';
  private marketSymbol = '';
  private marketOwnerSequence = 0;
  private activeMarketOwner = 0;
  private klineOwnerSequence = 0;
  private klineOwners = new Map<number, ContractKlineOwner>();
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
    const nextInterval = normalizeContractMarketInterval(session.interval);

    const previousSymbol = this.requestedSymbol;
    const previousInterval = this.requestedInterval;
    const previousMode = this.protocolMode;
    this.protocolMode = 'legacy';
    this.marketSymbol = '';
    this.activeMarketOwner = 0;
    this.retireAllKlineOwners();
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

    if (previousMode !== 'legacy' || previousSymbol !== nextSymbol || previousInterval !== nextInterval) {
      this.sendLegacySubscribeIfOpen(nextSymbol, nextInterval);
    }
  }

  setMarketSession(symbol: string) {
    const nextSymbol = normalizeSymbol(symbol);
    if (!nextSymbol) return () => undefined;

    const ownerId = this.marketOwnerSequence + 1;
    this.marketOwnerSequence = ownerId;
    const previousMode = this.protocolMode;
    const previousSymbol = this.marketSymbol;
    this.activeMarketOwner = ownerId;
    this.marketSymbol = nextSymbol;
    this.protocolMode = 'domain';
    this.requestedSymbol = nextSymbol;
    this.closedByClient = false;

    const activeKline = this.getActiveKlineOwnerForSymbol(nextSymbol);
    if (activeKline) {
      this.requestedInterval = activeKline.interval;
    }

    if (!getConfiguredWsUrl(nextSymbol, this.requestedInterval)) {
      this.setStatus('disconnected');
    } else if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.scheduleConnect(nextSymbol, this.requestedInterval);
    } else if (previousMode !== 'domain' || previousSymbol !== nextSymbol) {
      if (previousMode === 'domain' && previousSymbol) {
        this.sendDomainCommand('unsubscribe', 'market', previousSymbol);
      }
      this.sendDomainCommand('subscribe', 'market', nextSymbol);
      if (activeKline) {
        this.sendDomainCommand('subscribe', 'kline', activeKline.symbol, activeKline.interval);
      }
    }

    return () => {
      if (this.activeMarketOwner !== ownerId) return;
      this.activeMarketOwner = 0;
      const remainingKline = this.getActiveKlineOwner();
      const remainingKlineWasActive = remainingKline?.symbol === this.marketSymbol;
      if (this.protocolMode === 'domain') {
        this.sendDomainCommand('unsubscribe', 'market', nextSymbol);
      }
      this.marketSymbol = '';
      this.requestedSymbol = remainingKline?.symbol || '';
      this.requestedInterval = remainingKline?.interval || '1m';
      if (remainingKline && !remainingKlineWasActive && this.protocolMode === 'domain') {
        this.sendDomainCommand('subscribe', 'kline', remainingKline.symbol, remainingKline.interval);
      }
      this.closeDomainSocketIfIdle();
    };
  }

  subscribeKline(
    session: ContractKlineRealtimeSession,
    handler: ContractMarketRealtimeHandler,
  ) {
    const symbol = normalizeSymbol(session.symbol);
    const interval = normalizeContractMarketInterval(session.interval);
    if (!symbol) return () => undefined;

    const previousMode = this.protocolMode;
    const previousOwner = this.getActiveKlineOwner();
    if (previousOwner) {
      this.retireKlineOwner(previousOwner);
    }

    const ownerId = this.klineOwnerSequence + 1;
    this.klineOwnerSequence = ownerId;
    const owner: ContractKlineOwner = {
      id: ownerId,
      symbol,
      interval,
      releaseEvents: this.subscribe('kline', handler),
      retired: false,
    };
    this.klineOwners.set(ownerId, owner);
    this.protocolMode = 'domain';
    this.closedByClient = false;
    this.requestedSymbol = this.marketSymbol || symbol;
    this.requestedInterval = interval;

    if (!getConfiguredWsUrl(this.requestedSymbol, interval)) {
      this.setStatus('disconnected');
    } else if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.scheduleConnect(this.requestedSymbol, interval);
    } else {
      if (previousMode !== 'domain' && this.marketSymbol) {
        this.sendDomainCommand('subscribe', 'market', this.marketSymbol);
      }
      if (!this.sameKlineSession(previousOwner, { symbol, interval })) {
        if (previousOwner) {
          this.sendDomainCommand('unsubscribe', 'kline', previousOwner.symbol, previousOwner.interval);
        }
        if (!this.marketSymbol || this.marketSymbol === symbol) {
          this.sendDomainCommand('subscribe', 'kline', symbol, interval);
        }
      }
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const activeOwner = this.getActiveKlineOwner();
      this.retireKlineOwner(owner);
      if (activeOwner?.id !== ownerId) return;

      if (this.protocolMode === 'domain') {
        this.sendDomainCommand('unsubscribe', 'kline', activeOwner.symbol, activeOwner.interval);
      }
      this.requestedSymbol = this.marketSymbol || '';
      if (!this.marketSymbol) {
        this.requestedInterval = '1m';
      }
      this.closeDomainSocketIfIdle();
    };
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
    this.protocolMode = 'idle';
    this.marketSymbol = '';
    this.activeMarketOwner = 0;
    this.retireAllKlineOwners();
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

  private getActiveKlineOwner() {
    let activeOwner: ContractKlineOwner | null = null;
    for (const owner of this.klineOwners.values()) {
      activeOwner = owner;
    }
    return activeOwner;
  }

  private getActiveKlineOwnerForSymbol(symbol: string) {
    const activeOwner = this.getActiveKlineOwner();
    return activeOwner?.symbol === normalizeSymbol(symbol) ? activeOwner : null;
  }

  private retireKlineOwner(owner: ContractKlineOwner) {
    if (owner.retired) return;
    owner.retired = true;
    owner.releaseEvents();
    this.klineOwners.delete(owner.id);
  }

  private retireAllKlineOwners() {
    for (const owner of Array.from(this.klineOwners.values())) {
      this.retireKlineOwner(owner);
    }
  }

  private sameKlineSession(
    left?: ContractKlineRealtimeSession | null,
    right?: ContractKlineRealtimeSession | null,
  ) {
    return Boolean(
      left
      && right
      && normalizeSymbol(left.symbol) === normalizeSymbol(right.symbol)
      && normalizeContractMarketInterval(left.interval) === normalizeContractMarketInterval(right.interval),
    );
  }

  private closeDomainSocketIfIdle() {
    if (this.protocolMode !== 'domain' || this.marketSymbol || this.klineOwners.size > 0) return;
    this.closedByClient = true;
    this.clearConnectTimer();
    this.clearReconnectTimer();
    this.protocolMode = 'idle';
    this.setStatus('idle');
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    ws.close(1000, 'domain owners released');
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
    this.socketOpenedWithInterval = normalizeContractMarketInterval(interval);
    this.setStatus(this.status === 'disconnected' || this.status === 'reconnecting' ? 'reconnecting' : 'connecting');

    const ws = new WebSocket(wsUrl);
    this.ws = ws;

    ws.onopen = () => {
      this.setStatus('connected');
      if (this.protocolMode === 'domain') {
        if (this.marketSymbol) {
          this.sendDomainCommand('subscribe', 'market', this.marketSymbol);
        }
        const activeKline = this.getActiveKlineOwnerForSymbol(this.marketSymbol || this.requestedSymbol);
        if (activeKline) {
          this.sendDomainCommand('subscribe', 'kline', activeKline.symbol, activeKline.interval);
        }
        return;
      }
      const latestSymbol = this.requestedSymbol;
      const latestInterval = this.requestedInterval;
      if (
        latestSymbol &&
        (latestSymbol !== this.socketOpenedWithSymbol || latestInterval !== this.socketOpenedWithInterval)
      ) {
        this.sendLegacySubscribeIfOpen(latestSymbol, latestInterval);
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

      const reconnectSymbol = this.marketSymbol || this.getActiveKlineOwner()?.symbol || this.requestedSymbol;
      if (this.closedByClient || !reconnectSymbol) {
        this.setStatus('idle');
        return;
      }

      this.clearReconnectTimer();
      this.setStatus('reconnecting');
      this.reconnectTimer = window.setTimeout(() => {
        const nextSymbol = this.marketSymbol || this.getActiveKlineOwner()?.symbol || this.requestedSymbol;
        if (!nextSymbol) return;
        this.connect(nextSymbol, this.getActiveKlineOwner()?.interval || this.requestedInterval);
      }, 1500);
    };
  }

  private sendLegacySubscribeIfOpen(symbol: string, interval = '1m') {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    try {
      this.ws.send(JSON.stringify({
        type: 'subscribe',
        symbol,
        interval: normalizeContractMarketInterval(interval),
      }));
    } catch (err) {
      console.warn('[contractMarketRealtime] subscribe failed:', err);
    }
  }

  private sendDomainCommand(
    op: 'subscribe' | 'unsubscribe',
    domain: ContractMarketRealtimeDomain,
    symbol: string,
    interval?: string,
  ) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const payload: Record<string, string> = {
      op,
      domain,
      symbol: normalizeSymbol(symbol),
    };
    if (domain === 'kline') {
      payload.interval = normalizeContractMarketInterval(interval);
    }
    try {
      this.ws.send(JSON.stringify(payload));
    } catch (err) {
      console.warn('[contractMarketRealtime] domain command failed:', err);
    }
  }

  private dispatch(message: ContractMarketRealtimeMessage) {
    const type = String(message.type || '').toLowerCase();
    if (type === 'contract_market_snapshot') {
      if (this.protocolMode === 'domain' && !isContractMarketDomainMessage(message)) return;
      this.dispatchSnapshot(message);
      return;
    }
    if (type === 'contract_kline_snapshot') {
      if (this.protocolMode === 'domain' && !isContractKlineDomainMessage(message)) return;
      this.dispatchKlineSnapshot(message);
      return;
    }
    const eventType = getEventType(message);
    if (!eventType) return;
    if (this.protocolMode === 'domain') {
      const domainMatches = eventType === 'kline'
        ? isContractKlineDomainMessage(message)
        : isContractMarketDomainMessage(message);
      if (!domainMatches) return;
    }
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
        domain: message.domain,
        symbol,
        interval,
        data: marketState,
        market_state: marketState,
        kline_current_candle: (marketState as Record<string, unknown>).kline_current_candle,
      });
    }
    const quote = data.quote;
    if (quote) {
      this.emit('quote', { type: 'contract_quote', domain: message.domain, symbol, interval, data: quote, quote });
    }
    const depth = data.depth;
    if (depth) {
      this.emit('depth', { type: 'contract_depth', domain: message.domain, symbol, interval, data: depth, depth });
    }
    const trades = Array.isArray(data.trades) ? data.trades : [];
    if (trades.length > 0) {
      this.emit('trade', { type: 'contract_trade', domain: message.domain, symbol, interval, data: trades, trades });
    }
    const klines = data.klines && typeof data.klines === 'object'
      ? data.klines as Record<string, unknown>
      : {};
    const kline = interval ? klines[interval] : Object.values(klines)[0];
    if (kline) {
      this.emit('kline', { type: 'contract_kline_update', domain: message.domain, symbol, interval, data: kline, kline });
    }
  }

  private dispatchKlineSnapshot(message: ContractMarketRealtimeMessage) {
    const kline = message.kline || message.data;
    if (!kline || typeof kline !== 'object') return;
    this.emit('kline', {
      type: 'contract_kline_update',
      domain: message.domain,
      symbol: message.symbol,
      interval: message.interval,
      source: message.source,
      quote_source: message.quote_source,
      data: kline,
      kline,
    });
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
