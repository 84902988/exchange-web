import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import {ApiClientError} from '../src/api/client';
import {fetchTradeIdempotencyStatus} from '../src/api/tradeIdempotency';
import {
  clearPendingTradeIntent,
  __pendingTradeIntentSecureLocationForTests,
  createPendingTradeIntent,
  isPotentiallyCommittedMutationError,
  loadPendingTradeIntent,
  PendingTradeIntentConflictError,
  PendingTradeIntentLoadError,
  resetPendingTradeIntentMemoryForTests,
  recoverCorruptPendingTradeIntent,
  savePendingTradeIntent,
} from '../src/services/pendingTradeIntent';
import {findAuthoritativeContractOrdersForIntent} from '../src/services/contractOrderIntent';
import {findAuthoritativeSpotOrderForIntent} from '../src/services/spotOrderIntent';

jest.mock('../src/api/tradeIdempotency', () => ({
  fetchTradeIdempotencyStatus: jest.fn(),
}));

const mockFetchTradeIdempotencyStatus = jest.mocked(
  fetchTradeIdempotencyStatus,
);
const keychainMock = Keychain as typeof Keychain & {
  __resetMock: () => void;
  __storeMockCredentials: (
    username: string,
    password: string,
    options: {service: string},
  ) => Promise<unknown>;
};

function key(market = 'spot', owner = '7', instrument = 'BTCUSDT') {
  return [
    '@exchange-mobile/pending-trade-intent/v1',
    market,
    encodeURIComponent(owner),
    encodeURIComponent(instrument),
  ].join(':');
}

function secureLocation(
  market: 'spot' | 'contract' = 'spot',
  owner = '7',
  instrument = 'BTCUSDT',
) {
  return __pendingTradeIntentSecureLocationForTests(
    market,
    owner,
    instrument,
  );
}

async function replaceSecureRaw(
  raw: string,
  market: 'spot' | 'contract' = 'spot',
  owner = '7',
  instrument = 'BTCUSDT',
) {
  const location = secureLocation(market, owner, instrument);
  await keychainMock.__storeMockCredentials(
    location.username,
    raw,
    {service: location.service},
  );
}

describe('pending trade intent safety lock', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    keychainMock.__resetMock();
    resetPendingTradeIntentMemoryForTests();
    mockFetchTradeIdempotencyStatus.mockReset();
  });

  it('creates a persistent opaque lowercase client id without scope identity', () => {
    const intent = createPendingTradeIntent({
      market: 'spot',
      ownerKey: 'owner-sensitive-value',
      instrumentKey: 'BTCUSDT',
      payload: {symbol: 'BTCUSDT'},
      createdAtMs: 1_000,
    });

    expect(intent.version).toBe(2);
    expect(intent.revision).toBe(1);
    expect(intent.id).toBe(intent.clientOrderId);
    expect(intent.clientOrderId).toMatch(/^[a-z0-9][a-z0-9._-]{0,63}$/);
    expect(intent.clientOrderId.length).toBeLessThanOrEqual(64);
    expect(intent.clientOrderId).not.toContain('owner-sensitive-value');
    expect(intent.clientOrderId).not.toContain('btcusdt');
  });

  it('survives an in-memory reset and clears only an exact revision CAS match', async () => {
    const intent = createPendingTradeIntent({
      market: 'spot',
      ownerKey: '7',
      instrumentKey: 'BTCUSDT',
      payload: {symbol: 'BTCUSDT'},
      baselineIds: [2, 2, 0, -1],
      createdAtMs: 1_000,
    });
    await savePendingTradeIntent(intent);
    resetPendingTradeIntentMemoryForTests();

    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).resolves.toMatchObject({
      id: intent.id,
      clientOrderId: intent.clientOrderId,
      baselineIds: [2],
      revision: 1,
    });

    await replaceSecureRaw(
      JSON.stringify({...intent, revision: intent.revision + 1}),
    );
    await expect(clearPendingTradeIntent(intent)).resolves.toBe(false);
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).resolves.toMatchObject({revision: intent.revision + 1});
    await expect(AsyncStorage.getItem(key())).resolves.toBeNull();
  });

  it('allows exactly one concurrent create-if-absent writer for a scope', async () => {
    const first = createPendingTradeIntent({
      market: 'spot',
      ownerKey: '7',
      instrumentKey: 'BTCUSDT',
      payload: {symbol: 'BTCUSDT', side: 'BUY'},
      createdAtMs: 1_000,
    });
    const second = createPendingTradeIntent({
      market: 'spot',
      ownerKey: '7',
      instrumentKey: 'BTCUSDT',
      payload: {symbol: 'BTCUSDT', side: 'SELL'},
      createdAtMs: 1_001,
    });

    const results = await Promise.allSettled([
      savePendingTradeIntent(first),
      savePendingTradeIntent(second),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(
      1,
    );
    const rejected = results.find(result => result.status === 'rejected');
    expect(
      rejected?.status === 'rejected' ? rejected.reason : null,
    ).toBeInstanceOf(PendingTradeIntentConflictError);
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).resolves.toMatchObject({id: first.id});
  });

  it('always rereads disk and never lets memory hide a corrupt raw value', async () => {
    const intent = createPendingTradeIntent({
      market: 'spot',
      ownerKey: '7',
      instrumentKey: 'BTCUSDT',
      payload: {symbol: 'BTCUSDT'},
    });
    await savePendingTradeIntent(intent);
    await replaceSecureRaw(
      '{"version":2,"clientOrderId":"' + intent.clientOrderId + '"',
    );

    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).rejects.toMatchObject({
      kind: 'CORRUPT',
      token: expect.objectContaining({
        clientOrderId: intent.clientOrderId,
        rawHash: expect.any(String),
      }),
    });
  });

  it('returns a read-only diagnostic token without changing corrupt storage', async () => {
    const clientOrderId = 'm-safe-recovery-id';
    const corruptRaw =
      '{"version":2,"clientOrderId":"' + clientOrderId + '"';
    await AsyncStorage.setItem(
      key(),
      corruptRaw,
    );
    let failure: PendingTradeIntentLoadError | null = null;
    try {
      await loadPendingTradeIntent('spot', '7', 'BTCUSDT');
    } catch (error) {
      failure = error as PendingTradeIntentLoadError;
    }
    expect(failure).toMatchObject({
      kind: 'CORRUPT',
      token: expect.objectContaining({
        tokenVersion: 1,
        market: 'spot',
        ownerKey: '7',
        instrumentKey: 'BTCUSDT',
        clientOrderId,
        rawHash: expect.any(String),
        observedAtMs: expect.any(Number),
      }),
    });
    await expect(AsyncStorage.getItem(key())).resolves.toBeNull();
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).rejects.toMatchObject({
      kind: 'CORRUPT',
      token: expect.objectContaining({rawHash: failure?.token?.rawHash}),
    });
  });

  it('clears a corrupt lock only after an exact completed server authority result', async () => {
    const clientOrderId = 'm-safe-authority-id';
    const corruptRaw =
      '{"version":2,"clientOrderId":"' + clientOrderId + '"';
    await AsyncStorage.setItem(key(), corruptRaw);
    let failure: PendingTradeIntentLoadError | null = null;
    try {
      await loadPendingTradeIntent('spot', '7', 'BTCUSDT');
    } catch (error) {
      failure = error as PendingTradeIntentLoadError;
    }
    mockFetchTradeIdempotencyStatus.mockResolvedValue({
      market: 'spot',
      clientOrderId,
      status: 'COMPLETED',
      operation: 'SPOT_CREATE',
      result: {
        id: 91,
        symbol: 'BTCUSDT',
        client_order_id: clientOrderId,
      },
      resultSymbol: 'BTCUSDT',
      createdAt: '2026-08-02T01:02:03Z',
      completedAt: '2026-08-02T01:02:04Z',
    });

    await expect(
      recoverCorruptPendingTradeIntent(failure!, () => true),
    ).resolves.toMatchObject({status: 'COMPLETED_CLEARED'});
    await expect(AsyncStorage.getItem(key())).resolves.toBeNull();
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).resolves.toBeNull();
  });

  it('keeps corrupt storage for missing, pending, or mismatched authority', async () => {
    const clientOrderId = 'm-safe-locked-id';
    const corruptRaw =
      '{"version":2,"clientOrderId":"' + clientOrderId + '"';
    await AsyncStorage.setItem(key(), corruptRaw);
    let failure: PendingTradeIntentLoadError | null = null;
    try {
      await loadPendingTradeIntent('spot', '7', 'BTCUSDT');
    } catch (error) {
      failure = error as PendingTradeIntentLoadError;
    }
    mockFetchTradeIdempotencyStatus.mockResolvedValueOnce({
      market: 'spot',
      clientOrderId,
      status: 'NOT_FOUND',
      operation: null,
      result: null,
      resultSymbol: null,
      createdAt: null,
      completedAt: null,
    });
    await expect(
      recoverCorruptPendingTradeIntent(failure!, () => true),
    ).resolves.toMatchObject({status: 'NOT_FOUND'});
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).rejects.toMatchObject({kind: 'CORRUPT'});

    mockFetchTradeIdempotencyStatus.mockResolvedValueOnce({
      market: 'spot',
      clientOrderId,
      status: 'COMPLETED',
      operation: 'SPOT_CREATE',
      result: {
        id: 92,
        symbol: 'ETHUSDT',
        client_order_id: clientOrderId,
      },
      resultSymbol: 'ETHUSDT',
      createdAt: '2026-08-02T01:02:03Z',
      completedAt: '2026-08-02T01:02:04Z',
    });
    await expect(
      recoverCorruptPendingTradeIntent(failure!, () => true),
    ).resolves.toMatchObject({status: 'SCOPE_MISMATCH'});
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).rejects.toMatchObject({kind: 'CORRUPT'});
  });

  it('does not clear when the corrupt raw value changes during authority lookup', async () => {
    const clientOrderId = 'm-safe-race-id';
    const corruptRaw =
      '{"version":2,"clientOrderId":"' + clientOrderId + '"';
    const replacementRaw = corruptRaw + ',"changed":true';
    await AsyncStorage.setItem(key(), corruptRaw);
    let failure: PendingTradeIntentLoadError | null = null;
    try {
      await loadPendingTradeIntent('spot', '7', 'BTCUSDT');
    } catch (error) {
      failure = error as PendingTradeIntentLoadError;
    }
    let resolveAuthority: ((value: any) => void) | null = null;
    mockFetchTradeIdempotencyStatus.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          resolveAuthority = resolve;
        }),
    );
    const recovery = recoverCorruptPendingTradeIntent(failure!, () => true);
    await replaceSecureRaw(replacementRaw);
    resolveAuthority!({
      market: 'spot',
      clientOrderId,
      status: 'COMPLETED',
      operation: 'SPOT_CREATE',
      result: {
        id: 93,
        symbol: 'BTCUSDT',
        client_order_id: clientOrderId,
      },
      resultSymbol: 'BTCUSDT',
      createdAt: '2026-08-02T01:02:03Z',
      completedAt: '2026-08-02T01:02:04Z',
    });

    await expect(recovery).resolves.toMatchObject({status: 'LOCK_CHANGED'});
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).rejects.toMatchObject({kind: 'CORRUPT'});
  });

  it('keeps future-schema and arbitrary occupied raw values fail closed', async () => {
    await AsyncStorage.setItem(key(), JSON.stringify({version: 99}));
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).rejects.toMatchObject({kind: 'FUTURE_SCHEMA', token: null});

    const intent = createPendingTradeIntent({
      market: 'spot',
      ownerKey: '7',
      instrumentKey: 'BTCUSDT',
      payload: {symbol: 'BTCUSDT'},
    });
    await expect(savePendingTradeIntent(intent)).rejects.toBeInstanceOf(
      PendingTradeIntentConflictError,
    );
    await expect(AsyncStorage.getItem(key())).resolves.toBeNull();
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).rejects.toMatchObject({kind: 'FUTURE_SCHEMA', token: null});
  });

  it('reads legacy v1 records without inventing a client order id', async () => {
    await AsyncStorage.setItem(
      key(),
      JSON.stringify({
        version: 1,
        id: 'legacy:scope:1',
        market: 'spot',
        ownerKey: '7',
        instrumentKey: 'BTCUSDT',
        payload: {symbol: 'BTCUSDT'},
        baselineIds: [1],
        createdAtMs: 1_000,
      }),
    );
    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).resolves.toEqual(
      expect.objectContaining({version: 1, id: 'legacy:scope:1'}),
    );
    await expect(AsyncStorage.getItem(key())).resolves.toBeNull();
  });

  it('stores a new lock only in native secure storage', async () => {
    const intent = createPendingTradeIntent({
      market: 'spot',
      ownerKey: '7',
      instrumentKey: 'BTCUSDT',
      payload: {symbol: 'BTCUSDT'},
    });
    await savePendingTradeIntent(intent);

    await expect(AsyncStorage.getItem(key())).resolves.toBeNull();
    const credentials = await Keychain.getGenericPassword({
      service: secureLocation().service,
    });
    expect(credentials).toEqual(
      expect.objectContaining({
        username: secureLocation().username,
        password: JSON.stringify(intent),
      }),
    );
  });

  it('keeps a legacy lock fail closed when secure migration cannot be verified', async () => {
    const legacyRaw = JSON.stringify({version: 99});
    await AsyncStorage.setItem(key(), legacyRaw);
    jest.spyOn(Keychain, 'setGenericPassword').mockResolvedValueOnce(false);

    await expect(
      loadPendingTradeIntent('spot', '7', 'BTCUSDT'),
    ).rejects.toMatchObject({kind: 'STORAGE_IO'});
    await expect(AsyncStorage.getItem(key())).resolves.toBe(legacyRaw);
  });

  it('classifies idempotency uncertainty and invalid responses as ambiguous', () => {
    for (const code of [
      'TIMEOUT',
      'NETWORK_ERROR',
      'AUTH_SESSION_CHANGED',
      'IDEMPOTENCY_KEY_REUSED',
      'IDEMPOTENCY_RESULT_UNAVAILABLE',
      'IDEMPOTENCY_KEY_REUSE_MISMATCH',
      'KEY_REUSE_MISMATCH',
      'INVALID_SPOT_ORDER_RESPONSE',
    ]) {
      expect(
        isPotentiallyCommittedMutationError(
          new ApiClientError('unknown', code),
          {invalidResponseCodes: ['INVALID_SPOT_ORDER_RESPONSE']},
        ),
      ).toBe(true);
    }
    expect(
      isPotentiallyCommittedMutationError(
        new ApiClientError('rejected', 'MIN_NOTIONAL', 400),
      ),
    ).toBe(false);
  });

  it('uses exact client id reconciliation and keeps legacy MARKET BUY fail closed', () => {
    const intent = createPendingTradeIntent({
      market: 'spot',
      ownerKey: '7',
      instrumentKey: 'BTCUSDT',
      payload: {
        symbol: 'BTCUSDT',
        side: 'BUY' as const,
        order_type: 'MARKET' as const,
        quote_amount: '100',
      },
      createdAtMs: Date.parse('2026-07-31T00:00:00Z'),
    });
    const exact = {
      id: '42',
      orderId: 42,
      clientOrderId: intent.clientOrderId,
      symbol: 'BTCUSDT',
      side: 'BUY' as const,
      orderType: 'MARKET',
      price: '100',
      amount: '1',
      filledAmount: '1',
      status: 'FILLED',
      createdAt: '2026-07-31T00:00:01Z',
    };
    expect(
      findAuthoritativeSpotOrderForIntent(intent, [], [exact]),
    ).toEqual(exact);
    expect(
      findAuthoritativeSpotOrderForIntent(intent, [], [
        {...exact, orderId: 43, id: '43', clientOrderId: 'm-other-order'},
      ]),
    ).toBeNull();

    const legacy = {
      version: 1 as const,
      id: 'legacy',
      market: intent.market,
      ownerKey: intent.ownerKey,
      instrumentKey: intent.instrumentKey,
      payload: intent.payload,
      baselineIds: intent.baselineIds,
      createdAtMs: intent.createdAtMs,
    };
    expect(
      findAuthoritativeSpotOrderForIntent(legacy, [], [exact]),
    ).toBeNull();
  });

  it('never falls back to field heuristics for a V2 contract intent', () => {
    const intent = createPendingTradeIntent({
      market: 'contract',
      ownerKey: '7',
      instrumentKey: 'BTCUSDT',
      payload: {
        action: 'OPEN' as const,
        symbol: 'BTCUSDT',
        positionSide: 'LONG' as const,
        orderType: 'LIMIT' as const,
        price: '62500',
        quantity: '0.01',
        leverage: 10,
      },
      createdAtMs: Date.parse('2026-07-31T00:00:00Z'),
    });
    const matchingFields = {
      id: '72',
      orderId: 72,
      clientOrderId: 'm-other-contract-order',
      symbol: 'BTCUSDT',
      positionSide: 'LONG' as const,
      action: 'OPEN',
      orderType: 'LIMIT',
      price: '62500',
      quantity: '0.01',
      filledQuantity: '0',
      leverage: 10,
      marginAmount: '62.5',
      spreadFee: '0',
      status: 'OPEN',
      createdAt: '2026-07-31T00:00:01Z',
    };

    expect(
      findAuthoritativeContractOrdersForIntent(intent, [], [matchingFields]),
    ).toBeNull();
    expect(
      findAuthoritativeContractOrdersForIntent(intent, [], [
        {...matchingFields, clientOrderId: intent.clientOrderId},
      ]),
    ).toEqual([
      {...matchingFields, clientOrderId: intent.clientOrderId},
    ]);
  });
});
