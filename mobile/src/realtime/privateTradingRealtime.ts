import {API_BASE_URL} from '../config/env';

export type PrivateTradingMarket = 'SPOT' | 'CONTRACT';

export type PrivateTradingRealtimeStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'stopped';

export type PrivateTradingWebSocketLike = {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: {data: unknown}) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

export type PrivateTradingRealtimeEvent = {
  market: PrivateTradingMarket;
  symbol: string;
  type: string;
};

export type ManagedPrivateTradingWebSocketOptions = {
  market: PrivateTradingMarket;
  symbol: string;
  accessToken: string;
  onInvalidate: (event: PrivateTradingRealtimeEvent) => void;
  onStatusChange?: (status: PrivateTradingRealtimeStatus) => void;
  createSocket?: (
    url: string,
    protocols: string[],
  ) => PrivateTradingWebSocketLike;
  now?: () => number;
  random?: () => number;
  heartbeatIntervalMs?: number;
  activityTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  reconnectJitterRatio?: number;
  connectTimeoutMs?: number;
  invalidateDebounceMs?: number;
};

const SOCKET_OPEN = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_ACTIVITY_TIMEOUT_MS = 45_000;
const DEFAULT_RECONNECT_BASE_MS = 1_500;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_RECONNECT_JITTER_RATIO = 0.2;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const DEFAULT_INVALIDATE_DEBOUNCE_MS = 150;

const SPOT_EVENT_TYPES = new Set([
  'spot_user_orders_snapshot',
  'spot_user_order_update',
  'spot_user_balance_update',
]);

const CONTRACT_EVENT_TYPES = new Set([
  'contract_user_snapshot',
  'contract_user_account_update',
  'contract_user_position_update',
  'contract_user_order_update',
  'contract_user_trade_update',
]);

function normalizeSymbol(value: unknown) {
  return String(value || '').trim().toUpperCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function websocketBaseUrl() {
  const base = API_BASE_URL.replace(/\/+$/, '');
  if (base.startsWith('https:')) {
    return `wss:${base.slice('https:'.length)}`;
  }
  if (base.startsWith('http:')) {
    return `ws:${base.slice('http:'.length)}`;
  }
  return base;
}

export function buildPrivateTradingWsUrl(
  market: PrivateTradingMarket,
  symbol: string,
) {
  const normalizedSymbol = normalizeSymbol(symbol);
  const path =
    market === 'SPOT' ? '/spot/ws/private' : '/contract/ws/private';
  return `${websocketBaseUrl()}${path}?symbol=${encodeURIComponent(
    normalizedSymbol,
  )}`;
}

export function getPrivateTradingWsProtocols(
  market: PrivateTradingMarket,
  accessToken: string,
) {
  return [
    market === 'SPOT' ? 'spot-auth' : 'contract-auth',
    accessToken,
  ];
}

function readMessageSymbol(message: Record<string, unknown>) {
  const direct = normalizeSymbol(message.symbol);
  if (direct) return direct;

  const payload = isRecord(message.payload) ? message.payload : null;
  const candidates = [
    payload,
    isRecord(message.order) ? message.order : null,
    isRecord(message.position) ? message.position : null,
    isRecord(message.trade) ? message.trade : null,
    payload && isRecord(payload.order) ? payload.order : null,
    payload && isRecord(payload.position) ? payload.position : null,
    payload && isRecord(payload.trade) ? payload.trade : null,
  ];
  for (const candidate of candidates) {
    const candidateSymbol = normalizeSymbol(candidate?.symbol);
    if (candidateSymbol) return candidateSymbol;
  }
  return '';
}

export function parsePrivateTradingRealtimeEvent(
  data: unknown,
  market: PrivateTradingMarket,
  symbol: string,
): PrivateTradingRealtimeEvent | null {
  if (typeof data !== 'string') return null;
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(message)) return null;

  const type = String(message.type || '').trim().toLowerCase();
  const allowedTypes =
    market === 'SPOT' ? SPOT_EVENT_TYPES : CONTRACT_EVENT_TYPES;
  if (!allowedTypes.has(type)) return null;

  // The server emits mark-to-market account/position changes every second.
  // Turning each mark tick into several private REST requests would create
  // avoidable load, so this bridge only invalidates on transactional events.
  if (
    market === 'CONTRACT' &&
    type === 'contract_user_account_update' &&
    (message.mark_only === true ||
      (isRecord(message.payload) && message.payload.mark_only === true))
  ) {
    return null;
  }

  const normalizedSymbol = normalizeSymbol(symbol);
  const messageSymbol = readMessageSymbol(message);
  if (messageSymbol && messageSymbol !== normalizedSymbol) return null;

  return {market, symbol: normalizedSymbol, type};
}

function defaultCreateSocket(
  url: string,
  protocols: string[],
): PrivateTradingWebSocketLike {
  return new WebSocket(
    url,
    protocols,
  ) as unknown as PrivateTradingWebSocketLike;
}

export class ManagedPrivateTradingWebSocket {
  private readonly options: Required<
    Pick<
      ManagedPrivateTradingWebSocketOptions,
      | 'createSocket'
      | 'now'
      | 'random'
      | 'heartbeatIntervalMs'
      | 'activityTimeoutMs'
      | 'reconnectBaseMs'
      | 'reconnectMaxMs'
      | 'reconnectJitterRatio'
      | 'connectTimeoutMs'
      | 'invalidateDebounceMs'
    >
  > &
    Omit<
      ManagedPrivateTradingWebSocketOptions,
      | 'createSocket'
      | 'now'
      | 'random'
      | 'heartbeatIntervalMs'
      | 'activityTimeoutMs'
      | 'reconnectBaseMs'
      | 'reconnectMaxMs'
      | 'reconnectJitterRatio'
      | 'connectTimeoutMs'
      | 'invalidateDebounceMs'
    >;

  private socket: PrivateTradingWebSocketLike | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private invalidateTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEvent: PrivateTradingRealtimeEvent | null = null;
  private active = false;
  private generation = 0;
  private reconnectAttempt = 0;
  private lastActivityAtMs = 0;
  private status: PrivateTradingRealtimeStatus = 'idle';

  constructor(options: ManagedPrivateTradingWebSocketOptions) {
    this.options = {
      ...options,
      symbol: normalizeSymbol(options.symbol),
      createSocket: options.createSocket || defaultCreateSocket,
      now: options.now || Date.now,
      random: options.random || Math.random,
      heartbeatIntervalMs:
        options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      activityTimeoutMs:
        options.activityTimeoutMs ?? DEFAULT_ACTIVITY_TIMEOUT_MS,
      reconnectBaseMs:
        options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS,
      reconnectMaxMs:
        options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS,
      reconnectJitterRatio:
        options.reconnectJitterRatio ?? DEFAULT_RECONNECT_JITTER_RATIO,
      connectTimeoutMs:
        options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
      invalidateDebounceMs:
        options.invalidateDebounceMs ?? DEFAULT_INVALIDATE_DEBOUNCE_MS,
    };
  }

  getStatus() {
    return this.status;
  }

  start() {
    if (this.active) return;
    if (!this.options.symbol || !this.options.accessToken) {
      this.setStatus('stopped');
      return;
    }
    this.active = true;
    this.generation += 1;
    this.reconnectAttempt = 0;
    this.connect(this.generation);
  }

  stop(reason = 'private trading owner released') {
    if (!this.active && this.status === 'stopped') return;
    this.active = false;
    this.generation += 1;
    this.clearTimers();
    this.pendingEvent = null;
    this.reconnectAttempt = 0;
    this.lastActivityAtMs = 0;
    this.retireSocket(1000, reason);
    this.setStatus('stopped');
  }

  private connect(generation: number) {
    if (!this.active || generation !== this.generation) return;
    this.clearReconnectTimer();
    this.setStatus('connecting');

    let socket: PrivateTradingWebSocketLike;
    try {
      socket = this.options.createSocket(
        buildPrivateTradingWsUrl(
          this.options.market,
          this.options.symbol,
        ),
        getPrivateTradingWsProtocols(
          this.options.market,
          this.options.accessToken,
        ),
      );
    } catch {
      this.scheduleReconnect(generation);
      return;
    }
    this.socket = socket;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.failSocket(socket, generation, 'private trading connect timeout');
    }, this.options.connectTimeoutMs);

    socket.onopen = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.clearConnectTimer();
      this.lastActivityAtMs = this.options.now();
      this.setStatus('open');
      this.startHeartbeat(generation);
    };
    socket.onmessage = event => {
      if (!this.isCurrent(socket, generation)) return;
      this.lastActivityAtMs = this.options.now();
      this.reconnectAttempt = 0;
      if (event.data === 'ping') {
        this.sendHeartbeatReply(socket, generation);
        return;
      }
      if (event.data === 'pong') return;
      if (typeof event.data !== 'string') return;
      try {
        const heartbeat = JSON.parse(event.data) as {type?: unknown};
        const heartbeatType = String(heartbeat?.type || '').toLowerCase();
        if (heartbeatType === 'ping') {
          this.sendHeartbeatReply(socket, generation);
          return;
        }
        if (heartbeatType === 'pong') return;
      } catch {
        // Only validated private state events are accepted below.
      }
      const privateEvent = parsePrivateTradingRealtimeEvent(
        event.data,
        this.options.market,
        this.options.symbol,
      );
      if (privateEvent) this.scheduleInvalidate(privateEvent, generation);
    };
    socket.onerror = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.failSocket(socket, generation, 'private trading socket error');
    };
    socket.onclose = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.socket = null;
      this.clearConnectTimer();
      this.clearHeartbeatTimer();
      this.scheduleReconnect(generation);
    };
  }

  private startHeartbeat(generation: number) {
    this.clearHeartbeatTimer();
    this.heartbeatTimer = setInterval(() => {
      if (!this.active || generation !== this.generation) return;
      const socket = this.socket;
      if (!socket || socket.readyState !== SOCKET_OPEN) return;
      if (
        this.options.now() - this.lastActivityAtMs >=
        this.options.activityTimeoutMs
      ) {
        this.failSocket(
          socket,
          generation,
          'private trading heartbeat timeout',
        );
        return;
      }
      try {
        socket.send(
          this.options.market === 'SPOT'
            ? 'ping'
            : JSON.stringify({type: 'ping'}),
        );
      } catch {
        this.failSocket(
          socket,
          generation,
          'private trading heartbeat send failed',
        );
      }
    }, this.options.heartbeatIntervalMs);
  }

  private sendHeartbeatReply(
    socket: PrivateTradingWebSocketLike,
    generation: number,
  ) {
    try {
      socket.send(
        this.options.market === 'SPOT'
          ? 'pong'
          : JSON.stringify({type: 'pong'}),
      );
    } catch {
      this.failSocket(
        socket,
        generation,
        'private trading heartbeat reply failed',
      );
    }
  }

  private scheduleInvalidate(
    event: PrivateTradingRealtimeEvent,
    generation: number,
  ) {
    this.pendingEvent = event;
    if (this.invalidateTimer !== null) return;
    this.invalidateTimer = setTimeout(() => {
      this.invalidateTimer = null;
      const pendingEvent = this.pendingEvent;
      this.pendingEvent = null;
      if (
        !pendingEvent ||
        !this.active ||
        generation !== this.generation
      ) {
        return;
      }
      this.options.onInvalidate(pendingEvent);
    }, this.options.invalidateDebounceMs);
  }

  private failSocket(
    socket: PrivateTradingWebSocketLike,
    generation: number,
    reason: string,
  ) {
    if (!this.isCurrent(socket, generation)) return;
    this.socket = null;
    this.clearConnectTimer();
    this.clearHeartbeatTimer();
    this.detachSocket(socket);
    try {
      socket.close(4000, reason);
    } catch {
      // Reconnect remains authoritative even if close fails.
    }
    this.scheduleReconnect(generation);
  }

  private scheduleReconnect(generation: number) {
    if (!this.active || generation !== this.generation) return;
    this.clearReconnectTimer();
    this.setStatus('reconnecting');
    const baseDelay = Math.min(
      this.options.reconnectBaseMs * 2 ** this.reconnectAttempt,
      this.options.reconnectMaxMs,
    );
    const jitter =
      1 +
      (this.options.random() * 2 - 1) *
        this.options.reconnectJitterRatio;
    const delay = Math.max(
      0,
      Math.round(
        Math.min(baseDelay * jitter, this.options.reconnectMaxMs),
      ),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(generation);
    }, delay);
  }

  private isCurrent(
    socket: PrivateTradingWebSocketLike,
    generation: number,
  ) {
    return (
      this.active &&
      generation === this.generation &&
      this.socket === socket
    );
  }

  private retireSocket(code: number, reason: string) {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    this.detachSocket(socket);
    try {
      socket.close(code, reason);
    } catch {
      // Owner cleanup must not be blocked by a close failure.
    }
  }

  private detachSocket(socket: PrivateTradingWebSocketLike) {
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
  }

  private clearHeartbeatTimer() {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private clearReconnectTimer() {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearConnectTimer() {
    if (this.connectTimer === null) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private clearInvalidateTimer() {
    if (this.invalidateTimer === null) return;
    clearTimeout(this.invalidateTimer);
    this.invalidateTimer = null;
  }

  private clearTimers() {
    this.clearConnectTimer();
    this.clearHeartbeatTimer();
    this.clearReconnectTimer();
    this.clearInvalidateTimer();
  }

  private setStatus(status: PrivateTradingRealtimeStatus) {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange?.(status);
  }
}
