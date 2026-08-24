import {
  ManagedPublicWebSocket,
  type ManagedPublicWebSocketOptions,
  type PublicWebSocketLike,
} from '../src/realtime/managedPublicWebSocket';

class FakeSocket implements PublicWebSocketLike {
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

function createHarness({
  url = 'ws://127.0.0.1:8000/market/ws/spot?symbol=BTCUSDT',
  random = () => 0.5,
  openMessages,
}: {
  url?: ManagedPublicWebSocketOptions['url'];
  random?: () => number;
  openMessages?: string[];
} = {}) {
  const sockets: FakeSocket[] = [];
  const createSocket = jest.fn((_url: string) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  });
  const onMessage = jest.fn();
  const onStatusChange = jest.fn();
  let nowMs = 0;
  const client = new ManagedPublicWebSocket({
    url,
    createSocket,
    onMessage,
    onStatusChange,
    openMessages,
    now: () => nowMs,
    random,
  });

  return {
    client,
    createSocket,
    onMessage,
    onStatusChange,
    setNow: (value: number) => {
      nowMs = value;
    },
    sockets,
  };
}

describe('ManagedPublicWebSocket', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it.each([
    'ws://127.0.0.1:8000/market/ws/spot?symbol=BTCUSDT',
    'wss://api.example.com/market/ws/spot?symbol=BTCUSDT',
  ])('opens the configured %s URL and reports connecting/open', url => {
    const harness = createHarness({url});

    harness.client.start();

    expect(harness.createSocket).toHaveBeenCalledTimes(1);
    expect(harness.createSocket).toHaveBeenCalledWith(url);
    expect(harness.client.getStatus()).toBe('connecting');
    expect(harness.onStatusChange).toHaveBeenLastCalledWith('connecting');

    harness.sockets[0].open();

    expect(harness.client.getStatus()).toBe('open');
    expect(harness.onStatusChange.mock.calls.map(([status]) => status)).toEqual([
      'connecting',
      'open',
    ]);
  });

  it('sends ping every 18 seconds while the socket stays active', () => {
    const harness = createHarness();
    harness.client.start();
    const socket = harness.sockets[0];
    socket.open();

    harness.setNow(17_999);
    jest.advanceTimersByTime(17_999);
    expect(socket.send).not.toHaveBeenCalled();

    harness.setNow(18_000);
    jest.advanceTimersByTime(1);
    expect(socket.send).toHaveBeenNthCalledWith(1, 'ping');

    harness.setNow(35_000);
    socket.receive('pong');
    expect(harness.onMessage).not.toHaveBeenCalled();

    harness.setNow(36_000);
    jest.advanceTimersByTime(18_000);
    expect(socket.send).toHaveBeenNthCalledWith(2, 'ping');
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('replays configured subscription messages on every connection', () => {
    const subscribe = JSON.stringify({
      op: 'subscribe',
      domain: 'market',
      symbol: 'BTCUSDT_PERP',
    });
    const harness = createHarness({openMessages: [subscribe]});
    harness.client.start();
    harness.sockets[0].open();

    expect(harness.sockets[0].send).toHaveBeenCalledWith(subscribe);
    harness.sockets[0].receive('{"type":"ready"}');
    harness.sockets[0].serverClose();
    jest.advanceTimersByTime(1_500);
    harness.sockets[1].open();

    expect(harness.sockets[1].send).toHaveBeenCalledWith(subscribe);
  });

  it('resolves a dynamic URL again before every reconnect', () => {
    let interval = '1m';
    const url = jest.fn(
      () =>
        `ws://127.0.0.1:8000/contract/market/ws?symbol=BTCUSDT_PERP&interval=${interval}`,
    );
    const harness = createHarness({url});

    harness.client.start();
    expect(harness.createSocket).toHaveBeenLastCalledWith(
      'ws://127.0.0.1:8000/contract/market/ws?symbol=BTCUSDT_PERP&interval=1m',
    );
    harness.sockets[0].open();
    harness.sockets[0].receive('{"type":"ready"}');
    harness.sockets[0].serverClose();

    interval = '5m';
    jest.advanceTimersByTime(1_500);

    expect(url).toHaveBeenCalledTimes(2);
    expect(harness.createSocket).toHaveBeenLastCalledWith(
      'ws://127.0.0.1:8000/contract/market/ws?symbol=BTCUSDT_PERP&interval=5m',
    );
  });

  it('only sends application messages through the active open socket', () => {
    const harness = createHarness();

    expect(harness.client.send('before-start')).toBe(false);
    harness.client.start();
    expect(harness.client.send('while-connecting')).toBe(false);

    const socket = harness.sockets[0];
    socket.open();
    expect(harness.client.send('subscribe-kline')).toBe(true);
    expect(socket.send).toHaveBeenCalledWith('subscribe-kline');

    harness.client.stop();
    expect(harness.client.send('after-stop')).toBe(false);
  });

  it('retires and reconnects when an application send throws', () => {
    const harness = createHarness();
    harness.client.start();
    const socket = harness.sockets[0];
    socket.open();
    socket.send.mockImplementationOnce(() => {
      throw new Error('send failed');
    });

    expect(harness.client.send('subscribe-kline')).toBe(false);
    expect(socket.close).toHaveBeenCalledWith(
      4000,
      'public market send failed',
    );
    expect(harness.client.getStatus()).toBe('reconnecting');

    jest.advanceTimersByTime(1_500);
    expect(harness.createSocket).toHaveBeenCalledTimes(2);
  });

  it('treats JSON pong as liveness without forwarding it', () => {
    const harness = createHarness();
    harness.client.start();
    const socket = harness.sockets[0];
    socket.open();

    harness.setNow(20_000);
    socket.receive('{"type":"pong"}');

    expect(harness.onMessage).not.toHaveBeenCalled();
    harness.setNow(36_000);
    jest.advanceTimersByTime(36_000);
    expect(socket.close).not.toHaveBeenCalled();
  });

  it('closes an inactive socket with code 4000 and reconnects after backoff', () => {
    const harness = createHarness();
    harness.client.start();
    const socket = harness.sockets[0];
    socket.open();

    harness.setNow(18_000);
    jest.advanceTimersByTime(18_000);
    expect(socket.send).toHaveBeenCalledWith('ping');

    harness.setNow(36_000);
    jest.advanceTimersByTime(18_000);

    expect(socket.close).toHaveBeenCalledWith(
      4000,
      'public market heartbeat timeout',
    );
    expect(harness.client.getStatus()).toBe('reconnecting');
    expect(harness.createSocket).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(1_499);
    expect(harness.createSocket).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(harness.createSocket).toHaveBeenCalledTimes(2);
  });

  it('allows an application watchdog to retire and reconnect an active socket', () => {
    const harness = createHarness();
    harness.client.start();
    const socket = harness.sockets[0];
    socket.open();

    harness.client.restart('market state timeout');

    expect(socket.close).toHaveBeenCalledWith(
      4000,
      'market state timeout',
    );
    expect(harness.client.getStatus()).toBe('reconnecting');
    jest.advanceTimersByTime(1_500);
    expect(harness.createSocket).toHaveBeenCalledTimes(2);
  });

  it('applies reconnect jitter and exponential backoff', () => {
    const randomValues = [1, 0, 0.5];
    const random = jest.fn(() => randomValues.shift() ?? 0.5);
    const createSocket = jest.fn((_url: string): PublicWebSocketLike => {
      throw new Error('connect failed');
    });
    const client = new ManagedPublicWebSocket({
      url: 'wss://api.example.com/market/ws/spot?symbol=BTCUSDT',
      createSocket,
      onMessage: jest.fn(),
      random,
    });

    client.start();
    expect(createSocket).toHaveBeenCalledTimes(1);

    // 1,500ms base with +20% jitter.
    jest.advanceTimersByTime(1_799);
    expect(createSocket).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(1);
    expect(createSocket).toHaveBeenCalledTimes(2);

    // 3,000ms exponential backoff with -20% jitter.
    jest.advanceTimersByTime(2_399);
    expect(createSocket).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(createSocket).toHaveBeenCalledTimes(3);

    // 6,000ms exponential backoff with neutral jitter.
    jest.advanceTimersByTime(5_999);
    expect(createSocket).toHaveBeenCalledTimes(3);
    jest.advanceTimersByTime(1);
    expect(createSocket).toHaveBeenCalledTimes(4);
    expect(random).toHaveBeenCalledTimes(4);
  });

  it('cancels a pending reconnect when stopped', () => {
    const harness = createHarness();
    harness.client.start();
    const socket = harness.sockets[0];
    socket.open();
    socket.fail();

    expect(socket.close).toHaveBeenCalledWith(
      4000,
      'public market socket error',
    );
    expect(harness.client.getStatus()).toBe('reconnecting');

    harness.client.stop();
    expect(harness.client.getStatus()).toBe('stopped');

    jest.advanceTimersByTime(60_000);
    expect(harness.createSocket).toHaveBeenCalledTimes(1);
  });

  it('retires a socket that remains stuck while connecting', () => {
    const harness = createHarness();
    harness.client.start();
    const socket = harness.sockets[0];

    jest.advanceTimersByTime(14_999);
    expect(socket.close).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);

    expect(socket.close).toHaveBeenCalledWith(
      4000,
      'public market connect timeout',
    );
    expect(harness.client.getStatus()).toBe('reconnecting');
    jest.advanceTimersByTime(1_500);
    expect(harness.createSocket).toHaveBeenCalledTimes(2);
  });

  it('backs off repeated open-then-close flapping until data arrives', () => {
    const harness = createHarness();
    harness.client.start();
    harness.sockets[0].open();
    harness.sockets[0].serverClose();

    jest.advanceTimersByTime(1_500);
    expect(harness.createSocket).toHaveBeenCalledTimes(2);
    harness.sockets[1].open();
    harness.sockets[1].serverClose();

    jest.advanceTimersByTime(2_999);
    expect(harness.createSocket).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(1);
    expect(harness.createSocket).toHaveBeenCalledTimes(3);

    harness.sockets[2].open();
    harness.sockets[2].receive('pong');
    harness.sockets[2].serverClose();
    jest.advanceTimersByTime(1_500);
    expect(harness.createSocket).toHaveBeenCalledTimes(4);
  });

  it('ignores callbacks captured from a retired socket', () => {
    const harness = createHarness();
    harness.client.start();
    const firstSocket = harness.sockets[0];
    firstSocket.open();
    const oldMessage = firstSocket.onmessage;
    const oldClose = firstSocket.onclose;
    const oldError = firstSocket.onerror;

    firstSocket.fail();
    jest.advanceTimersByTime(1_500);
    const secondSocket = harness.sockets[1];
    secondSocket.open();
    harness.onMessage.mockClear();
    harness.onStatusChange.mockClear();

    oldMessage?.({data: '{"type":"stale"}'});
    oldClose?.({});
    oldError?.({});

    expect(harness.onMessage).not.toHaveBeenCalled();
    expect(harness.onStatusChange).not.toHaveBeenCalled();
    expect(harness.createSocket).toHaveBeenCalledTimes(2);
    expect(secondSocket.close).not.toHaveBeenCalled();
    expect(harness.client.getStatus()).toBe('open');
  });

  it('forwards malformed JSON as transport data without crashing', () => {
    const harness = createHarness();
    harness.client.start();
    const socket = harness.sockets[0];
    socket.open();

    expect(() => socket.receive('{"broken":')).not.toThrow();
    expect(harness.onMessage).toHaveBeenCalledWith('{"broken":');
    expect(harness.client.getStatus()).toBe('open');
  });
});
