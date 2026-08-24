import {apiClient, type ApiRequestOptions} from './client';

const INVITE_SOURCES = new Set(['USER_INVITE', 'BD']);

export type InvitedFriendSource = 'USER_INVITE' | 'BD';

export type InvitedFriend = {
  userId: number;
  email: string | null;
  sourceType: InvitedFriendSource;
  inviteCode: string | null;
  registeredAt: string | null;
  boundAt: string | null;
};

export type InvitedFriendsResponse = {items: InvitedFriend[]};

export function filterInvitedFriendsBySource(
  items: readonly InvitedFriend[],
  sourceType: InvitedFriendSource,
) {
  return items.filter(item => item.sourceType === sourceType);
}

export class InviteFriendsContractError extends Error {
  constructor() {
    super('邀请好友数据格式异常，请稍后重试');
    this.name = 'InviteFriendsContractError';
  }
}

export async function fetchInvitedFriends(
  options?: ApiRequestOptions,
): Promise<InvitedFriendsResponse> {
  const payload = await apiClient.get<unknown>(
    '/user/invited-friends',
    options,
  );
  return normalizeInvitedFriends(payload);
}

export function normalizeInvitedFriends(
  payload: unknown,
): InvitedFriendsResponse {
  const data = requiredRecord(payload);
  if (!Array.isArray(data.items) || data.items.length > 10) {
    throw new InviteFriendsContractError();
  }

  const seen = new Set<string>();
  const items = data.items.map(item => {
    const normalized = normalizeInvitedFriend(item);
    const key = `${normalized.sourceType}:${normalized.userId}`;
    if (seen.has(key)) throw new InviteFriendsContractError();
    seen.add(key);
    return normalized;
  });
  return {items};
}

function normalizeInvitedFriend(payload: unknown): InvitedFriend {
  const data = requiredRecord(payload);
  const sourceType = requiredString(data.source_type).toUpperCase();
  if (!INVITE_SOURCES.has(sourceType)) {
    throw new InviteFriendsContractError();
  }
  return {
    userId: requiredPositiveInteger(data.user_id),
    email: nullableEmail(data.email),
    sourceType: sourceType as InvitedFriendSource,
    inviteCode: nullableLimitedString(data.invite_code, 64),
    registeredAt: nullableTimestamp(data.registered_at),
    boundAt: nullableTimestamp(data.bound_at),
  };
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InviteFriendsContractError();
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new InviteFriendsContractError();
  }
  return value.trim();
}

function requiredPositiveInteger(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new InviteFriendsContractError();
  }
  return Number(value);
}

function nullableLimitedString(value: unknown, maxLength: number) {
  if (value === null || value === undefined) return null;
  const text = requiredString(value);
  if (text.length > maxLength) throw new InviteFriendsContractError();
  return text;
}

function nullableEmail(value: unknown) {
  if (value === null || value === undefined) return null;
  const email = requiredString(value);
  if (
    email.length > 254 ||
    /\s/.test(email) ||
    email.indexOf('@') < 1 ||
    email.lastIndexOf('@') !== email.indexOf('@') ||
    email.endsWith('@')
  ) {
    throw new InviteFriendsContractError();
  }
  return email;
}

function nullableTimestamp(value: unknown) {
  if (value === null || value === undefined) return null;
  const text = requiredString(value);
  const normalized = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)
    ? text
    : `${text}Z`;
  if (Number.isNaN(new Date(normalized).getTime())) {
    throw new InviteFriendsContractError();
  }
  return text;
}
