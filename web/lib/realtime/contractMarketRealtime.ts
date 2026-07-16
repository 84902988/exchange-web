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
  transitionGeneration?: number;
};

export type ContractKlineResolutionIdentity = Readonly<{
  symbol: string;
  interval: string;
  ownerId: string;
  transitionGeneration: number;
}>;

type ContractRealtimeProtocolMode = 'idle' | 'legacy' | 'domain';

type ContractKlineOwnerState = 'ACTIVE' | 'SUSPENDED' | 'DESTROYED';

type ContractKlineOwner = ContractKlineRealtimeSession & {
  id: number;
  releaseEvents: () => void;
  state: ContractKlineOwnerState;
  transitionGeneration: number;
};

type ContractKlineResolutionTransition = Readonly<{
  candidate: ContractKlineResolutionIdentity;
  rollbackTarget: ContractKlineResolutionIdentity | null;
}>;

function normalizeSymbol(symbol: string) {
  return String(symbol || '').trim().toUpperCase();
}

function normalizeTransitionGeneration(value: unknown) {
  const normalized = Math.floor(Number(value));
  return Number.isInteger(normalized) && normalized > 0 ? normalized : 0;
}

function normalizeKlineResolutionIdentity(
  identity: ContractKlineResolutionIdentity,
): ContractKlineResolutionIdentity | null {
  const symbol = normalizeSymbol(identity.symbol);
  const interval = normalizeContractMarketInterval(identity.interval);
  const ownerId = String(identity.ownerId || '').trim();
  const transitionGeneration = normalizeTransitionGeneration(identity.transitionGeneration);
  if (!symbol || !ownerId || !transitionGeneration) return null;
  return { symbol, interval, ownerId, transitionGeneration };
}

function sameKlineResolutionIdentity(
  left?: ContractKlineResolutionIdentity | null,
  right?: ContractKlineResolutionIdentity | null,
) {
  return Boolean(
    left
    && right
    && left.symbol === right.symbol
    && left.interval === right.interval
    && left.ownerId === right.ownerId
    && left.transitionGeneration === right.transitionGeneration
  );
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
  private activeKlineResolution: ContractKlineResolutionIdentity | null = null;
  private committedKlineResolution: ContractKlineResolutionIdentity | null = null;
  private klineResolutionTransitions = new Map<number, ContractKlineResolutionTransition>();
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
    this.destroyAllKlineOwners();
    this.clearKlineResolutionState();
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
    const previousKlineSession = this.getActiveKlineSession();
    const removedActiveKlineOwner = previousKlineSession?.symbol !== nextSymbol
      ? previousKlineSession
      : null;
    const clearKlineOwners = Array.from(this.klineOwners.values()).some(
      (owner) => owner.symbol !== nextSymbol,
    );
    if (clearKlineOwners) {
      this.destroyKlineOwnersExcept(nextSymbol);
    }
    this.clearKlineResolutionStateExcept(nextSymbol);
    this.activeMarketOwner = ownerId;
    this.marketSymbol = nextSymbol;
    this.protocolMode = 'domain';
    this.requestedSymbol = nextSymbol;
    this.closedByClient = false;

    const activeKline = this.getActiveKlineSessionForSymbol(nextSymbol);
    if (activeKline) {
      this.requestedInterval = activeKline.interval;
    } else if (clearKlineOwners) {
      this.requestedInterval = '1m';
    }

    if (!getConfiguredWsUrl(nextSymbol, this.requestedInterval)) {
      this.setStatus('disconnected');
    } else if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.scheduleConnect(nextSymbol, this.requestedInterval);
    } else if (previousMode !== 'domain' || previousSymbol !== nextSymbol) {
      if (previousMode === 'domain' && previousSymbol) {
        this.sendDomainCommand('unsubscribe', 'market', previousSymbol);
      }
      if (removedActiveKlineOwner) {
        this.sendDomainCommand(
          'unsubscribe',
          'kline',
          removedActiveKlineOwner.symbol,
          removedActiveKlineOwner.interval,
        );
      }
      this.sendDomainCommand('subscribe', 'market', nextSymbol);
      if (activeKline) {
        this.sendDomainCommand('subscribe', 'kline', activeKline.symbol, activeKline.interval);
      }
    }

    return () => {
      if (this.activeMarketOwner !== ownerId) return;
      this.activeMarketOwner = 0;
      const remainingKline = this.getActiveKlineSession();
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

  beginKlineResolutionTransition(identity: ContractKlineResolutionIdentity) {
    const candidate = normalizeKlineResolutionIdentity(identity);
    if (!candidate) return false;
    if (sameKlineResolutionIdentity(this.activeKlineResolution, candidate)) return true;
    if (
      this.activeKlineResolution
      && candidate.symbol === this.activeKlineResolution.symbol
      && candidate.transitionGeneration === this.activeKlineResolution.transitionGeneration
      && candidate.interval === this.activeKlineResolution.interval
    ) {
      const transition = this.klineResolutionTransitions.get(candidate.transitionGeneration);
      this.activeKlineResolution = candidate;
      if (transition) {
        this.klineResolutionTransitions.set(candidate.transitionGeneration, {
          ...transition,
          candidate,
        });
      }
      if (this.committedKlineResolution?.transitionGeneration === candidate.transitionGeneration) {
        this.committedKlineResolution = candidate;
      }
      return true;
    }
    if (
      this.activeKlineResolution
      && candidate.symbol === this.activeKlineResolution.symbol
      && candidate.transitionGeneration < this.activeKlineResolution.transitionGeneration
    ) return false;

    const previousSession = this.getActiveKlineSession();
    const rollbackTarget = this.committedKlineResolution?.symbol === candidate.symbol
      ? this.committedKlineResolution
      : null;
    this.klineResolutionTransitions.set(candidate.transitionGeneration, {
      candidate,
      rollbackTarget,
    });
    this.activeKlineResolution = candidate;
    for (const owner of this.klineOwners.values()) {
      if (owner.state !== 'DESTROYED') owner.state = 'SUSPENDED';
    }
    const matchingOwner = this.getLatestKlineOwnerForIdentity(candidate);
    if (matchingOwner) {
      matchingOwner.transitionGeneration = candidate.transitionGeneration;
      matchingOwner.state = 'ACTIVE';
    }
    this.protocolMode = 'domain';
    this.closedByClient = false;
    this.requestedSymbol = this.marketSymbol || candidate.symbol;
    this.requestedInterval = candidate.interval;
    this.ensureDomainSocket(this.requestedSymbol, candidate.interval);
    this.switchKlineSession(previousSession, candidate);
    return true;
  }

  commitKlineResolutionTransition(identity: ContractKlineResolutionIdentity) {
    const candidate = normalizeKlineResolutionIdentity(identity);
    if (!candidate || !sameKlineResolutionIdentity(this.activeKlineResolution, candidate)) return false;
    const transition = this.klineResolutionTransitions.get(candidate.transitionGeneration);
    if (!transition || !sameKlineResolutionIdentity(transition.candidate, candidate)) return false;

    this.committedKlineResolution = candidate;
    for (const owner of Array.from(this.klineOwners.values())) {
      if (
        owner.symbol === candidate.symbol
        && (
          owner.interval !== candidate.interval
          || (
            owner.transitionGeneration > 0
            && owner.transitionGeneration !== candidate.transitionGeneration
          )
        )
      ) this.destroyKlineOwner(owner);
    }
    const matchingOwner = this.getLatestKlineOwnerForIdentity(candidate);
    if (matchingOwner) matchingOwner.state = 'ACTIVE';
    for (const [generation] of this.klineResolutionTransitions) {
      if (generation <= candidate.transitionGeneration) {
        this.klineResolutionTransitions.delete(generation);
      }
    }
    return true;
  }

  rollbackKlineResolutionTransition(identity: ContractKlineResolutionIdentity) {
    const candidate = normalizeKlineResolutionIdentity(identity);
    if (!candidate || !sameKlineResolutionIdentity(this.activeKlineResolution, candidate)) return false;
    const transition = this.klineResolutionTransitions.get(candidate.transitionGeneration);
    if (!transition || !sameKlineResolutionIdentity(transition.candidate, candidate)) return false;

    const previousSession = this.getActiveKlineSession();
    for (const owner of Array.from(this.klineOwners.values())) {
      if (owner.transitionGeneration === candidate.transitionGeneration) {
        this.destroyKlineOwner(owner);
      } else if (owner.state !== 'DESTROYED') {
        owner.state = 'SUSPENDED';
      }
    }
    const target = transition.rollbackTarget;
    this.activeKlineResolution = target;
    this.committedKlineResolution = target;
    if (target) {
      const restoredOwner = this.getLatestKlineOwnerForIdentity(target);
      if (restoredOwner) restoredOwner.state = 'ACTIVE';
    }
    this.klineResolutionTransitions.delete(candidate.transitionGeneration);
    this.requestedSymbol = this.marketSymbol || target?.symbol || '';
    this.requestedInterval = target?.interval || '1m';
    this.switchKlineSession(previousSession, target);
    this.closeDomainSocketIfIdle();
    return true;
  }

  releaseKlineResolutionOwner(identity: ContractKlineResolutionIdentity) {
    const target = normalizeKlineResolutionIdentity(identity);
    if (!target || !sameKlineResolutionIdentity(this.activeKlineResolution, target)) return false;
    const previousSession = this.getActiveKlineSession();
    this.clearKlineResolutionState();
    for (const owner of this.klineOwners.values()) {
      if (owner.state !== 'DESTROYED') owner.state = 'SUSPENDED';
    }
    this.requestedSymbol = this.marketSymbol;
    this.requestedInterval = '1m';
    this.switchKlineSession(previousSession, null);
    this.closeDomainSocketIfIdle();
    return true;
  }

  subscribeKline(
    session: ContractKlineRealtimeSession,
    handler: ContractMarketRealtimeHandler,
  ) {
    const symbol = normalizeSymbol(session.symbol);
    const interval = normalizeContractMarketInterval(session.interval);
    const transitionGeneration = normalizeTransitionGeneration(session.transitionGeneration);
    if (!symbol) return () => undefined;

    const previousMode = this.protocolMode;
    const previousSession = this.getActiveKlineSession();
    const previousOwner = this.getActiveKlineOwner();
    const matchesResolutionAuthority = Boolean(
      this.activeKlineResolution
      && this.activeKlineResolution.symbol === symbol
      && this.activeKlineResolution.interval === interval
      && this.activeKlineResolution.transitionGeneration === transitionGeneration
    );
    const nextOwnerState: ContractKlineOwnerState = (
      this.activeKlineResolution && !matchesResolutionAuthority
    ) ? 'SUSPENDED' : 'ACTIVE';
    if (previousOwner && nextOwnerState === 'ACTIVE') previousOwner.state = 'SUSPENDED';

    const ownerId = this.klineOwnerSequence + 1;
    this.klineOwnerSequence = ownerId;
    const owner: ContractKlineOwner = {
      id: ownerId,
      symbol,
      interval,
      transitionGeneration,
      releaseEvents: () => undefined,
      state: nextOwnerState,
    };
    owner.releaseEvents = this.subscribe('kline', (message) => {
      if (owner.state !== 'ACTIVE') return;
      const messageSymbol = normalizeSymbol(message.symbol || '');
      const messageInterval = message.interval
        ? normalizeContractMarketInterval(message.interval)
        : '';
      if (messageSymbol && messageSymbol !== owner.symbol) return;
      if (messageInterval && messageInterval !== owner.interval) return;
      handler(message);
    });
    this.klineOwners.set(ownerId, owner);
    this.protocolMode = 'domain';
    this.closedByClient = false;
    this.requestedSymbol = this.marketSymbol || symbol;
    this.requestedInterval = this.activeKlineResolution?.interval || interval;

    if (!getConfiguredWsUrl(this.requestedSymbol, this.requestedInterval)) {
      this.setStatus('disconnected');
    } else if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.scheduleConnect(this.requestedSymbol, this.requestedInterval);
    } else {
      if (previousMode !== 'domain' && this.marketSymbol) {
        this.sendDomainCommand('subscribe', 'market', this.marketSymbol);
      }
      if (!this.activeKlineResolution && owner.state === 'ACTIVE') {
        this.switchKlineSession(previousSession, owner);
      }
    }

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const wasActive = owner.state === 'ACTIVE';
      this.destroyKlineOwner(owner);
      if (!wasActive) return;
      if (!this.activeKlineResolution) {
        this.switchKlineSession(owner, null);
        this.requestedSymbol = this.marketSymbol;
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
    this.destroyAllKlineOwners();
    this.clearKlineResolutionState();
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
    return Array.from(this.klineOwners.values()).find(
      (owner) => owner.state === 'ACTIVE',
    ) ?? null;
  }

  private getActiveKlineSession(): ContractKlineRealtimeSession | null {
    return this.activeKlineResolution ?? this.getActiveKlineOwner();
  }

  private getActiveKlineSessionForSymbol(symbol: string) {
    const activeSession = this.getActiveKlineSession();
    return activeSession?.symbol === normalizeSymbol(symbol) ? activeSession : null;
  }

  private getLatestKlineOwnerForIdentity(identity: ContractKlineResolutionIdentity) {
    const owners = Array.from(this.klineOwners.values());
    for (let index = owners.length - 1; index >= 0; index -= 1) {
      const owner = owners[index];
      if (
        owner.state !== 'DESTROYED'
        && owner.symbol === identity.symbol
        && owner.interval === identity.interval
      ) {
        return owner;
      }
    }
    return null;
  }

  private clearKlineResolutionState() {
    this.activeKlineResolution = null;
    this.committedKlineResolution = null;
    this.klineResolutionTransitions.clear();
  }

  private clearKlineResolutionStateExcept(symbol: string) {
    const normalizedSymbol = normalizeSymbol(symbol);
    if (this.activeKlineResolution?.symbol !== normalizedSymbol) {
      this.clearKlineResolutionState();
      return;
    }
    for (const [generation, transition] of this.klineResolutionTransitions) {
      if (transition.candidate.symbol !== normalizedSymbol) {
        this.klineResolutionTransitions.delete(generation);
      }
    }
  }

  private destroyKlineOwner(owner: ContractKlineOwner) {
    if (owner.state === 'DESTROYED') return;
    owner.state = 'DESTROYED';
    owner.releaseEvents();
    this.klineOwners.delete(owner.id);
  }

  private destroyAllKlineOwners() {
    for (const owner of Array.from(this.klineOwners.values())) {
      this.destroyKlineOwner(owner);
    }
  }

  private destroyKlineOwnersExcept(symbol: string) {
    const normalizedSymbol = normalizeSymbol(symbol);
    for (const owner of Array.from(this.klineOwners.values())) {
      if (owner.symbol !== normalizedSymbol) this.destroyKlineOwner(owner);
    }
  }

  private switchKlineSession(
    previousOwner: ContractKlineRealtimeSession | null,
    nextOwner: ContractKlineRealtimeSession | null,
  ) {
    if (
      this.protocolMode !== 'domain'
      || this.sameKlineSession(previousOwner, nextOwner)
    ) return;
    if (previousOwner) {
      this.sendDomainCommand(
        'unsubscribe',
        'kline',
        previousOwner.symbol,
        previousOwner.interval,
      );
    }
    if (
      nextOwner
      && (!this.marketSymbol || this.marketSymbol === nextOwner.symbol)
    ) {
      this.sendDomainCommand('subscribe', 'kline', nextOwner.symbol, nextOwner.interval);
    }
  }

  private ensureDomainSocket(symbol: string, interval: string) {
    if (!getConfiguredWsUrl(symbol, interval)) {
      this.setStatus('disconnected');
      return;
    }
    if (!this.ws || this.ws.readyState === WebSocket.CLOSED || this.ws.readyState === WebSocket.CLOSING) {
      this.scheduleConnect(symbol, interval);
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
    if (
      this.protocolMode !== 'domain'
      || this.marketSymbol
      || this.activeKlineResolution
      || this.klineOwners.size > 0
    ) return;
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
        const activeKline = this.getActiveKlineSessionForSymbol(this.marketSymbol || this.requestedSymbol);
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

      const reconnectSymbol = this.marketSymbol || this.getActiveKlineSession()?.symbol || this.requestedSymbol;
      if (this.closedByClient || !reconnectSymbol) {
        this.setStatus('idle');
        return;
      }

      this.clearReconnectTimer();
      this.setStatus('reconnecting');
      this.reconnectTimer = window.setTimeout(() => {
        const nextSymbol = this.marketSymbol || this.getActiveKlineSession()?.symbol || this.requestedSymbol;
        if (!nextSymbol) return;
        this.connect(nextSymbol, this.getActiveKlineSession()?.interval || this.requestedInterval);
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
