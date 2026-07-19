import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { ContractUserRealtimeClient } from './contractUserRealtime';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readonly url: string;
  readonly protocols: string[];
  readyState = MockWebSocket.CONNECTING;
  closeCount = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = Array.isArray(protocols) ? protocols : protocols ? [protocols] : [];
    MockWebSocket.instances.push(this);
  }

  send() {}

  close() {
    this.closeCount += 1;
    this.readyState = MockWebSocket.CLOSED;
  }
}

describe('ContractUserRealtimeClient identity lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    MockWebSocket.instances = [];
    window.localStorage.setItem('access_token', 'test-access-token');
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      value: MockWebSocket,
    });
  });

  afterEach(() => {
    window.localStorage.clear();
    jest.runOnlyPendingTimers();
    jest.useRealTimers();
  });

  it('does not establish a private socket for anonymous state', () => {
    const client = new ContractUserRealtimeClient();
    client.setSession({ isLoggedIn: false, identityKey: null, symbol: 'BTCUSDT_PERP' });
    jest.advanceTimersByTime(200);
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it('establishes only one socket when the same identity session repeats', () => {
    const client = new ContractUserRealtimeClient();
    const session = { isLoggedIn: true, identityKey: 'user-a', symbol: 'BTCUSDT_PERP' };
    client.setSession(session);
    client.setSession(session);
    jest.advanceTimersByTime(200);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).not.toContain('access_token=');
    expect(MockWebSocket.instances[0].protocols).toEqual(['contract-auth', 'test-access-token']);
    client.disconnect();
  });

  it('disconnects the old socket and creates one socket for a new identity', () => {
    const client = new ContractUserRealtimeClient();
    client.setSession({ isLoggedIn: true, identityKey: 'user-a', symbol: 'BTCUSDT_PERP' });
    jest.advanceTimersByTime(200);
    const oldSocket = MockWebSocket.instances[0];

    client.setSession({ isLoggedIn: true, identityKey: 'user-b', symbol: 'BTCUSDT_PERP' });
    jest.advanceTimersByTime(200);

    expect(oldSocket.closeCount).toBe(1);
    expect(MockWebSocket.instances).toHaveLength(2);
    client.disconnect();
  });

  it('ignores an event captured from the previous identity session', () => {
    const client = new ContractUserRealtimeClient();
    const handler = jest.fn();
    client.subscribe('account', handler);
    client.setSession({ isLoggedIn: true, identityKey: 'user-a', symbol: 'BTCUSDT_PERP' });
    jest.advanceTimersByTime(200);
    const staleMessageHandler = MockWebSocket.instances[0].onmessage;

    client.setSession({ isLoggedIn: true, identityKey: 'user-b', symbol: 'BTCUSDT_PERP' });
    staleMessageHandler?.({ data: JSON.stringify({ type: 'account', account: { equity: '1' } }) } as MessageEvent);

    expect(handler).not.toHaveBeenCalled();
    client.disconnect();
  });
});
