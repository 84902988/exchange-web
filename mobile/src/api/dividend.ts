import {apiClient, type ApiRequestOptions} from './client';

export type DividendSummary = {
  totalRcb: string;
  monthRcb: string;
  latestAmountRcb: string | null;
  latestDividendDate: string | null;
  latestStatus: string | null;
  currentSvipLevel: string | null;
  eligible: boolean;
};

export type DividendRecord = {
  id: number;
  dividendDate: string | null;
  svipLevelCode: string;
  amountRcb: string;
  amountUsdt: string;
  status: string;
  paidAt: string | null;
};

export type DividendRecordPage = {
  items: DividendRecord[];
  total: number;
  page: number;
  pageSize: number;
};

export class DividendContractError extends Error {
  constructor() {
    super('分红数据格式异常，请稍后重试');
    this.name = 'DividendContractError';
  }
}

export async function fetchMyDividendSummary(
  options?: ApiRequestOptions,
): Promise<DividendSummary> {
  const payload = await apiClient.get<unknown>('/dividend/my/summary', options);
  return normalizeDividendSummary(payload);
}

export async function fetchMyDividendRecords(
  page = 1,
  pageSize = 20,
  options?: ApiRequestOptions,
): Promise<DividendRecordPage> {
  const query = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
  });
  const payload = await apiClient.get<unknown>(
    `/dividend/my/records?${query.toString()}`,
    options,
  );
  return normalizeDividendRecordPage(payload);
}

export function normalizeDividendSummary(payload: unknown): DividendSummary {
  const data = requiredRecord(payload);
  return {
    totalRcb: requiredDecimal(data.total_rcb),
    monthRcb: requiredDecimal(data.month_rcb),
    latestAmountRcb: nullableDecimal(data.latest_amount_rcb),
    latestDividendDate: nullableString(data.latest_dividend_date),
    latestStatus: nullableString(data.latest_status),
    currentSvipLevel: nullableString(data.current_svip_level),
    eligible: requiredBoolean(data.eligible),
  };
}

export function normalizeDividendRecordPage(
  payload: unknown,
): DividendRecordPage {
  const data = requiredRecord(payload);
  if (!Array.isArray(data.items)) throw new DividendContractError();
  return {
    items: data.items.map(normalizeDividendRecord),
    total: requiredNonNegativeInteger(data.total),
    page: requiredPositiveInteger(data.page),
    pageSize: requiredPositiveInteger(data.page_size),
  };
}

function normalizeDividendRecord(payload: unknown): DividendRecord {
  const data = requiredRecord(payload);
  return {
    id: requiredPositiveInteger(data.id),
    dividendDate: nullableString(data.dividend_date),
    svipLevelCode: requiredString(data.svip_level_code),
    amountRcb: requiredDecimal(data.amount_rcb),
    amountUsdt: requiredDecimal(data.amount_usdt),
    status: requiredString(data.status),
    paidAt: nullableString(data.paid_at),
  };
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DividendContractError();
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new DividendContractError();
  }
  return value.trim();
}

function nullableString(value: unknown) {
  if (value === null || value === undefined) return null;
  return requiredString(value);
}

function requiredDecimal(value: unknown) {
  const text = requiredString(value);
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new DividendContractError();
  return text;
}

function nullableDecimal(value: unknown) {
  if (value === null || value === undefined) return null;
  return requiredDecimal(value);
}

function requiredBoolean(value: unknown) {
  if (typeof value !== 'boolean') throw new DividendContractError();
  return value;
}

function requiredNonNegativeInteger(value: unknown) {
  if (!Number.isInteger(value) || Number(value) < 0) {
    throw new DividendContractError();
  }
  return Number(value);
}

function requiredPositiveInteger(value: unknown) {
  const number = requiredNonNegativeInteger(value);
  if (number < 1) throw new DividendContractError();
  return number;
}
