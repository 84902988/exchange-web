export type PublicWebSocketStatus =
  | 'idle'
  | 'connecting'
  | 'open'
  | 'reconnecting'
  | 'stopped';

export type PublicWebSocketLike = {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: {data: unknown}) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
};

export type ManagedPublicWebSocketOptions = {
  url: string | (() => string);
  onMessage: (data: string) => void;
  onStatusChange?: (status: PublicWebSocketStatus) => void;
  openMessages?: string[] | (() => string[]);
  createSocket?: (url: string) => PublicWebSocketLike;
  now?: () => number;
  random?: () => number;
  heartbeatIntervalMs?: number;
  activityTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  reconnectJitterRatio?: number;
  connectTimeoutMs?: number;
};

const SOCKET_OPEN = 1;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 18_000;
const DEFAULT_ACTIVITY_TIMEOUT_MS = 36_000;
const DEFAULT_RECONNECT_BASE_MS = 1_500;
const DEFAULT_RECONNECT_MAX_MS = 30_000;
const DEFAULT_RECONNECT_JITTER_RATIO = 0.2;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

function defaultCreateSocket(url: string): PublicWebSocketLike {
  return new WebSocket(url) as unknown as PublicWebSocketLike;
}

function isApplicationPong(data: unknown) {
  if (data === 'pong') return true;
  if (typeof data !== 'string') return false;
  try {
    const parsed = JSON.parse(data) as {type?: unknown};
    return (
      typeof parsed === 'object' &&
      parsed !== null &&
      String(parsed.type || '').trim().toLowerCase() === 'pong'
    );
  } catch {
    return false;
  }
}

export class ManagedPublicWebSocket {
  private readonly options: Required<
    Pick<
      ManagedPublicWebSocketOptions,
      | 'createSocket'
      | 'now'
      | 'random'
      | 'heartbeatIntervalMs'
      | 'activityTimeoutMs'
      | 'reconnectBaseMs'
      | 'reconnectMaxMs'
      | 'reconnectJitterRatio'
      | 'connectTimeoutMs'
    >
  > &
    Omit<
      ManagedPublicWebSocketOptions,
      | 'createSocket'
      | 'now'
      | 'random'
      | 'heartbeatIntervalMs'
      | 'activityTimeoutMs'
      | 'reconnectBaseMs'
      | 'reconnectMaxMs'
      | 'reconnectJitterRatio'
      | 'connectTimeoutMs'
    >;

  private socket: PublicWebSocketLike | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private active = false;
  private generation = 0;
  private reconnectAttempt = 0;
  private lastActivityAtMs = 0;
  private status: PublicWebSocketStatus = 'idle';

  constructor(options: ManagedPublicWebSocketOptions) {
    this.options = {
      ...options,
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
        options.reconnectJitterRatio ??
        DEFAULT_RECONNECT_JITTER_RATIO,
      connectTimeoutMs:
        options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    };
  }

  getStatus() {
    return this.status;
  }

  start() {
    if (this.active) return;
    this.active = true;
    this.generation += 1;
    this.reconnectAttempt = 0;
    this.connect(this.generation);
  }

  stop(reason = 'public market owner released') {
    if (!this.active && this.status === 'stopped') return;
    this.active = false;
    this.generation += 1;
    this.clearTimers();
    this.reconnectAttempt = 0;
    this.lastActivityAtMs = 0;
    this.retireSocket(1000, reason);
    this.setStatus('stopped');
  }

  restart(reason = 'public market application watchdog timeout') {
    if (!this.active) return;
    const socket = this.socket;
    if (!socket) return;
    this.failSocket(socket, this.generation, reason);
  }

  send(data: string) {
    const socket = this.socket;
    if (
      !this.active ||
      !socket ||
      socket.readyState !== SOCKET_OPEN ||
      typeof data !== 'string' ||
      !data
    ) {
      return false;
    }
    try {
      socket.send(data);
      return true;
    } catch {
      this.failSocket(
        socket,
        this.generation,
        'public market send failed',
      );
      return false;
    }
  }

  private connect(generation: number) {
    if (!this.active || generation !== this.generation) return;
    this.clearReconnectTimer();
    this.setStatus('connecting');

    let socket: PublicWebSocketLike;
    try {
      const url =
        typeof this.options.url === 'function'
          ? this.options.url()
          : this.options.url;
      if (!url) throw new Error('Public websocket URL is required');
      socket = this.options.createSocket(url);
    } catch {
      this.scheduleReconnect(generation);
      return;
    }
    this.socket = socket;
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.failSocket(
        socket,
        generation,
        'public market connect timeout',
      );
    }, this.options.connectTimeoutMs);

    socket.onopen = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.clearConnectTimer();
      this.lastActivityAtMs = this.options.now();
      this.setStatus('open');
      try {
        const openMessages =
          typeof this.options.openMessages === 'function'
            ? this.options.openMessages()
            : this.options.openMessages || [];
        for (const message of openMessages) {
          if (typeof message === 'string' && message) {
            socket.send(message);
          }
        }
      } catch {
        this.failSocket(
          socket,
          generation,
          'public market subscribe failed',
        );
        return;
      }
      this.startHeartbeat(generation);
    };
    socket.onmessage = event => {
      if (!this.isCurrent(socket, generation)) return;
      this.lastActivityAtMs = this.options.now();
      this.reconnectAttempt = 0;
      if (isApplicationPong(event.data)) return;
      if (typeof event.data === 'string') {
        this.options.onMessage(event.data);
      }
    };
    socket.onerror = () => {
      if (!this.isCurrent(socket, generation)) return;
      this.failSocket(socket, generation, 'public market socket error');
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
          'public market heartbeat timeout',
        );
        return;
      }
      try {
        socket.send('ping');
      } catch {
        this.failSocket(
          socket,
          generation,
          'public market heartbeat send failed',
        );
      }
    }, this.options.heartbeatIntervalMs);
  }

  private failSocket(
    socket: PublicWebSocketLike,
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
      // Reconnect remains authoritative even if the retired socket cannot close.
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
        Math.min(
          baseDelay * jitter,
          this.options.reconnectMaxMs,
        ),
      ),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(generation);
    }, delay);
  }

  private isCurrent(
    socket: PublicWebSocketLike,
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
      // Stopping the owner must not be blocked by a close failure.
    }
  }

  private detachSocket(socket: PublicWebSocketLike) {
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

  private clearTimers() {
    this.clearConnectTimer();
    this.clearHeartbeatTimer();
    this.clearReconnectTimer();
  }

  private setStatus(status: PublicWebSocketStatus) {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatusChange?.(status);
  }
}
