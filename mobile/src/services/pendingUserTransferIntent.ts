import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import {
  fetchUserTransferRequestStatus,
  type UserTransferRecord,
  type UserTransferRequestStatusResponse,
} from '../api/userTransfer';
import {
  isPositiveDecimalText,
  normalizeNonNegativeDecimalText,
} from '../utils/decimalText';

export const PENDING_USER_TRANSFER_INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PENDING_USER_TRANSFER_LOGOUT_MARKER =
  'pending_user_transfer_logout_v1';

const STORAGE_VERSION = 1 as const;
const KEYCHAIN_SERVICE = 'com.exchangemobile.pending-user-transfer.v1';
const KEYCHAIN_USERNAME = 'pending-user-transfer';
const MAX_PERSISTED_BYTES = 4096;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const OWNER_KEY_PATTERN = /^[1-9]\d{0,19}$/;
const SYMBOL_PATTERN = /^[A-Z0-9._-]{1,32}$/;

export type PendingUserTransferIntent = {
  version: typeof STORAGE_VERSION;
  ownerKey: string;
  requestId: string;
  recipientUserId: number;
  recipientEmail: string;
  symbol: string;
  amount: string;
  remark: string | null;
  createdAtMs: number;
  expiresAtMs: number;
};

export type CreatePendingUserTransferIntentInput = {
  ownerKey: string;
  requestId: string;
  recipientUserId: number;
  recipientEmail: string;
  symbol: string;
  amount: string;
  remark?: string | null;
  createdAtMs?: number;
};

export type PendingUserTransferIntentErrorCode =
  | 'INVALID_INPUT'
  | 'STORAGE_IO'
  | 'CORRUPT_STORAGE'
  | 'FUTURE_SCHEMA'
  | 'OWNER_MISMATCH'
  | 'SCOPE_OCCUPIED';

export class PendingUserTransferIntentError extends Error {
  readonly code: PendingUserTransferIntentErrorCode;

  constructor(code: PendingUserTransferIntentErrorCode, message: string) {
    super(message);
    this.name = 'PendingUserTransferIntentError';
    this.code = code;
  }
}

export type PendingUserTransferRecoveryResult =
  | {status: 'NONE'; intent: null; authority: null}
  | {
      status: 'NOT_FOUND';
      intent: PendingUserTransferIntent;
      authority: UserTransferRequestStatusResponse;
    }
  | {
      status:
        | 'COMPLETED_CLEARED'
        | 'COMPLETED_MISMATCH'
        | 'EXPIRED_NOT_FOUND_CLEARED'
        | 'LOCK_CHANGED';
      intent: PendingUserTransferIntent;
      authority: UserTransferRequestStatusResponse;
    };

type RecoveryOptions = {
  nowMs?: number;
  fetchStatus?: (
    requestId: string,
  ) => Promise<UserTransferRequestStatusResponse>;
};

let storageTail: Promise<void> = Promise.resolve();

function enqueueStorageOperation<T>(operation: () => Promise<T>) {
  const result = storageTail.catch(() => undefined).then(operation);
  storageTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function intentError(
  code: PendingUserTransferIntentErrorCode,
  message = '站内转账恢复信息异常，请稍后重试',
) {
  return new PendingUserTransferIntentError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOwnerKey(value: unknown) {
  const normalized = String(value ?? '').trim();
  if (!OWNER_KEY_PATTERN.test(normalized)) {
    throw intentError('INVALID_INPUT');
  }
  return normalized;
}

function normalizeRequestId(value: unknown) {
  const normalized = String(value ?? '').trim();
  if (!REQUEST_ID_PATTERN.test(normalized)) {
    throw intentError('INVALID_INPUT');
  }
  return normalized;
}

function normalizeRecipientUserId(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw intentError('INVALID_INPUT');
  }
  return Number(value);
}

function normalizeRecipientEmail(value: unknown) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 191 ||
    !normalized.includes('@') ||
    /\s/.test(normalized)
  ) {
    throw intentError('INVALID_INPUT');
  }
  return normalized;
}

function normalizeSymbol(value: unknown) {
  const normalized = String(value ?? '').trim().toUpperCase();
  if (!SYMBOL_PATTERN.test(normalized)) {
    throw intentError('INVALID_INPUT');
  }
  return normalized;
}

function normalizeAmount(value: unknown) {
  if (!isPositiveDecimalText(value)) {
    throw intentError('INVALID_INPUT');
  }
  const normalized = normalizeNonNegativeDecimalText(value);
  if (!normalized) throw intentError('INVALID_INPUT');
  return normalized;
}

function normalizeRemark(value: unknown) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw intentError('INVALID_INPUT');
  const normalized = value.trim();
  if (normalized.length > 255) throw intentError('INVALID_INPUT');
  return normalized || null;
}

function normalizeTimestamp(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw intentError('INVALID_INPUT');
  }
  return Number(value);
}

function normalizeIntent(
  value: Record<string, unknown>,
): PendingUserTransferIntent {
  if (value.version !== STORAGE_VERSION) {
    if (typeof value.version === 'number' && value.version > STORAGE_VERSION) {
      throw intentError('FUTURE_SCHEMA');
    }
    throw intentError('CORRUPT_STORAGE');
  }
  const createdAtMs = normalizeTimestamp(value.createdAtMs);
  const expiresAtMs = normalizeTimestamp(value.expiresAtMs);
  if (
    expiresAtMs !== createdAtMs + PENDING_USER_TRANSFER_INTENT_TTL_MS ||
    !Number.isSafeInteger(expiresAtMs)
  ) {
    throw intentError('CORRUPT_STORAGE');
  }
  return {
    version: STORAGE_VERSION,
    ownerKey: normalizeOwnerKey(value.ownerKey),
    requestId: normalizeRequestId(value.requestId),
    recipientUserId: normalizeRecipientUserId(value.recipientUserId),
    recipientEmail: normalizeRecipientEmail(value.recipientEmail),
    symbol: normalizeSymbol(value.symbol),
    amount: normalizeAmount(value.amount),
    remark: normalizeRemark(value.remark),
    createdAtMs,
    expiresAtMs,
  };
}

function parseStoredIntent(raw: string) {
  if (!raw || raw.length > MAX_PERSISTED_BYTES) {
    throw intentError('CORRUPT_STORAGE');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw intentError('CORRUPT_STORAGE');
  }
  if (!isRecord(parsed)) throw intentError('CORRUPT_STORAGE');
  try {
    return normalizeIntent(parsed);
  } catch (error) {
    if (
      error instanceof PendingUserTransferIntentError &&
      error.code === 'FUTURE_SCHEMA'
    ) {
      throw error;
    }
    throw intentError('CORRUPT_STORAGE');
  }
}

function serializeIntent(intent: PendingUserTransferIntent) {
  const normalized = normalizeIntent(intent);
  const raw = JSON.stringify(normalized);
  if (raw.length > MAX_PERSISTED_BYTES) {
    throw intentError('INVALID_INPUT');
  }
  return raw;
}

async function readSecureRaw() {
  try {
    const logoutPending = await AsyncStorage.getItem(
      PENDING_USER_TRANSFER_LOGOUT_MARKER,
    );
    if (logoutPending) {
      await Keychain.resetGenericPassword({service: KEYCHAIN_SERVICE});
      const credentials = await Keychain.getGenericPassword({
        service: KEYCHAIN_SERVICE,
      });
      if (credentials) throw intentError('STORAGE_IO');
      await AsyncStorage.removeItem(PENDING_USER_TRANSFER_LOGOUT_MARKER);
      return null;
    }
    const credentials = await Keychain.getGenericPassword({
      service: KEYCHAIN_SERVICE,
    });
    if (!credentials) return null;
    if (credentials.username !== KEYCHAIN_USERNAME) {
      throw intentError('CORRUPT_STORAGE');
    }
    return credentials.password;
  } catch (error) {
    if (error instanceof PendingUserTransferIntentError) throw error;
    throw intentError('STORAGE_IO');
  }
}

async function writeSecureRaw(raw: string) {
  try {
    const result = await Keychain.setGenericPassword(
      KEYCHAIN_USERNAME,
      raw,
      {
        service: KEYCHAIN_SERVICE,
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      },
    );
    if (!result) throw new Error('secure storage write rejected');
    await AsyncStorage.removeItem(PENDING_USER_TRANSFER_LOGOUT_MARKER);
    const credentials = await Keychain.getGenericPassword({
      service: KEYCHAIN_SERVICE,
    });
    if (
      !credentials ||
      credentials.username !== KEYCHAIN_USERNAME ||
      credentials.password !== raw
    ) {
      throw new Error('secure storage verification failed');
    }
  } catch {
    throw intentError('STORAGE_IO');
  }
}

async function removeSecureRaw() {
  try {
    await Keychain.resetGenericPassword({service: KEYCHAIN_SERVICE});
    const credentials = await Keychain.getGenericPassword({
      service: KEYCHAIN_SERVICE,
    });
    return !credentials;
  } catch {
    throw intentError('STORAGE_IO');
  }
}

function sameIntent(
  left: PendingUserTransferIntent,
  right: PendingUserTransferIntent,
) {
  return serializeIntent(left) === serializeIntent(right);
}

function recordMatchesIntent(
  record: UserTransferRecord,
  intent: PendingUserTransferIntent,
) {
  return (
    record.requestId === intent.requestId &&
    record.direction === 'out' &&
    record.status === 'SUCCESS' &&
    record.counterpartyUserId === intent.recipientUserId &&
    record.symbol === intent.symbol &&
    record.amount === intent.amount &&
    (record.remark || '').trim() === (intent.remark || '').trim()
  );
}

export function createPendingUserTransferIntent(
  input: CreatePendingUserTransferIntentInput,
): PendingUserTransferIntent {
  const createdAtMs = normalizeTimestamp(input.createdAtMs ?? Date.now());
  const expiresAtMs = createdAtMs + PENDING_USER_TRANSFER_INTENT_TTL_MS;
  if (!Number.isSafeInteger(expiresAtMs)) throw intentError('INVALID_INPUT');
  return normalizeIntent({
    version: STORAGE_VERSION,
    ownerKey: input.ownerKey,
    requestId: input.requestId,
    recipientUserId: input.recipientUserId,
    recipientEmail: input.recipientEmail,
    symbol: input.symbol,
    amount: input.amount,
    remark: input.remark ?? null,
    createdAtMs,
    expiresAtMs,
  });
}

export async function savePendingUserTransferIntent(
  intent: PendingUserTransferIntent,
) {
  const raw = serializeIntent(intent);
  await enqueueStorageOperation(async () => {
    const existing = await readSecureRaw();
    if (existing !== null) {
      throw intentError(
        'SCOPE_OCCUPIED',
        '上一笔站内转账结果尚未确认',
      );
    }
    await writeSecureRaw(raw);
  });
}

export async function loadPendingUserTransferIntent(ownerKey: string) {
  const expectedOwnerKey = normalizeOwnerKey(ownerKey);
  return enqueueStorageOperation(async () => {
    const raw = await readSecureRaw();
    if (raw === null) return null;
    const intent = parseStoredIntent(raw);
    if (intent.ownerKey !== expectedOwnerKey) {
      throw intentError('OWNER_MISMATCH');
    }
    return intent;
  });
}

export async function clearPendingUserTransferIntent(
  intent: PendingUserTransferIntent,
) {
  const normalized = normalizeIntent(intent);
  return enqueueStorageOperation(async () => {
    const raw = await readSecureRaw();
    if (raw === null) return false;
    const persisted = parseStoredIntent(raw);
    if (!sameIntent(persisted, normalized)) return false;
    return removeSecureRaw();
  });
}

export async function clearPendingUserTransferIntentForLogout() {
  return enqueueStorageOperation(async () => {
    try {
      await AsyncStorage.setItem(PENDING_USER_TRANSFER_LOGOUT_MARKER, '1');
    } catch (markerError) {
      await removeSecureRaw();
      throw markerError;
    }
    if (!(await removeSecureRaw())) throw intentError('STORAGE_IO');
    await AsyncStorage.removeItem(PENDING_USER_TRANSFER_LOGOUT_MARKER);
  });
}

export async function recoverPendingUserTransferIntent(
  ownerKey: string,
  options: RecoveryOptions = {},
): Promise<PendingUserTransferRecoveryResult> {
  const intent = await loadPendingUserTransferIntent(ownerKey);
  if (!intent) return {status: 'NONE', intent: null, authority: null};
  const fetchStatus = options.fetchStatus ?? fetchUserTransferRequestStatus;
  const authority = await fetchStatus(intent.requestId);

  if (authority.requestId !== intent.requestId) {
    return {status: 'COMPLETED_MISMATCH', intent, authority};
  }
  if (authority.state === 'NOT_FOUND') {
    const nowMs = normalizeTimestamp(options.nowMs ?? Date.now());
    if (nowMs < intent.expiresAtMs) {
      return {status: 'NOT_FOUND', intent, authority};
    }
    const cleared = await clearPendingUserTransferIntent(intent);
    return {
      status: cleared ? 'EXPIRED_NOT_FOUND_CLEARED' : 'LOCK_CHANGED',
      intent,
      authority,
    };
  }
  if (!authority.record || !recordMatchesIntent(authority.record, intent)) {
    return {status: 'COMPLETED_MISMATCH', intent, authority};
  }
  const cleared = await clearPendingUserTransferIntent(intent);
  return {
    status: cleared ? 'COMPLETED_CLEARED' : 'LOCK_CHANGED',
    intent,
    authority,
  };
}

/** Test-only native location for corruption and cleanup assertions. */
export function __pendingUserTransferSecureLocationForTests() {
  return {service: KEYCHAIN_SERVICE, username: KEYCHAIN_USERNAME};
}

export function resetPendingUserTransferIntentForTests() {
  storageTail = Promise.resolve();
}
