import {
  ManagedPrivateTradingWebSocket,
  buildPrivateTradingWsUrl,
  getPrivateTradingWsProtocols,
  parsePrivateTradingRealtimeEvent,
  type ManagedPrivateTradingWebSocketOptions,
  type PrivateTradingWebSocketLike,
} from '../src/realtime/privateTradingRealtime';

class FakeSocket implements PrivateTradingWebSocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: {data: unknown}) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  send = jest.fn((_data: string) => undefined);
  close = jest.fn((_code?: number, _reason?: string) => {
    this.readyState = 3;
  });

  open() {
    this.readyState = 1;
    this.onopen?.({});
  }

  receive(data: unknown) {
    this.onmessage?.({data});
  }

  fail() {
    this.onerror?.({});
  }

  serverClose() {
    this.readyState = 3;
    this.onclose?.({});
  }
}

function createHarness(
  overrides: Partial<ManagedPrivateTradingWebSocketOptions> = {},
) {
  const sockets: FakeSocket[] = [];
  const createSocket = jest.fn((_url: string, _protocols: string[]) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const onInvalidate = jest.fn();
  const onStatusChange = jest.fn();
  let nowMs = 0;
  const client = new ManagedPrivateTradingWebSocket({
    market: 'SPOT',
    symbol: 'BTCUSDT',
    accessToken: 'access-token',
    createSocket,
    onInvalidate,
    onStatusChange,
    now: () => nowMs,
    random: () => 0.5,
    ...overrides,
  });
  return {
    client,
    createSocket,
    onInvalidate,
    onStatusChange,
    setNow: (value: number) => {
      nowMs = value;
    },
    sockets,
  };
}

describe('private trading realtime', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('builds scoped private URLs without putting the token in the query', () => {
    expect(buildPrivateTradingWsUrl('SPOT', 'btcusdt')).toContain(
      '/spot/ws/private?symbol=BTCUSDT',
    );
    expect(buildPrivateTradingWsUrl('CONTRACT', 'btcusdt_perp')).toContain(
      '/contract/ws/private?symbol=BTCUSDT_PERP',
    );
    expect(getPrivateTradingWsProtocols('SPOT', 'secret-token')).toEqual([
      'spot-auth',
      'secret-token',
    ]);
    expect(buildPrivateTradingWsUrl('SPOT', 'BTCUSDT')).not.toContain(
      'secret-token',
    );
  });

  it('opens with the private auth subprotocol and reports status', () => {
    const harness = createHarness();
    harness.client.start();

    expect(harness.createSocket).toHaveBeenCalledWith(
      expect.stringContaining('/spot/ws/private?symbol=BTCUSDT'),
      ['spot-auth', 'access-token'],
    );
    expect(harness.client.getStatus()).toBe('connecting');
    harness.sockets[0].open();
    expect(harness.client.getStatus()).toBe('open');
  });

  it('debounces valid events and rejects malformed or wrong-symbol data', () => {
    const harness = createHarness();
    harness.client.start();
    const socket = harness.sockets[0];
    socket.open();

    socket.receive('{"type":"spot_user_order_update","symbol":"ETHUSDT"}');
    socket.receive('{"type":"unknown","symbol":"BTCUSDT"}');
    socket.receive('{broken');
    jest.advanceTimersByTime(200);
    expect(harness.onInvalidate).not.toHaveBeenCalled();

    socket.receive(
      '{"type":"spot_user_order_update","symbol":"BTCUSDT"}',
    );
    socket.receive(
      '{"type":"spot_user_balance_update","items":[]}',
    );
    jest.advanceTimersByTime(149);
    expect(harness.onInvalidate).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(harness.onInvalidate).toHaveBeenCalledTimes(1);
    expect(harness.onInvalidate).toHaveBeenCalledWith({
      market: 'SPOT',
      symbol: 'BTCUSDT',
      type: 'spot_user_balance_update',
    });
  });

  it('uses market-specific heartbeats and replies to server ping', () => {
    const spot = createHarness();
    spot.client.start();
    spot.sockets[0].open();
    spot.sockets[0].receive('ping');
    expect(spot.sockets[0].send).toHaveBeenCalledWith('pong');
    spot.setNow(20_000);
    jest.advanceTimersByTime(20_000);
    expect(spot.sockets[0].send).toHaveBeenCalledWith('ping');
    spot.client.stop();

    const contract = createHarness({
      market: 'CONTRACT',
      symbol: 'BTCUSDT_PERP',
    });
    contract.client.start();
    contract.sockets[0].open();
    contract.sockets[0].receive('{"type":"ping"}');
    expect(contract.sockets[0].send).toHaveBeenCalledWith(
      '{"type":"pong"}',
    );
    contract.setNow(20_000);
    jest.advanceTimersByTime(20_000);
    expect(contract.sockets[0].send).toHaveBeenCalledWith(
      '{"type":"ping"}',
    );
  });

  it('reconnects with backoff and ignores retired socket callbacks', () => {
    const harness = createHarness();
    harness.client.start();
    const first = harness.sockets[0];
    first.open();
    const staleMessage = first.onmessage;
    first.fail();
    expect(first.close).toHaveBeenCalledWith(
      4000,
      'private trading socket error',
    );

    jest.advanceTimersByTime(1_500);
    expect(harness.sockets).toHaveLength(2);
    harness.sockets[1].open();
    staleMessage?.({
      data: '{"type":"spot_user_order_update","symbol":"BTCUSDT"}',
    });
    jest.advanceTimersByTime(150);
    expect(harness.onInvalidate).not.toHaveBeenCalled();
  });

  it.each([
    [
      'SPOT' as const,
      'BTCUSDT',
      '{"type":"spot_user_orders_snapshot","symbol":"BTCUSDT"}',
      'spot_user_orders_snapshot',
    ],
    [
      'CONTRACT' as const,
      'BTCUSDT_PERP',
      '{"type":"contract_user_snapshot","symbol":"BTCUSDT_PERP"}',
      'contract_user_snapshot',
    ],
  ])(
    'invalidates %s state from the authoritative server snapshot after reconnect',
    (market, symbol, payload, type) => {
      const harness = createHarness({market, symbol});
      harness.client.start();
      const first = harness.sockets[0];
      first.open();

      first.serverClose();
      jest.advanceTimersByTime(1_500);
      expect(harness.sockets).toHaveLength(2);
      harness.sockets[1].open();
      harness.sockets[1].receive(payload);
      jest.advanceTimersByTime(150);

      expect(harness.onInvalidate).toHaveBeenCalledTimes(1);
      expect(harness.onInvalidate).toHaveBeenCalledWith({
        market,
        symbol,
        type,
      });
    },
  );

  it('cancels queued invalidation and reconnect work when stopped', () => {
    const harness = createHarness();
    harness.client.start();
    const socket = harness.sockets[0];
    socket.open();
    socket.receive(
      '{"type":"spot_user_orders_snapshot","symbol":"BTCUSDT"}',
    );
    socket.serverClose();
    harness.client.stop();

    jest.advanceTimersByTime(60_000);
    expect(harness.onInvalidate).not.toHaveBeenCalled();
    expect(harness.sockets).toHaveLength(1);
    expect(harness.client.getStatus()).toBe('stopped');
  });

  it('parses contract account events without requiring a symbol', () => {
    expect(
      parsePrivateTradingRealtimeEvent(
        '{"type":"contract_user_account_update","payload":{"account":{}}}',
        'CONTRACT',
        'BTCUSDT_PERP',
      ),
    ).toEqual({
      market: 'CONTRACT',
      symbol: 'BTCUSDT_PERP',
      type: 'contract_user_account_update',
    });
    expect(
      parsePrivateTradingRealtimeEvent(
        '{"type":"contract_user_account_update","payload":{"mark_only":true,"account":{}}}',
        'CONTRACT',
        'BTCUSDT_PERP',
      ),
    ).toBeNull();
    expect(
      parsePrivateTradingRealtimeEvent(
        '{"type":"contract_user_position_mark_update","payload":{"mark_only":true}}',
        'CONTRACT',
        'BTCUSDT_PERP',
      ),
    ).toBeNull();
  });
});
