import {ApiClientError, apiClient} from './client';

export type SupportTicketStatus =
  | 'OPEN'
  | 'IN_PROGRESS'
  | 'REPLIED'
  | 'CLOSED';

export type SupportTicketCategory =
  | 'ACCOUNT'
  | 'KYC'
  | 'DEPOSIT_WITHDRAW'
  | 'TRADING'
  | 'SECURITY'
  | 'OTHER';

export type SupportTicketOption<T extends string = string> = {
  value: T;
  label: string;
};

export type SupportTicketMessage = {
  id: number;
  senderType: 'USER' | 'ADMIN';
  message: string;
  createdAt: string | null;
};

export type SupportTicket = {
  id: number;
  ticketNo: string;
  category: SupportTicketCategory;
  categoryLabel: string;
  subject: string;
  content: string;
  status: SupportTicketStatus;
  statusLabel: string;
  createdAt: string | null;
  updatedAt: string | null;
  hasUnreadAdminReply: boolean;
  messages: SupportTicketMessage[];
};

export type SupportTicketList = {
  items: SupportTicket[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  categories: SupportTicketOption<SupportTicketCategory>[];
  statuses: SupportTicketOption<SupportTicketStatus>[];
  unreadReplyCount: number;
};

export type CreateSupportTicketIn = {
  category: SupportTicketCategory;
  subject: string;
  content: string;
};

const CATEGORY_VALUES = new Set<SupportTicketCategory>([
  'ACCOUNT',
  'KYC',
  'DEPOSIT_WITHDRAW',
  'TRADING',
  'SECURITY',
  'OTHER',
]);
const STATUS_VALUES = new Set<SupportTicketStatus>([
  'OPEN',
  'IN_PROGRESS',
  'REPLIED',
  'CLOSED',
]);

export async function fetchSupportTickets(
  options: {page?: number; pageSize?: number; signal?: AbortSignal} = {},
): Promise<SupportTicketList> {
  const page = boundedPage(options.page, 1, Number.MAX_SAFE_INTEGER, 1);
  const pageSize = boundedPage(options.pageSize, 1, 50, 20);
  const payload = await apiClient.get<unknown>(
    `/user/support-tickets?page=${page}&page_size=${pageSize}`,
    {signal: options.signal},
  );
  const root = requireRecord(payload, '客服工单');
  if (!Array.isArray(root.items)) invalid('客服工单列表');
  const responsePage = requirePositiveInteger(root.page, '客服工单页码');
  const responsePageSize = requirePositiveInteger(
    root.page_size,
    '客服工单分页大小',
  );
  if (responsePage !== page || responsePageSize !== pageSize) {
    invalid('客服工单分页');
  }
  return {
    items: root.items.map((item, index) =>
      normalizeSupportTicket(item, `客服工单 ${index + 1}`),
    ),
    total: requireNonNegativeInteger(root.total, '客服工单总数'),
    page: responsePage,
    pageSize: responsePageSize,
    pages: requirePositiveInteger(root.pages, '客服工单总页数'),
    categories: normalizeOptions(
      root.categories,
      CATEGORY_VALUES,
      '客服工单分类',
    ),
    statuses: normalizeOptions(root.statuses, STATUS_VALUES, '客服工单状态'),
    unreadReplyCount: requireNonNegativeInteger(
      root.unread_reply_count,
      '客服未读回复数',
    ),
  };
}

function boundedPage(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number,
) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, value));
}

export async function fetchSupportTicketDetail(
  ticketId: number,
  options: {signal?: AbortSignal} = {},
): Promise<SupportTicket> {
  requireTicketId(ticketId);
  const payload = await apiClient.get<unknown>(
    `/user/support-tickets/${ticketId}`,
    {signal: options.signal},
  );
  return normalizeSupportTicket(payload, '客服工单详情', true);
}

export async function markSupportTicketRead(
  ticketId: number,
  lastSeenMessageId: number,
  options: {signal?: AbortSignal} = {},
) {
  requireTicketId(ticketId);
  if (!Number.isSafeInteger(lastSeenMessageId) || lastSeenMessageId <= 0) {
    throw new ApiClientError(
      '客服消息游标无效',
      'INVALID_SUPPORT_MESSAGE_CURSOR',
    );
  }
  const response = requireRecord(
    await apiClient.post<unknown>(
      `/user/support-tickets/${ticketId}/read`,
      {last_seen_message_id: lastSeenMessageId},
      {retry: 'none', signal: options.signal},
    ),
    '客服已读状态',
  );
  if (response.ok !== true) invalid('客服已读状态');
  const serverCursor = requirePositiveInteger(
    response.last_read_message_id,
    '客服已读游标',
  );
  if (serverCursor < lastSeenMessageId) invalid('客服已读游标');
  return {
    lastReadMessageId: serverCursor,
    unreadReplyCount: requireNonNegativeInteger(
      response.unread_reply_count,
      '客服未读回复数',
    ),
  };
}

export async function createSupportTicket(
  payload: CreateSupportTicketIn,
): Promise<SupportTicket> {
  const response = await apiClient.post<unknown>(
    '/user/support-tickets',
    {
      category: requireCategory(payload.category),
      subject: requireSubmissionText(payload.subject, 255, '工单标题'),
      content: requireSubmissionText(payload.content, 5000, '问题描述'),
    },
    {retry: 'none'},
  );
  return normalizeSupportTicket(response, '新建客服工单', true);
}

export async function addSupportTicketMessage(
  ticketId: number,
  message: string,
): Promise<SupportTicket> {
  requireTicketId(ticketId);
  const response = await apiClient.post<unknown>(
    `/user/support-tickets/${ticketId}/messages`,
    {message: requireSubmissionText(message, 5000, '补充说明')},
    {retry: 'none'},
  );
  return normalizeSupportTicket(response, '客服工单回复', true);
}

export async function closeSupportTicket(
  ticketId: number,
): Promise<SupportTicket> {
  requireTicketId(ticketId);
  const response = await apiClient.post<unknown>(
    `/user/support-tickets/${ticketId}/close`,
    {},
    {retry: 'none'},
  );
  const ticket = normalizeSupportTicket(response, '关闭客服工单', true);
  if (ticket.status !== 'CLOSED') invalid('关闭客服工单状态');
  return ticket;
}

export function normalizeSupportTicket(
  payload: unknown,
  label = '客服工单',
  requireMessages = false,
): SupportTicket {
  const ticket = requireRecord(payload, label);
  const id = requirePositiveInteger(ticket.id, `${label}编号`);
  const category = requiredString(ticket.category, `${label}分类`).toUpperCase();
  const status = requiredString(ticket.status, `${label}状态`).toUpperCase();
  if (!CATEGORY_VALUES.has(category as SupportTicketCategory)) {
    invalid(`${label}分类`);
  }
  if (!STATUS_VALUES.has(status as SupportTicketStatus)) {
    invalid(`${label}状态`);
  }
  if (requireMessages && !Array.isArray(ticket.messages)) {
    invalid(`${label}消息`);
  }
  return {
    id,
    ticketNo: requiredString(ticket.ticket_no, `${label}单号`),
    category: category as SupportTicketCategory,
    categoryLabel: requiredString(ticket.category_label, `${label}分类`),
    subject: requiredString(ticket.subject, `${label}标题`),
    content: requiredString(ticket.content, `${label}内容`),
    status: status as SupportTicketStatus,
    statusLabel: requiredString(ticket.status_label, `${label}状态`),
    createdAt: optionalDate(ticket.created_at),
    updatedAt: optionalDate(ticket.updated_at),
    hasUnreadAdminReply: requireBoolean(
      ticket.has_unread_admin_reply,
      `${label}未读状态`,
    ),
    messages: Array.isArray(ticket.messages)
      ? ticket.messages.map((item, index) => normalizeMessage(item, index))
      : [],
  };
}

function requireBoolean(value: unknown, label: string) {
  if (typeof value !== 'boolean') invalid(label);
  return value;
}

function normalizeMessage(payload: unknown, index: number): SupportTicketMessage {
  const message = requireRecord(payload, `客服消息 ${index + 1}`);
  const sender = requiredString(
    message.sender_type,
    '客服消息发送方',
  ).toUpperCase();
  if (sender !== 'USER' && sender !== 'ADMIN') invalid('客服消息发送方');
  return {
    id: requirePositiveInteger(message.id, '客服消息编号'),
    senderType: sender,
    message: requiredString(message.message, '客服消息内容'),
    createdAt: optionalDate(message.created_at),
  };
}

function normalizeOptions<T extends string>(
  payload: unknown,
  allowed: Set<T>,
  label: string,
): SupportTicketOption<T>[] {
  if (!Array.isArray(payload) || payload.length === 0) invalid(label);
  const seen = new Set<T>();
  return payload.map((value, index) => {
    const option = requireRecord(value, `${label} ${index + 1}`);
    const normalizedValue = requiredString(
      option.value,
      `${label}值`,
    ).toUpperCase() as T;
    if (!allowed.has(normalizedValue) || seen.has(normalizedValue)) invalid(label);
    seen.add(normalizedValue);
    return {
      value: normalizedValue,
      label: requiredString(option.label, `${label}名称`),
    };
  });
}

function requireCategory(value: string) {
  const normalized = value.trim().toUpperCase() as SupportTicketCategory;
  if (!CATEGORY_VALUES.has(normalized)) {
    throw new ApiClientError('请选择有效的问题分类', 'INVALID_SUPPORT_CATEGORY');
  }
  return normalized;
}

function requireTicketId(value: number) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ApiClientError('客服工单编号无效', 'INVALID_SUPPORT_TICKET_ID');
  }
  return value;
}

function requireSubmissionText(value: string, maxLength: number, label: string) {
  const text = value.trim();
  if (!text) {
    throw new ApiClientError(`${label}不能为空`, 'REQUIRED_FIELD');
  }
  if (text.length > maxLength) {
    throw new ApiClientError(`${label}内容过长`, 'FIELD_TOO_LONG');
  }
  return text;
}

function requirePositiveInteger(value: unknown, label: string) {
  const result = readInteger(value);
  if (result === null || result <= 0) invalid(label);
  return result;
}

function requireNonNegativeInteger(value: unknown, label: string) {
  const result = readInteger(value);
  if (result === null || result < 0) invalid(label);
  return result;
}

function readInteger(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function requiredString(value: unknown, label: string) {
  if (typeof value !== 'string' || !value.trim()) invalid(label);
  return value.trim();
}

function optionalDate(value: unknown) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    invalid('客服时间');
  }
  return value;
}

function requireRecord(value: unknown, label: string) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(label);
  }
  return value as Record<string, unknown>;
}

function invalid(label: string): never {
  throw new ApiClientError(
    `${label}响应格式无效，请稍后重试`,
    'INVALID_SUPPORT_RESPONSE',
  );
}
