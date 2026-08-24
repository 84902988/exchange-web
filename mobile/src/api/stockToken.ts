import {apiClient, type ApiRequestOptions} from './client';
import {normalizeNonNegativeDecimalText} from '../utils/decimalText';

const LOCK_STATUSES = new Set(['LOCKED', 'ACTIVE', 'RELEASED']);
const CONVERT_STATUSES = new Set(['SUCCESS', 'FAILED']);

export type StockTokenLockStatus = 'LOCKED' | 'ACTIVE' | 'RELEASED';
export type StockTokenConvertStatus = 'SUCCESS' | 'FAILED';

export type StockTokenLock = {
  id: number;
  lockSymbol: string;
  tradeSymbol: string | null;
  totalAmount: string;
  lockedAmount: string;
  availableAmount: string;
  convertedAmount: string;
  conversionRateSnapshot: string;
  dailyReleaseRate: string;
  lockDays: number;
  releaseDays: number;
  unlockAt: string | null;
  lockStartAt: string | null;
  lockEndAt: string | null;
  releaseStartAt: string | null;
  releaseFinishAt: string | null;
  releaseStarted: boolean;
  progressPercent: string;
  status: StockTokenLockStatus;
  startAt: string | null;
  endAt: string | null;
};

export type StockTokenConvertRecord = {
  id: number;
  fromSymbol: string;
  toSymbol: string;
  fromAmount: string;
  toAmount: string;
  conversionRate: string;
  status: StockTokenConvertStatus;
  createdAt: string | null;
};

export type StockTokenLocksResponse = {items: StockTokenLock[]};
export type StockTokenConvertsResponse = {items: StockTokenConvertRecord[]};

export class StockTokenContractError extends Error {
  constructor() {
    super('股票代币数据格式异常，请稍后重试');
    this.name = 'StockTokenContractError';
  }
}

export async function fetchStockTokenLocks(
  options?: ApiRequestOptions,
): Promise<StockTokenLocksResponse> {
  const payload = await apiClient.get<unknown>('/stock-token/locks', options);
  return normalizeStockTokenLocks(payload);
}

export async function fetchStockTokenConverts(
  options?: ApiRequestOptions,
): Promise<StockTokenConvertsResponse> {
  const payload = await apiClient.get<unknown>('/stock-token/converts', options);
  return normalizeStockTokenConverts(payload);
}

export function normalizeStockTokenLocks(
  payload: unknown,
): StockTokenLocksResponse {
  const data = requiredRecord(payload);
  if (!Array.isArray(data.items)) throw new StockTokenContractError();
  return {items: data.items.map(normalizeStockTokenLock)};
}

export function normalizeStockTokenConverts(
  payload: unknown,
): StockTokenConvertsResponse {
  const data = requiredRecord(payload);
  if (!Array.isArray(data.items)) throw new StockTokenContractError();
  return {items: data.items.map(normalizeStockTokenConvert)};
}

function normalizeStockTokenLock(payload: unknown): StockTokenLock {
  const data = requiredRecord(payload);
  return {
    id: requiredPositiveInteger(data.id),
    lockSymbol: requiredSymbol(data.lock_symbol),
    tradeSymbol: nullableSymbol(data.trade_symbol),
    totalAmount: requiredDecimal(data.total_amount),
    lockedAmount: requiredDecimal(data.locked_amount),
    availableAmount: requiredDecimal(data.available_amount),
    convertedAmount: requiredDecimal(data.converted_amount),
    conversionRateSnapshot: requiredDecimal(data.conversion_rate_snapshot),
    dailyReleaseRate: requiredDecimal(data.daily_release_rate),
    lockDays: requiredNonNegativeInteger(data.lock_days),
    releaseDays: requiredNonNegativeInteger(data.release_days),
    unlockAt: nullableString(data.unlock_at),
    lockStartAt: nullableString(data.lock_start_at),
    lockEndAt: nullableString(data.lock_end_at),
    releaseStartAt: nullableString(data.release_start_at),
    releaseFinishAt: nullableString(data.release_finish_at),
    releaseStarted: requiredBoolean(data.release_started),
    progressPercent: requiredDecimal(data.progress_percent),
    status: requiredStatus(data.status, LOCK_STATUSES) as StockTokenLockStatus,
    startAt: nullableString(data.start_at),
    endAt: nullableString(data.end_at),
  };
}

function normalizeStockTokenConvert(
  payload: unknown,
): StockTokenConvertRecord {
  const data = requiredRecord(payload);
  return {
    id: requiredPositiveInteger(data.id),
    fromSymbol: requiredSymbol(data.from_symbol),
    toSymbol: requiredSymbol(data.to_symbol),
    fromAmount: requiredDecimal(data.from_amount),
    toAmount: requiredDecimal(data.to_amount),
    conversionRate: requiredDecimal(data.conversion_rate),
    status: requiredStatus(
      data.status,
      CONVERT_STATUSES,
    ) as StockTokenConvertStatus,
    createdAt: nullableString(data.created_at),
  };
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new StockTokenContractError();
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new StockTokenContractError();
  }
  return value.trim();
}

function nullableString(value: unknown) {
  if (value === null || value === undefined) return null;
  return requiredString(value);
}

function requiredSymbol(value: unknown) {
  const symbol = requiredString(value).toUpperCase();
  if (!/^[A-Z0-9._-]{1,30}$/.test(symbol)) {
    throw new StockTokenContractError();
  }
  return symbol;
}

function nullableSymbol(value: unknown) {
  if (value === null || value === undefined) return null;
  return requiredSymbol(value);
}

function requiredDecimal(value: unknown) {
  const normalized = normalizeNonNegativeDecimalText(value);
  if (normalized === null) throw new StockTokenContractError();
  return normalized;
}

function requiredBoolean(value: unknown) {
  if (typeof value !== 'boolean') throw new StockTokenContractError();
  return value;
}

function requiredNonNegativeInteger(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new StockTokenContractError();
  }
  return Number(value);
}

function requiredPositiveInteger(value: unknown) {
  const number = requiredNonNegativeInteger(value);
  if (number < 1) throw new StockTokenContractError();
  return number;
}

function requiredStatus(value: unknown, allowed: Set<string>) {
  const status = requiredString(value).toUpperCase();
  if (!allowed.has(status)) throw new StockTokenContractError();
  return status;
}
