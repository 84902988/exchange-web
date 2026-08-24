import {apiClient, type ApiRequestOptions} from './client';
import {
  isPositiveDecimalText,
  normalizeNonNegativeDecimalText,
} from '../utils/decimalText';

const DIRECTIONS = new Set(['in', 'out']);
const PRIVATE_BALANCE_FIELDS = [
  'sender_available_before',
  'sender_available_after',
  'receiver_available_before',
  'receiver_available_after',
] as const;

export type UserTransferDirection = 'all' | 'in' | 'out';

export type UserTransferRecipient = {
  userId: number;
  emailMask: string;
  nickname: string | null;
  canTransfer: boolean;
};

export type CreateUserTransferInput = {
  requestId: string;
  recipientEmail: string;
  recipientUserId: number;
  symbol: string;
  amount: string;
  remark?: string | null;
};

export type UserTransferRecord = {
  id: number;
  transferNo: string;
  requestId: string;
  direction: Exclude<UserTransferDirection, 'all'>;
  counterpartyUserId: number;
  counterpartyNickname: string | null;
  recipientNickname: string | null;
  recipientEmailMask: string;
  symbol: string;
  amount: string;
  feeAmount: string;
  netAmount: string;
  status: string;
  remark: string | null;
  createdAt: string;
};

export type UserTransferRecordsResponse = {
  items: UserTransferRecord[];
  total: number;
  page: number;
  pageSize: number;
};

export type UserTransferRequestStatusResponse = {
  requestId: string;
  state: 'COMPLETED' | 'NOT_FOUND';
  record: UserTransferRecord | null;
};

export class UserTransferContractError extends Error {
  constructor() {
    super('站内转账记录格式异常，请稍后重试');
    this.name = 'UserTransferContractError';
  }
}

export async function resolveUserTransferRecipient(
  email: string,
  options?: ApiRequestOptions,
): Promise<UserTransferRecipient> {
  const normalizedEmail = normalizeRecipientEmail(email);
  const query = new URLSearchParams({email: normalizedEmail});
  const payload = await apiClient.get<unknown>(
    `/user-transfer/recipient/resolve?${query.toString()}`,
    options,
  );
  return normalizeUserTransferRecipient(payload);
}

export async function createUserTransfer(
  input: CreateUserTransferInput,
  options?: ApiRequestOptions,
): Promise<UserTransferRecord> {
  const expected = normalizeCreateInput(input);
  const payload = await apiClient.post<unknown>(
    '/user-transfer',
    {
      request_id: expected.requestId,
      recipient_email: expected.recipientEmail,
      symbol: expected.symbol,
      amount: expected.amount,
      remark: expected.remark || undefined,
    },
    options,
  );
  return normalizeUserTransferSubmit(payload, expected);
}

export async function fetchUserTransferRecords(
  params: {
    direction?: UserTransferDirection;
    page?: number;
    pageSize?: number;
  } = {},
  options?: ApiRequestOptions,
): Promise<UserTransferRecordsResponse> {
  const query = new URLSearchParams({
    direction: params.direction ?? 'all',
    page: String(params.page ?? 1),
    page_size: String(params.pageSize ?? 20),
  });
  const payload = await apiClient.get<unknown>(
    `/user-transfer/records?${query.toString()}`,
    options,
  );
  return normalizeUserTransferRecords(payload);
}

export async function fetchUserTransferRequestStatus(
  requestId: string,
  options?: ApiRequestOptions,
): Promise<UserTransferRequestStatusResponse> {
  const normalizedRequestId = requestId.trim();
  if (!normalizedRequestId || normalizedRequestId.length > 64) {
    throw new UserTransferContractError();
  }
  const query = new URLSearchParams({request_id: normalizedRequestId});
  const payload = await apiClient.get<unknown>(
    `/user-transfer/request-status?${query.toString()}`,
    options,
  );
  return normalizeUserTransferRequestStatus(payload, normalizedRequestId);
}

export function normalizeUserTransferRecords(
  payload: unknown,
): UserTransferRecordsResponse {
  const root = requiredRecord(payload);
  if (!Array.isArray(root.items)) throw new UserTransferContractError();
  return {
    items: root.items.map(normalizeRecord),
    total: requiredNonNegativeInteger(root.total),
    page: requiredPositiveInteger(root.page),
    pageSize: requiredPositiveInteger(root.page_size),
  };
}

export function normalizeUserTransferRecipient(
  payload: unknown,
): UserTransferRecipient {
  const root = requiredRecord(payload);
  if ('email' in root || 'recipient_email' in root) {
    throw new UserTransferContractError();
  }
  if (typeof root.can_transfer !== 'boolean') {
    throw new UserTransferContractError();
  }
  return {
    userId: requiredPositiveInteger(root.user_id),
    emailMask: requiredString(root.email_mask),
    nickname: nullableString(root.nickname),
    canTransfer: root.can_transfer,
  };
}

export function normalizeUserTransferSubmit(
  payload: unknown,
  expectedInput: CreateUserTransferInput,
): UserTransferRecord {
  const expected = normalizeCreateInput(expectedInput);
  const root = requiredRecord(payload);
  const record = normalizeRecord(root.record);
  if (
    record.requestId !== expected.requestId ||
    record.direction !== 'out' ||
    record.counterpartyUserId !== expected.recipientUserId ||
    record.symbol !== expected.symbol ||
    record.amount !== expected.amount ||
    (record.remark || null) !== expected.remark ||
    record.status !== 'SUCCESS'
  ) {
    throw new UserTransferContractError();
  }
  return record;
}

export function normalizeUserTransferRequestStatus(
  payload: unknown,
  expectedRequestId: string,
): UserTransferRequestStatusResponse {
  const root = requiredRecord(payload);
  const requestId = requiredString(root.request_id);
  const state = requiredString(root.state).toUpperCase();
  if (requestId !== expectedRequestId) throw new UserTransferContractError();
  if (state === 'NOT_FOUND') {
    if (root.record !== null && root.record !== undefined) {
      throw new UserTransferContractError();
    }
    return {requestId, state, record: null};
  }
  if (state !== 'COMPLETED') throw new UserTransferContractError();
  const record = normalizeRecord(root.record);
  if (
    record.requestId !== requestId ||
    record.direction !== 'out' ||
    record.status !== 'SUCCESS'
  ) {
    throw new UserTransferContractError();
  }
  return {requestId, state, record};
}

function normalizeRecord(payload: unknown): UserTransferRecord {
  const row = requiredRecord(payload);
  if (PRIVATE_BALANCE_FIELDS.some(field => field in row)) {
    throw new UserTransferContractError();
  }
  const direction = requiredString(row.direction).toLowerCase();
  if (!DIRECTIONS.has(direction)) throw new UserTransferContractError();
  if (requiredString(row.from_account).toLowerCase() !== 'funding') {
    throw new UserTransferContractError();
  }
  if (requiredString(row.to_account).toLowerCase() !== 'funding') {
    throw new UserTransferContractError();
  }
  return {
    id: requiredPositiveInteger(row.id),
    transferNo: requiredString(row.transfer_no),
    requestId: requiredString(row.request_id),
    direction: direction as UserTransferRecord['direction'],
    counterpartyUserId: requiredPositiveInteger(row.counterparty_user_id),
    counterpartyNickname: nullableString(row.counterparty_nickname),
    recipientNickname: nullableString(row.recipient_nickname),
    recipientEmailMask: requiredString(row.recipient_email_mask),
    symbol: requiredSymbol(row.symbol),
    amount: requiredDecimal(row.amount),
    feeAmount: requiredDecimal(row.fee_amount),
    netAmount: requiredDecimal(row.net_amount),
    status: requiredString(row.status).toUpperCase(),
    remark: nullableString(row.remark),
    createdAt: requiredString(row.created_at),
  };
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new UserTransferContractError();
  }
  return value as Record<string, unknown>;
}

function normalizeCreateInput(
  input: CreateUserTransferInput,
): Required<CreateUserTransferInput> {
  const requestId = String(input.requestId || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(requestId)) {
    throw new UserTransferContractError();
  }
  if (!Number.isSafeInteger(input.recipientUserId) || input.recipientUserId < 1) {
    throw new UserTransferContractError();
  }
  const symbol = requiredSymbol(input.symbol);
  if (!isPositiveDecimalText(input.amount)) {
    throw new UserTransferContractError();
  }
  const amount = requiredDecimal(input.amount);
  const rawRemark = input.remark == null ? '' : String(input.remark).trim();
  if (rawRemark.length > 255) throw new UserTransferContractError();
  return {
    requestId,
    recipientEmail: normalizeRecipientEmail(input.recipientEmail),
    recipientUserId: input.recipientUserId,
    symbol,
    amount,
    remark: rawRemark || null,
  };
}

function normalizeRecipientEmail(value: unknown) {
  const email = String(value || '').trim().toLowerCase();
  if (
    email.length < 3 ||
    email.length > 191 ||
    !email.includes('@') ||
    /\s/.test(email)
  ) {
    throw new UserTransferContractError();
  }
  return email;
}

function requiredString(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new UserTransferContractError();
  }
  return value.trim();
}

function nullableString(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  return requiredString(value);
}

function requiredSymbol(value: unknown) {
  const symbol = requiredString(value).toUpperCase();
  if (!/^[A-Z0-9._-]{1,32}$/.test(symbol)) {
    throw new UserTransferContractError();
  }
  return symbol;
}

function requiredDecimal(value: unknown) {
  const normalized = normalizeNonNegativeDecimalText(value);
  if (normalized === null) throw new UserTransferContractError();
  return normalized;
}

function requiredNonNegativeInteger(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new UserTransferContractError();
  }
  return Number(value);
}

function requiredPositiveInteger(value: unknown) {
  const number = requiredNonNegativeInteger(value);
  if (number < 1) throw new UserTransferContractError();
  return number;
}
