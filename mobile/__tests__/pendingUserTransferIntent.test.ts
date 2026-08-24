import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import type {
  UserTransferRecord,
  UserTransferRequestStatusResponse,
} from '../src/api/userTransfer';
import {
  __pendingUserTransferSecureLocationForTests,
  clearPendingUserTransferIntentForLogout,
  createPendingUserTransferIntent,
  loadPendingUserTransferIntent,
  PENDING_USER_TRANSFER_INTENT_TTL_MS,
  PENDING_USER_TRANSFER_LOGOUT_MARKER,
  recoverPendingUserTransferIntent,
  resetPendingUserTransferIntentForTests,
  savePendingUserTransferIntent,
  type PendingUserTransferIntent,
} from '../src/services/pendingUserTransferIntent';

const keychainMock = Keychain as typeof Keychain & {
  __resetMock: () => void;
  __storeMockCredentials: typeof Keychain.setGenericPassword;
};

const CREATED_AT_MS = 1_800_000_000_000;

function createIntent(
  overrides: Partial<PendingUserTransferIntent> = {},
) {
  return createPendingUserTransferIntent({
    ownerKey: overrides.ownerKey ?? '7',
    requestId: overrides.requestId ?? 'transfer-intent-1',
    recipientUserId: overrides.recipientUserId ?? 8,
    recipientEmail: overrides.recipientEmail ?? 'Receiver@Example.com',
    symbol: overrides.symbol ?? 'usdt',
    amount: overrides.amount ?? '0012.5000',
    remark: overrides.remark === undefined ? '  lunch  ' : overrides.remark,
    createdAtMs: overrides.createdAtMs ?? CREATED_AT_MS,
  });
}

function completedRecord(
  overrides: Partial<UserTransferRecord> = {},
): UserTransferRecord {
  return {
    id: 1,
    transferNo: 'UTR-1',
    requestId: 'transfer-intent-1',
    direction: 'out',
    counterpartyUserId: 8,
    counterpartyNickname: 'Receiver',
    recipientNickname: 'Receiver',
    recipientEmailMask: 'r***r@example.com',
    symbol: 'USDT',
    amount: '12.5',
    feeAmount: '0',
    netAmount: '12.5',
    status: 'SUCCESS',
    remark: 'lunch',
    createdAt: '2027-01-15T08:00:00',
    ...overrides,
  };
}

function completedStatus(
  record: UserTransferRecord = completedRecord(),
): UserTransferRequestStatusResponse {
  return {
    requestId: record.requestId,
    state: 'COMPLETED',
    record,
  };
}

function notFoundStatus(): UserTransferRequestStatusResponse {
  return {
    requestId: 'transfer-intent-1',
    state: 'NOT_FOUND',
    record: null,
  };
}

describe('pending user transfer intent', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    keychainMock.__resetMock();
    resetPendingUserTransferIntentForTests();
    await AsyncStorage.clear();
  });

  it('normalizes and restores the full intent from device-only Keychain', async () => {
    const intent = createIntent();
    expect(intent).toMatchObject({
      ownerKey: '7',
      recipientEmail: 'receiver@example.com',
      symbol: 'USDT',
      amount: '12.5',
      remark: 'lunch',
      expiresAtMs: CREATED_AT_MS + PENDING_USER_TRANSFER_INTENT_TTL_MS,
    });

    await savePendingUserTransferIntent(intent);
    expect(await AsyncStorage.getAllKeys()).toEqual([]);

    resetPendingUserTransferIntentForTests();
    await expect(loadPendingUserTransferIntent('7')).resolves.toEqual(intent);
  });

  it('fails closed for corrupt, future-version, or cross-user storage', async () => {
    const location = __pendingUserTransferSecureLocationForTests();
    await keychainMock.__storeMockCredentials(
      location.username,
      '{broken',
      {service: location.service},
    );
    await expect(loadPendingUserTransferIntent('7')).rejects.toMatchObject({
      code: 'CORRUPT_STORAGE',
    });

    keychainMock.__resetMock();
    await keychainMock.__storeMockCredentials(
      location.username,
      JSON.stringify({...createIntent(), version: 2}),
      {service: location.service},
    );
    await expect(loadPendingUserTransferIntent('7')).rejects.toMatchObject({
      code: 'FUTURE_SCHEMA',
    });

    keychainMock.__resetMock();
    await savePendingUserTransferIntent(createIntent());
    await expect(loadPendingUserTransferIntent('9')).rejects.toMatchObject({
      code: 'OWNER_MISMATCH',
    });
  });

  it('does not overwrite an unresolved or unreadable persisted scope', async () => {
    await savePendingUserTransferIntent(createIntent());
    await expect(
      savePendingUserTransferIntent(
        createIntent({requestId: 'transfer-intent-2'}),
      ),
    ).rejects.toMatchObject({code: 'SCOPE_OCCUPIED'});

    const location = __pendingUserTransferSecureLocationForTests();
    keychainMock.__resetMock();
    await keychainMock.__storeMockCredentials(
      location.username,
      '{broken',
      {service: location.service},
    );
    await expect(
      savePendingUserTransferIntent(createIntent()),
    ).rejects.toMatchObject({code: 'SCOPE_OCCUPIED'});
  });

  it('keeps a fresh NOT_FOUND intent for an exact future retry', async () => {
    const intent = createIntent();
    await savePendingUserTransferIntent(intent);
    const fetchStatus = jest.fn().mockResolvedValue(notFoundStatus());

    await expect(
      recoverPendingUserTransferIntent('7', {
        nowMs: intent.createdAtMs + 1000,
        fetchStatus,
      }),
    ).resolves.toMatchObject({status: 'NOT_FOUND', intent});
    expect(fetchStatus).toHaveBeenCalledWith(intent.requestId);
    await expect(loadPendingUserTransferIntent('7')).resolves.toEqual(intent);
  });

  it('clears an expired intent only after the server confirms NOT_FOUND', async () => {
    const intent = createIntent();
    await savePendingUserTransferIntent(intent);

    await expect(
      recoverPendingUserTransferIntent('7', {
        nowMs: intent.expiresAtMs,
        fetchStatus: jest.fn().mockResolvedValue(notFoundStatus()),
      }),
    ).resolves.toMatchObject({status: 'EXPIRED_NOT_FOUND_CLEARED'});
    await expect(loadPendingUserTransferIntent('7')).resolves.toBeNull();
  });

  it('keeps an expired intent when status authority is unavailable', async () => {
    const intent = createIntent();
    await savePendingUserTransferIntent(intent);

    await expect(
      recoverPendingUserTransferIntent('7', {
        nowMs: intent.expiresAtMs + 1,
        fetchStatus: jest.fn().mockRejectedValue(new TypeError('offline')),
      }),
    ).rejects.toThrow('offline');
    await expect(loadPendingUserTransferIntent('7')).resolves.toEqual(intent);
  });

  it('clears a fully matched COMPLETED result and is idempotent afterward', async () => {
    const intent = createIntent();
    await savePendingUserTransferIntent(intent);

    await expect(
      recoverPendingUserTransferIntent('7', {
        fetchStatus: jest.fn().mockResolvedValue(completedStatus()),
      }),
    ).resolves.toMatchObject({status: 'COMPLETED_CLEARED', intent});
    await expect(
      recoverPendingUserTransferIntent('7', {
        fetchStatus: jest.fn().mockRejectedValue(new Error('must not call')),
      }),
    ).resolves.toEqual({status: 'NONE', intent: null, authority: null});
  });

  it.each([
    ['recipient', {counterpartyUserId: 99}],
    ['symbol', {symbol: 'RCB'}],
    ['amount', {amount: '12.6'}],
    ['remark', {remark: 'dinner'}],
    ['direction', {direction: 'in' as const}],
    ['status', {status: 'FAILED'}],
  ])('keeps the lock when completed %s does not match', async (_label, patch) => {
    const intent = createIntent();
    await savePendingUserTransferIntent(intent);

    await expect(
      recoverPendingUserTransferIntent('7', {
        fetchStatus: jest
          .fn()
          .mockResolvedValue(completedStatus(completedRecord(patch))),
      }),
    ).resolves.toMatchObject({status: 'COMPLETED_MISMATCH'});
    await expect(loadPendingUserTransferIntent('7')).resolves.toEqual(intent);
  });

  it('uses a durable logout marker and removes the pending secret', async () => {
    await savePendingUserTransferIntent(createIntent());
    await clearPendingUserTransferIntentForLogout();

    await expect(
      AsyncStorage.getItem(PENDING_USER_TRANSFER_LOGOUT_MARKER),
    ).resolves.toBeNull();
    await expect(loadPendingUserTransferIntent('7')).resolves.toBeNull();
  });

  it('finishes an interrupted logout before restoring any pending intent', async () => {
    await savePendingUserTransferIntent(createIntent());
    await AsyncStorage.setItem(PENDING_USER_TRANSFER_LOGOUT_MARKER, '1');

    await expect(loadPendingUserTransferIntent('7')).resolves.toBeNull();
    await expect(
      AsyncStorage.getItem(PENDING_USER_TRANSFER_LOGOUT_MARKER),
    ).resolves.toBeNull();
    const location = __pendingUserTransferSecureLocationForTests();
    await expect(
      Keychain.getGenericPassword({service: location.service}),
    ).resolves.toBe(false);
  });
});
