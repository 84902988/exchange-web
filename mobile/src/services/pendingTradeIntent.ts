import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import {ApiClientError} from '../api/client';
import {
  fetchTradeIdempotencyStatus,
  type TradeIdempotencyAuthority,
} from '../api/tradeIdempotency';

export type PendingTradeIntentMarket = 'spot' | 'contract';

type PendingTradeIntentCommon<
  Payload extends Record<string, unknown>,
> = {
  id: string;
  market: PendingTradeIntentMarket;
  ownerKey: string;
  instrumentKey: string;
  payload: Payload;
  baselineIds: number[];
  createdAtMs: number;
};

export type LegacyPendingTradeIntent<
  Payload extends Record<string, unknown> = Record<string, unknown>,
> = PendingTradeIntentCommon<Payload> & {
  version: 1;
};

export type PendingTradeIntentV2<
  Payload extends Record<string, unknown> = Record<string, unknown>,
> = PendingTradeIntentCommon<Payload> & {
  version: 2;
  clientOrderId: string;
  revision: number;
};

export type PendingTradeIntent<
  Payload extends Record<string, unknown> = Record<string, unknown>,
> = LegacyPendingTradeIntent<Payload> | PendingTradeIntentV2<Payload>;

type CreatePendingTradeIntentInput<
  Payload extends Record<string, unknown>,
> = {
  market: PendingTradeIntentMarket;
  ownerKey: string;
  instrumentKey: string;
  payload: Payload;
  baselineIds?: readonly number[];
  createdAtMs?: number;
};

type PotentiallyCommittedErrorOptions = {
  invalidResponseCodes?: readonly string[];
};

export type CorruptPendingTradeIntentToken = {
  tokenVersion: 1;
  market: PendingTradeIntentMarket;
  ownerKey: string;
  instrumentKey: string;
  rawHash: string;
  observedAtMs: number;
  clientOrderId: string | null;
};

export type PendingTradeIntentLoadFailureKind =
  | 'CORRUPT'
  | 'FUTURE_SCHEMA'
  | 'STORAGE_IO';

export class PendingTradeIntentLoadError extends Error {
  readonly kind: PendingTradeIntentLoadFailureKind;
  readonly token: CorruptPendingTradeIntentToken | null;

  constructor(
    message: string,
    kind: PendingTradeIntentLoadFailureKind,
    token: CorruptPendingTradeIntentToken | null = null,
  ) {
    super(message);
    this.name = 'PendingTradeIntentLoadError';
    this.kind = kind;
    this.token = token;
  }
}

export class PendingTradeIntentConflictError extends Error {
  readonly code = 'PENDING_TRADE_INTENT_SCOPE_OCCUPIED';

  constructor() {
    super('上一笔订单状态尚未确认，未提交新的委托');
    this.name = 'PendingTradeIntentConflictError';
  }
}

export type CorruptPendingTradeIntentRecoveryResult =
  | {
      status: 'COMPLETED_CLEARED';
      authority: TradeIdempotencyAuthority;
    }
  | {
      status: 'NOT_FOUND' | 'PENDING';
      authority: TradeIdempotencyAuthority;
    }
  | {
      status: 'UNRECOVERABLE' | 'SCOPE_MISMATCH' | 'LOCK_CHANGED';
      authority: TradeIdempotencyAuthority | null;
    };

const STORAGE_PREFIX = '@exchange-mobile/pending-trade-intent/v1';
const SECURE_STORAGE_SERVICE_PREFIX =
  'com.exchangemobile.pending-trade-intent.v1';
const SECURE_STORAGE_USERNAME = 'pending-trade-intent';
const MAX_PERSISTED_INTENT_BYTES = 128 * 1024;
const ALWAYS_AMBIGUOUS_CODES = new Set([
  'AUTH_SESSION_CHANGED',
  'IDEMPOTENCY_KEY_REUSED',
  'IDEMPOTENCY_KEY_REUSE_MISMATCH',
  'IDEMPOTENCY_RESULT_UNAVAILABLE',
  'KEY_REUSE_MISMATCH',
  'NETWORK_ERROR',
  'TIMEOUT',
]);
const CLIENT_ORDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const memory = new Map<string, PendingTradeIntent>();
let storageTail: Promise<void> = Promise.resolve();
let clientOrderSequence = 0;
let corruptRawByToken = new WeakMap<CorruptPendingTradeIntentToken, string>();

function enqueueStorageOperation<T>(operation: () => Promise<T>) {
  const result = storageTail.catch(() => undefined).then(operation);
  storageTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function requireIdentity(value: string, label: string) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label}不能为空`);
  return normalized;
}

function storageKey(
  market: PendingTradeIntentMarket,
  ownerKey: string,
  instrumentKey: string,
) {
  return [
    STORAGE_PREFIX,
    market,
    encodeURIComponent(requireIdentity(ownerKey, 'ownerKey')),
    encodeURIComponent(requireIdentity(instrumentKey, 'instrumentKey')),
  ].join(':');
}

function secureStorageService(key: string) {
  return `${SECURE_STORAGE_SERVICE_PREFIX}.${hashRawValue(key)}`;
}

/** Test-only locator for simulating native storage races. */
export function __pendingTradeIntentSecureLocationForTests(
  market: PendingTradeIntentMarket,
  ownerKey: string,
  instrumentKey: string,
) {
  const key = storageKey(market, ownerKey, instrumentKey);
  return {
    service: secureStorageService(key),
    username: SECURE_STORAGE_USERNAME,
  };
}

function normalizeBaselineIds(values: readonly number[] | undefined) {
  return Array.from(
    new Set(
      (values || []).filter(
        value => Number.isSafeInteger(value) && Number(value) > 0,
      ),
    ),
  ).map(Number);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function isOpaqueClientOrderId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 64 &&
    CLIENT_ORDER_ID_PATTERN.test(value)
  );
}

function randomHex(byteLength: number) {
  const bytes = new Uint8Array(byteLength);
  const cryptoLike = (
    globalThis as typeof globalThis & {
      crypto?: {getRandomValues?: (values: Uint8Array) => Uint8Array};
    }
  ).crypto;
  if (typeof cryptoLike?.getRandomValues === 'function') {
    cryptoLike.getRandomValues(bytes);
  } else {
    // client_order_id is an opaque uniqueness key, not an authentication
    // secret. Time + process sequence + 128 pseudo-random bits keeps the
    // fallback collision domain bounded without adding a native dependency.
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, value => value.toString(16).padStart(2, '0')).join(
    '',
  );
}

export function createOpaqueClientOrderId(createdAtMs = Date.now()) {
  if (!Number.isFinite(createdAtMs) || createdAtMs <= 0) {
    throw new Error('createdAtMs 无效');
  }
  clientOrderSequence = (clientOrderSequence + 1) % 0x1000000;
  const value = `m-${Math.floor(createdAtMs).toString(36)}-${clientOrderSequence
    .toString(36)
    .padStart(5, '0')}-${randomHex(16)}`;
  if (!isOpaqueClientOrderId(value)) {
    throw new Error('client_order_id 生成失败');
  }
  return value;
}

function hashRawValue(raw: string) {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < raw.length; index += 1) {
    hash = BigInt.asUintN(
      64,
      hash * 0x100000001b3n + BigInt(raw.charCodeAt(index) + 1),
    );
  }
  return hash.toString(16).padStart(16, '0');
}

function extractRecoverableClientOrderId(raw: string) {
  const values = new Set<string>();
  const pattern = /"(?:clientOrderId|client_order_id)"\s*:\s*"([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(raw)) !== null) {
    if (isOpaqueClientOrderId(match[1])) values.add(match[1]);
  }
  return values.size === 1 ? Array.from(values)[0] : null;
}

function corruptLoadError(
  raw: string,
  expected: {
    market: PendingTradeIntentMarket;
    ownerKey: string;
    instrumentKey: string;
  },
  message: string,
) {
  const token: CorruptPendingTradeIntentToken = {
    tokenVersion: 1,
    market: expected.market,
    ownerKey: expected.ownerKey,
    instrumentKey: expected.instrumentKey,
    rawHash: hashRawValue(raw),
    observedAtMs: Date.now(),
    clientOrderId: extractRecoverableClientOrderId(raw),
  };
  corruptRawByToken.set(token, raw);
  return new PendingTradeIntentLoadError(message, 'CORRUPT', token);
}

function hasValidCommonFields(
  value: Record<string, unknown>,
  expected: {
    market: PendingTradeIntentMarket;
    ownerKey: string;
    instrumentKey: string;
  },
) {
  return (
    typeof value.id === 'string' &&
    Boolean(value.id.trim()) &&
    value.market === expected.market &&
    value.ownerKey === expected.ownerKey &&
    value.instrumentKey === expected.instrumentKey &&
    isRecord(value.payload) &&
    Array.isArray(value.baselineIds) &&
    value.baselineIds.every(
      item => Number.isSafeInteger(item) && Number(item) > 0,
    ) &&
    typeof value.createdAtMs === 'number' &&
    Number.isFinite(value.createdAtMs) &&
    value.createdAtMs > 0
  );
}

function parsePersistedIntent(
  raw: string,
  expected: {
    market: PendingTradeIntentMarket;
    ownerKey: string;
    instrumentKey: string;
  },
): PendingTradeIntent {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw corruptLoadError(
      raw,
      expected,
      '上一笔订单记录不完整，当前交易已暂停',
    );
  }
  if (
    isRecord(value) &&
    typeof value.version === 'number' &&
    Number.isFinite(value.version) &&
    value.version > 2
  ) {
    throw new PendingTradeIntentLoadError(
      '订单恢复信息来自新版本，请升级应用后继续',
      'FUTURE_SCHEMA',
    );
  }
  if (!isRecord(value) || !hasValidCommonFields(value, expected)) {
    throw corruptLoadError(
      raw,
      expected,
      '上一笔订单记录无效，当前交易已暂停',
    );
  }
  if (value.version === 1) {
    return value as LegacyPendingTradeIntent;
  }
  if (
    value.version === 2 &&
    isOpaqueClientOrderId(value.clientOrderId) &&
    value.id === value.clientOrderId &&
    Number.isSafeInteger(value.revision) &&
    Number(value.revision) > 0
  ) {
    return value as PendingTradeIntentV2;
  }
  throw corruptLoadError(
    raw,
    expected,
    '上一笔订单记录无效，当前交易已暂停',
  );
}

function storageIoError(message: string) {
  return new PendingTradeIntentLoadError(message, 'STORAGE_IO');
}

async function readNativeStorageRaw(key: string) {
  try {
    const credentials = await Keychain.getGenericPassword({
      service: secureStorageService(key),
    });
    if (!credentials) return null;
    if (credentials.username !== SECURE_STORAGE_USERNAME) {
      throw storageIoError('订单安全存储身份无效，当前交易已暂停');
    }
    if (
      !credentials.password ||
      credentials.password.length > MAX_PERSISTED_INTENT_BYTES
    ) {
      throw storageIoError('订单安全存储内容无效，当前交易已暂停');
    }
    return credentials.password;
  } catch (error) {
    if (error instanceof PendingTradeIntentLoadError) throw error;
    throw storageIoError('上一笔订单安全存储读取失败，当前交易已暂停');
  }
}

async function writeNativeStorageRaw(key: string, raw: string) {
  if (!raw || raw.length > MAX_PERSISTED_INTENT_BYTES) {
    throw storageIoError('订单信息过大，未提交任何委托');
  }
  try {
    const result = await Keychain.setGenericPassword(
      SECURE_STORAGE_USERNAME,
      raw,
      {
        service: secureStorageService(key),
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      },
    );
    if (!result) throw storageIoError('订单安全存储写入失败，未提交任何委托');
  } catch (error) {
    if (error instanceof PendingTradeIntentLoadError) throw error;
    throw storageIoError('订单安全存储写入失败，未提交任何委托');
  }
  const verified = await readNativeStorageRaw(key);
  if (verified !== raw) {
    throw storageIoError('订单安全存储校验失败，未提交任何委托');
  }
}

async function readStorageRaw(key: string) {
  try {
    const [secureRaw, legacyRaw] = await Promise.all([
      readNativeStorageRaw(key),
      AsyncStorage.getItem(key),
    ]);
    if (secureRaw !== null) {
      if (legacyRaw !== null && legacyRaw !== secureRaw) {
        throw storageIoError('检测到冲突的订单恢复信息，当前交易已暂停');
      }
      if (legacyRaw === secureRaw) await AsyncStorage.removeItem(key);
      return secureRaw;
    }
    if (legacyRaw === null) return null;

    // Preserve any legacy raw value exactly, including a corrupt fail-closed
    // lock that may still contain a recoverable client_order_id.
    await writeNativeStorageRaw(key, legacyRaw);
    await AsyncStorage.removeItem(key);
    return legacyRaw;
  } catch {
    throw storageIoError('上一笔订单状态读取失败，当前交易已暂停');
  }
}

async function removeStorageRaw(key: string) {
  try {
    await Keychain.resetGenericPassword({service: secureStorageService(key)});
    await AsyncStorage.removeItem(key);
    const [secureRaw, legacyRaw] = await Promise.all([
      readNativeStorageRaw(key),
      AsyncStorage.getItem(key),
    ]);
    return secureRaw === null && legacyRaw === null;
  } catch {
    throw storageIoError('订单安全存储清理失败，交易保护保持开启');
  }
}

export function isPendingTradeIntentLoadError(
  error: unknown,
): error is PendingTradeIntentLoadError {
  return error instanceof PendingTradeIntentLoadError;
}

export function createPendingTradeIntent<
  Payload extends Record<string, unknown>,
>({
  market,
  ownerKey,
  instrumentKey,
  payload,
  baselineIds,
  createdAtMs = Date.now(),
}: CreatePendingTradeIntentInput<Payload>): PendingTradeIntentV2<Payload> {
  const normalizedOwnerKey = requireIdentity(ownerKey, 'ownerKey');
  const normalizedInstrumentKey = requireIdentity(
    instrumentKey,
    'instrumentKey',
  );
  const clientOrderId = createOpaqueClientOrderId(createdAtMs);
  return {
    version: 2,
    id: clientOrderId,
    clientOrderId,
    revision: 1,
    market,
    ownerKey: normalizedOwnerKey,
    instrumentKey: normalizedInstrumentKey,
    payload,
    baselineIds: normalizeBaselineIds(baselineIds),
    createdAtMs,
  };
}

export async function loadPendingTradeIntent<
  Payload extends Record<string, unknown> = Record<string, unknown>,
>(
  market: PendingTradeIntentMarket,
  ownerKey: string,
  instrumentKey: string,
): Promise<PendingTradeIntent<Payload> | null> {
  const normalizedOwnerKey = requireIdentity(ownerKey, 'ownerKey');
  const normalizedInstrumentKey = requireIdentity(
    instrumentKey,
    'instrumentKey',
  );
  const key = storageKey(market, normalizedOwnerKey, normalizedInstrumentKey);

  return enqueueStorageOperation(async () => {
    const raw = await readStorageRaw(key);
    if (!raw) {
      memory.delete(key);
      return null;
    }
    const parsed = parsePersistedIntent(raw, {
      market,
      ownerKey: normalizedOwnerKey,
      instrumentKey: normalizedInstrumentKey,
    });
    memory.set(key, parsed);
    return parsed as PendingTradeIntent<Payload>;
  });
}

export async function savePendingTradeIntent<
  Payload extends Record<string, unknown>,
>(intent: PendingTradeIntentV2<Payload>) {
  const key = storageKey(intent.market, intent.ownerKey, intent.instrumentKey);
  const serialized = JSON.stringify(intent);
  parsePersistedIntent(serialized, {
    market: intent.market,
    ownerKey: intent.ownerKey,
    instrumentKey: intent.instrumentKey,
  });

  await enqueueStorageOperation(async () => {
    // Memory is deliberately not consulted. Any persisted value, including a
    // corrupt or future-version record, owns the scope and blocks overwrite.
    const existing = await readStorageRaw(key);
    if (existing !== null) throw new PendingTradeIntentConflictError();
    await writeNativeStorageRaw(key, serialized);
    memory.set(key, intent);
  });
}

function isSamePersistedIntent(
  persisted: PendingTradeIntent,
  expected: PendingTradeIntent,
) {
  if (persisted.version !== expected.version || persisted.id !== expected.id) {
    return false;
  }
  if (persisted.version === 2 && expected.version === 2) {
    return (
      persisted.clientOrderId === expected.clientOrderId &&
      persisted.revision === expected.revision
    );
  }
  return persisted.version === 1 && expected.version === 1;
}

export async function clearPendingTradeIntent(
  intent: PendingTradeIntent,
): Promise<boolean> {
  const key = storageKey(intent.market, intent.ownerKey, intent.instrumentKey);
  return enqueueStorageOperation(async () => {
    const raw = await readStorageRaw(key);
    if (!raw) {
      memory.delete(key);
      return false;
    }
    const persisted = parsePersistedIntent(raw, {
      market: intent.market,
      ownerKey: intent.ownerKey,
      instrumentKey: intent.instrumentKey,
    });
    if (!isSamePersistedIntent(persisted, intent)) return false;
    if (!(await removeStorageRaw(key))) return false;
    memory.delete(key);
    return true;
  });
}

export async function recoverCorruptPendingTradeIntent(
  failure: PendingTradeIntentLoadError,
  canClear: () => boolean,
): Promise<CorruptPendingTradeIntentRecoveryResult> {
  const token = failure.kind === 'CORRUPT' ? failure.token : null;
  if (!token?.clientOrderId) {
    return {status: 'UNRECOVERABLE', authority: null};
  }
  const expectedRaw = corruptRawByToken.get(token);
  if (!expectedRaw) {
    return {status: 'LOCK_CHANGED', authority: null};
  }
  const authority = await fetchTradeIdempotencyStatus(
    token.market,
    token.clientOrderId,
  );
  if (authority.status === 'NOT_FOUND' || authority.status === 'PENDING') {
    return {status: authority.status, authority};
  }
  if (
    authority.clientOrderId !== token.clientOrderId ||
    authority.resultSymbol !== token.instrumentKey.trim().toUpperCase()
  ) {
    return {status: 'SCOPE_MISMATCH', authority};
  }
  if (!canClear()) {
    return {status: 'LOCK_CHANGED', authority};
  }

  const key = storageKey(token.market, token.ownerKey, token.instrumentKey);
  const cleared = await enqueueStorageOperation(async () => {
    if (!canClear()) return false;
    const currentRaw = await readStorageRaw(key);
    if (
      currentRaw === null ||
      currentRaw !== expectedRaw ||
      hashRawValue(currentRaw) !== token.rawHash
    ) {
      return false;
    }
    if (!canClear()) return false;
    if (!(await removeStorageRaw(key))) return false;
    memory.delete(key);
    corruptRawByToken.delete(token);
    return true;
  });
  return cleared
    ? {status: 'COMPLETED_CLEARED', authority}
    : {status: 'LOCK_CHANGED', authority};
}

export function isPotentiallyCommittedMutationError(
  error: unknown,
  options: PotentiallyCommittedErrorOptions = {},
) {
  if (!(error instanceof ApiClientError)) return false;
  const code = String(error.code || '').trim().toUpperCase();
  const invalidResponseCodes = new Set(
    (options.invalidResponseCodes || []).map(item =>
      String(item || '').trim().toUpperCase(),
    ),
  );
  if (ALWAYS_AMBIGUOUS_CODES.has(code) || invalidResponseCodes.has(code)) {
    return true;
  }
  return error.status !== undefined && error.status >= 500;
}

export function resetPendingTradeIntentMemoryForTests() {
  memory.clear();
  storageTail = Promise.resolve();
  clientOrderSequence = 0;
  corruptRawByToken = new WeakMap();
}
