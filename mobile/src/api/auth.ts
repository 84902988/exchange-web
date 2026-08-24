import {
  ApiClientError,
  apiClient,
  getApiRefreshToken,
  publicApiClient,
} from './client';

export type TokenOut = {
  access_token: string;
  refresh_token: string;
  token_type?: string;
  access_expires_in?: number;
};

export type LoginIn = {
  account: string;
  password: string;
  captcha_id?: string;
  captcha_code?: string;
  remember_me?: boolean;
};

export type RegisterIn = {
  email?: string;
  phone?: string;
  otp: string;
  password: string;
  invite_code?: string;
  invite_type?: 'bd' | 'user' | string;
};

export type LogoutIn = {
  refresh_token?: string;
};

export type OtpScene = 'register' | 'login' | 'reset';

export type SendOtpIn = {
  email: string;
  scene: OtpScene;
};

export type ResetPasswordIn = {
  email: string;
  otp: string;
  new_password: string;
  confirm_password: string;
};

export type AuthMessageOut = {
  message: string;
};

export type LoginCaptchaChallenge = {
  captchaId: string;
  svgXml: string;
  expiresIn: number;
};

export type LoginFailureState = {
  code: string;
  needCaptcha: true;
  locked: boolean;
  lockSeconds: number | null;
  remainingAttempts: number | null;
};

export type UserProfile = {
  username?: string | null;
  nickname?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
};

export type UserSettings = {
  language?: string | null;
  timezone?: string | null;
  theme?: string | null;
};

export type MeOut = {
  id: number | string;
  email?: string | null;
  phone?: string | null;
  invite_code?: string | null;
  avatar_url?: string | null;
  profile?: UserProfile | null;
  status?: number;
  username?: string | null;
  nickname?: string | null;
  kyc_level?: number;
  kyc_status?: string | null;
  email_verified_at?: string | null;
  phone_verified_at?: string | null;
  last_login_at?: string | null;
  updated_at?: string | null;
  created_at?: string | null;
  settings?: UserSettings | null;
};

export type ProfileUpdateIn = {
  username?: string;
  nickname?: string;
};

export type PasswordChangeIn = {
  old_password: string;
  new_password: string;
};

export type PasswordChangeOut = {
  password_changed_at: string;
};

export type EmailVerificationOut = {
  email: string;
  email_verified_at: string;
};

export type EmailChangeOut = EmailVerificationOut & {
  reauthenticate: true;
};

export type AvatarImageFile = {
  uri: string;
  name: string;
  type: 'image/jpeg' | 'image/png' | 'image/webp';
};

export type LoginLogItem = {
  id: number;
  userId: number | null;
  email: string | null;
  ipAddress: string;
  userAgent: string;
  deviceName: string;
  countryCode: string;
  status: 'SUCCESS' | 'FAILED';
  failureReason: string | null;
  createdAt: string;
};

export type ActiveSessionItem = {
  id: number;
  ipAddress: string;
  userAgent: string;
  deviceName: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
  isCurrent: boolean;
};

export type ActiveSessionList = {
  items: ActiveSessionItem[];
  currentSessionId: number;
  total: number;
};

export type SecurityEventType =
  | 'EMAIL_VERIFIED'
  | 'EMAIL_CHANGED'
  | 'PASSWORD_CHANGED'
  | 'PASSWORD_RESET'
  | 'SESSION_REVOKED'
  | 'SESSIONS_REVOKED';

export type SecurityEventItem = {
  id: number;
  eventType: SecurityEventType;
  ipAddress: string;
  userAgent: string;
  details: Record<string, string | number>;
  createdAt: string;
};

export type SecurityEventPage = {
  items: SecurityEventItem[];
  hasMore: boolean;
  nextCursor: number | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readRequiredText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function readOptionalText(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function readBoundedInteger(value: unknown, maximum: number) {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= maximum
    ? value
    : null;
}

function decodeAsciiBase64(value: string) {
  if (
    !value ||
    value.length > 24000 ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(value)
  ) {
    return '';
  }

  const alphabet =
    'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let output = '';
  for (let offset = 0; offset < value.length; offset += 4) {
    const first = alphabet.indexOf(value[offset]);
    const second = alphabet.indexOf(value[offset + 1]);
    const third = value[offset + 2] === '=' ? 64 : alphabet.indexOf(value[offset + 2]);
    const fourth = value[offset + 3] === '=' ? 64 : alphabet.indexOf(value[offset + 3]);
    if (
      first < 0 ||
      second < 0 ||
      third < 0 ||
      fourth < 0 ||
      (third === 64 && fourth !== 64) ||
      (offset < value.length - 4 && (third === 64 || fourth === 64))
    ) {
      return '';
    }

    const bits =
      first * 262144 +
      second * 4096 +
      (third % 64) * 64 +
      (fourth % 64);
    const bytes = [Math.floor(bits / 65536) % 256];
    if (third !== 64) bytes.push(Math.floor(bits / 256) % 256);
    if (fourth !== 64) bytes.push(bits % 256);
    if (bytes.some(byte => byte < 1 || byte > 127)) return '';
    output += String.fromCharCode(...bytes);
  }
  return output;
}

function requireCaptchaSvg(value: unknown) {
  const image = readRequiredText(value);
  const prefix = 'data:image/svg+xml;base64,';
  if (!image.startsWith(prefix)) return '';

  const xml = decodeAsciiBase64(image.slice(prefix.length));
  if (
    !xml.startsWith(
      '<svg xmlns="http://www.w3.org/2000/svg" width="132" height="44" viewBox="0 0 132 44">',
    ) ||
    !xml.endsWith('</svg>') ||
    /<!|<script|<foreignObject|\s(?:href|xlink:href|on[a-z]+)\s*=|url\s*\(/i.test(xml)
  ) {
    return '';
  }

  const tags = Array.from(xml.matchAll(/<\/?([A-Za-z][\w:-]*)/g), match =>
    match[1].toLowerCase(),
  );
  return tags.length > 0 &&
    tags.every(tag => ['svg', 'rect', 'line', 'text'].includes(tag))
    ? xml
    : '';
}

function requireTokenPair(payload: unknown, operation: '登录' | '注册'): TokenOut {
  const root = isRecord(payload) ? payload : {};
  const accessToken = readRequiredText(root.access_token);
  const refreshToken = readRequiredText(root.refresh_token);
  if (!accessToken || !refreshToken) {
    throw new ApiClientError(
      `${operation}响应缺少完整令牌，未建立登录态`,
      operation === '登录'
        ? 'INVALID_LOGIN_RESPONSE'
        : 'INVALID_REGISTER_RESPONSE',
    );
  }

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: readRequiredText(root.token_type) || undefined,
    access_expires_in:
      typeof root.access_expires_in === 'number' &&
      Number.isFinite(root.access_expires_in) &&
      root.access_expires_in > 0
        ? root.access_expires_in
        : undefined,
  };
}

function isPositiveUserId(value: unknown) {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value > 0;
  }
  return (
    typeof value === 'string' &&
    /^[1-9]\d*$/.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}

export function requireAuthenticatedUser(payload: unknown): MeOut {
  if (!isRecord(payload)) {
    throw new ApiClientError(
      '用户身份响应格式无效，未建立登录态',
      'INVALID_ME_RESPONSE',
    );
  }

  const email = readRequiredText(payload.email);
  const phone = readRequiredText(payload.phone);
  if (!isPositiveUserId(payload.id) || (!email && !phone) || payload.status !== 1) {
    throw new ApiClientError(
      '用户身份响应缺少有效账号信息，未建立登录态',
      'INVALID_ME_RESPONSE',
    );
  }

  return payload as MeOut;
}

export function readLoginFailureState(error: unknown): LoginFailureState | null {
  if (!(error instanceof ApiClientError)) return null;
  const data = isRecord(error.data) ? error.data : {};
  const code = error.code.trim().toUpperCase();
  const challengeCode =
    code === 'CAPTCHA_REQUIRED' ||
    code === 'CAPTCHA_INVALID' ||
    code === 'LOGIN_LOCKED';
  if (data.need_captcha !== true && !challengeCode) return null;

  const locked = data.locked === true || code === 'LOGIN_LOCKED';
  const lockSeconds = readBoundedInteger(data.lock_seconds, 24 * 60 * 60);
  const remainingAttempts = readBoundedInteger(data.remaining_attempts, 100);
  return {
    code,
    needCaptcha: true,
    locked,
    lockSeconds: locked && lockSeconds === 0 ? null : lockSeconds,
    remainingAttempts,
  };
}

function requireMessage(
  payload: unknown,
  expectedMessage: string,
  errorCode: string,
  errorMessage: string,
): AuthMessageOut {
  const root = isRecord(payload) ? payload : {};
  const message = readRequiredText(root.message);
  if (message !== expectedMessage) {
    throw new ApiClientError(errorMessage, errorCode);
  }
  return {message};
}

export async function login(data: LoginIn) {
  const payload = await publicApiClient.post<unknown>('/auth/login', data);
  return requireTokenPair(payload, '登录');
}

export async function fetchLoginCaptcha(): Promise<LoginCaptchaChallenge> {
  const payload = await publicApiClient.get<unknown>('/auth/captcha');
  const root = isRecord(payload) ? payload : {};
  const captchaId = readRequiredText(root.captcha_id);
  const svgXml = requireCaptchaSvg(root.image);
  const expiresIn = readBoundedInteger(root.expires_in, 60 * 60);
  if (
    !/^[A-Za-z0-9_-]{20,128}$/.test(captchaId) ||
    !svgXml ||
    expiresIn === null ||
    expiresIn <= 0
  ) {
    throw new ApiClientError(
      '图形验证码响应格式无效，请刷新后重试',
      'INVALID_LOGIN_CAPTCHA_RESPONSE',
    );
  }
  return {captchaId, svgXml, expiresIn};
}

export async function register(data: RegisterIn) {
  const payload = await publicApiClient.post<unknown>('/auth/register', data);
  return requireTokenPair(payload, '注册');
}

export async function sendOtp(data: SendOtpIn) {
  const payload = await publicApiClient.post<unknown>('/auth/otp/send', data);
  return requireMessage(
    payload,
    'otp sent',
    'INVALID_OTP_SEND_RESPONSE',
    '验证码发送响应无法确认，请稍后重试',
  );
}

export async function resetPassword(data: ResetPasswordIn) {
  const payload = await publicApiClient.post<unknown>(
    '/auth/reset-password',
    data,
  );
  return requireMessage(
    payload,
    '密码重置成功，请使用新密码登录',
    'INVALID_RESET_PASSWORD_RESPONSE',
    '密码重置响应无法确认，请勿重复提交，请稍后重试',
  );
}

export function logout(data: LogoutIn = {}) {
  return publicApiClient.post<{message?: string}>('/auth/logout', data);
}

export async function getMe() {
  const payload = await apiClient.get<unknown>('/me');
  return requireAuthenticatedUser(payload);
}

export async function updateMyProfile(data: ProfileUpdateIn) {
  const payload = await apiClient.patch<unknown>('/me', data, {retry: 'none'});
  return requireAuthenticatedUser(payload);
}

export async function uploadMyAvatar(file: AvatarImageFile) {
  const formData = new FormData();
  formData.append(
    'file',
    {
      uri: file.uri,
      name: file.name,
      type: file.type,
    } as unknown as Blob,
  );
  const payload = await apiClient.post<unknown>('/me/avatar', formData, {
    retry: 'none',
    timeoutMs: 30_000,
  });
  return requireAuthenticatedUser(payload);
}

async function submitPasswordChange(data: PasswordChangeIn) {
  return apiClient.patch<unknown>('/me/password', data, {
    retry: 'none',
  });
}

export async function changeMyPassword(data: PasswordChangeIn) {
  let payload: unknown;
  try {
    payload = await submitPasswordChange(data);
  } catch (error) {
    if (
      !(error instanceof ApiClientError) ||
      error.code !== 'AUTH_REFRESHED_RETRY_REQUIRED'
    ) {
      throw error;
    }
    payload = await submitPasswordChange(data);
  }
  const root = isRecord(payload) ? payload : {};
  const changedAt = readRequiredText(root.password_changed_at);
  if (!changedAt || Number.isNaN(Date.parse(changedAt))) {
    throw new ApiClientError(
      '密码修改响应无法确认，请勿重复提交，请重新登录后检查',
      'INVALID_PASSWORD_CHANGE_RESPONSE',
    );
  }
  return {password_changed_at: changedAt} satisfies PasswordChangeOut;
}

function requireEmailVerificationResult(
  payload: unknown,
  requireReauthentication: boolean,
): EmailVerificationOut | EmailChangeOut {
  const root = isRecord(payload) ? payload : {};
  const email = readRequiredText(root.email).toLowerCase();
  const verifiedAt = readRequiredText(root.email_verified_at);
  if (
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
    !verifiedAt ||
    Number.isNaN(Date.parse(verifiedAt)) ||
    (requireReauthentication && root.reauthenticate !== true)
  ) {
    throw new ApiClientError(
      '邮箱安全操作响应无法确认，请勿重复提交，请重新登录后检查',
      'INVALID_EMAIL_SECURITY_RESPONSE',
    );
  }
  if (requireReauthentication) {
    return {
      email,
      email_verified_at: verifiedAt,
      reauthenticate: true,
    };
  }
  return {email, email_verified_at: verifiedAt};
}

export async function sendCurrentEmailVerification() {
  const payload = await apiClient.post<unknown>(
    '/me/email/verification/send',
    {},
    {retry: 'none'},
  );
  const root = isRecord(payload) ? payload : {};
  const message = readRequiredText(root.message);
  const email = readRequiredText(root.email);
  if (message !== 'verification code sent' || !email) {
    throw new ApiClientError(
      '邮箱验证码发送响应无法确认，请稍后重试',
      'INVALID_EMAIL_VERIFICATION_SEND_RESPONSE',
    );
  }
  return {message, email};
}

export async function confirmCurrentEmailVerification(code: string) {
  const payload = await apiClient.post<unknown>(
    '/me/email/verification/confirm',
    {code: code.trim()},
    {retry: 'none'},
  );
  return requireEmailVerificationResult(payload, false) as EmailVerificationOut;
}

export async function sendEmailChangeVerification(data: {
  new_email: string;
  current_password: string;
}) {
  const payload = await apiClient.post<unknown>(
    '/me/email/change/send',
    {
      new_email: data.new_email.trim().toLowerCase(),
      current_password: data.current_password,
    },
    {retry: 'none'},
  );
  const root = isRecord(payload) ? payload : {};
  const message = readRequiredText(root.message);
  const email = readRequiredText(root.email);
  if (message !== 'verification code sent' || !email) {
    throw new ApiClientError(
      '新邮箱验证码发送响应无法确认，请稍后重试',
      'INVALID_EMAIL_CHANGE_SEND_RESPONSE',
    );
  }
  return {message, email};
}

export async function confirmEmailChange(data: {
  new_email: string;
  current_password: string;
  code: string;
}) {
  const payload = await apiClient.post<unknown>(
    '/me/email/change/confirm',
    {
      new_email: data.new_email.trim().toLowerCase(),
      current_password: data.current_password,
      code: data.code.trim(),
    },
    {retry: 'none'},
  );
  return requireEmailVerificationResult(payload, true) as EmailChangeOut;
}

function normalizeLoginLog(value: unknown): LoginLogItem {
  const item = isRecord(value) ? value : {};
  const id = readBoundedInteger(item.id, Number.MAX_SAFE_INTEGER);
  const rawUserId = item.user_id;
  const hasUserId = rawUserId !== null && rawUserId !== undefined;
  const userId =
    !hasUserId
      ? null
      : readBoundedInteger(rawUserId, Number.MAX_SAFE_INTEGER);
  const ipAddress = readRequiredText(item.ip_address);
  const userAgent = readOptionalText(item.user_agent) || '未知客户端';
  const deviceName = readOptionalText(item.device_name) || '未知设备';
  const countryCode = readOptionalText(item.country_code) || 'UNKNOWN';
  const status = readRequiredText(item.login_status).toUpperCase();
  const createdAt = readRequiredText(item.created_at);
  if (
    id === null ||
    id <= 0 ||
    (hasUserId && (userId === null || userId <= 0)) ||
    !ipAddress ||
    !['SUCCESS', 'FAILED'].includes(status) ||
    !createdAt ||
    Number.isNaN(Date.parse(createdAt))
  ) {
    throw new ApiClientError(
      '登录记录响应格式无效，请稍后重试',
      'INVALID_LOGIN_LOG_RESPONSE',
    );
  }
  return {
    id,
    userId,
    email: readOptionalText(item.email),
    ipAddress,
    userAgent,
    deviceName,
    countryCode,
    status: status as LoginLogItem['status'],
    failureReason: readOptionalText(item.failure_reason),
    createdAt,
  };
}

export async function fetchMyLoginLogs(
  limit = 30,
  signal?: AbortSignal,
): Promise<LoginLogItem[]> {
  const boundedLimit = Math.min(100, Math.max(1, Math.trunc(limit)));
  const payload = await apiClient.get<unknown>(
    `/me/login-logs?limit=${boundedLimit}`,
    {signal},
  );
  const root = isRecord(payload) ? payload : {};
  if (!Array.isArray(root.items)) {
    throw new ApiClientError(
      '登录记录响应格式无效，请稍后重试',
      'INVALID_LOGIN_LOG_RESPONSE',
    );
  }
  return root.items.map(normalizeLoginLog);
}

const SECURITY_EVENT_TYPES = new Set<SecurityEventType>([
  'EMAIL_VERIFIED',
  'EMAIL_CHANGED',
  'PASSWORD_CHANGED',
  'PASSWORD_RESET',
  'SESSION_REVOKED',
  'SESSIONS_REVOKED',
]);

function normalizeSecurityEventDetails(
  eventType: SecurityEventType,
  value: unknown,
): Record<string, string | number> {
  const raw = isRecord(value) ? value : {};
  const details: Record<string, string | number> = {};
  const addText = (key: string) => {
    const text = readOptionalText(raw[key]);
    if (text && text.length <= 191) details[key] = text;
  };
  const addCount = (key: string) => {
    const count = readBoundedInteger(raw[key], 10_000);
    if (count !== null) details[key] = count;
  };
  if (eventType === 'EMAIL_VERIFIED') {
    addText('email');
    if (raw.source === 'registration') details.source = 'registration';
  } else if (eventType === 'EMAIL_CHANGED') {
    addText('old_email');
    addText('new_email');
  } else if (
    eventType === 'PASSWORD_CHANGED' ||
    eventType === 'PASSWORD_RESET'
  ) {
    addCount('revoked_sessions');
  } else if (eventType === 'SESSION_REVOKED') {
    addText('target_device');
  } else if (eventType === 'SESSIONS_REVOKED') {
    addCount('revoked_count');
  }
  return details;
}

function normalizeSecurityEvent(value: unknown): SecurityEventItem {
  const item = isRecord(value) ? value : {};
  const id = readBoundedInteger(item.id, Number.MAX_SAFE_INTEGER);
  const eventType = readRequiredText(item.event_type) as SecurityEventType;
  const ipAddress = readRequiredText(item.ip_address);
  const userAgent = readOptionalText(item.user_agent) || '';
  const createdAt = readRequiredText(item.created_at);
  if (
    id === null ||
    id <= 0 ||
    !SECURITY_EVENT_TYPES.has(eventType) ||
    !ipAddress ||
    !createdAt ||
    Number.isNaN(Date.parse(createdAt)) ||
    !isRecord(item.details)
  ) {
    throw new ApiClientError(
      '安全事件响应格式无效，请稍后重试',
      'INVALID_SECURITY_EVENT_RESPONSE',
    );
  }
  return {
    id,
    eventType,
    ipAddress,
    userAgent,
    details: normalizeSecurityEventDetails(eventType, item.details),
    createdAt,
  };
}

export async function fetchMySecurityEvents(
  limit = 20,
  beforeId?: number | null,
  signal?: AbortSignal,
): Promise<SecurityEventPage> {
  const boundedLimit = Math.min(50, Math.max(1, Math.trunc(limit)));
  const cursor =
    beforeId === null || beforeId === undefined
      ? null
      : readBoundedInteger(beforeId, Number.MAX_SAFE_INTEGER);
  if (beforeId !== null && beforeId !== undefined && (!cursor || cursor <= 0)) {
    throw new ApiClientError(
      '安全事件分页参数无效',
      'INVALID_SECURITY_EVENT_CURSOR',
    );
  }
  const query = cursor ? `&before_id=${cursor}` : '';
  const payload = await apiClient.get<unknown>(
    `/me/security-events?limit=${boundedLimit}${query}`,
    {signal},
  );
  const root = isRecord(payload) ? payload : {};
  if (!Array.isArray(root.items) || typeof root.has_more !== 'boolean') {
    throw new ApiClientError(
      '安全事件响应格式无效，请稍后重试',
      'INVALID_SECURITY_EVENT_RESPONSE',
    );
  }
  const items = root.items.map(normalizeSecurityEvent);
  const nextCursor =
    root.next_cursor === null
      ? null
      : readBoundedInteger(root.next_cursor, Number.MAX_SAFE_INTEGER);
  if (
    (root.has_more && (nextCursor === null || nextCursor <= 0 || items.length === 0)) ||
    (!root.has_more && nextCursor !== null) ||
    (nextCursor !== null && items[items.length - 1]?.id !== nextCursor)
  ) {
    throw new ApiClientError(
      '安全事件分页响应无效，请稍后重试',
      'INVALID_SECURITY_EVENT_RESPONSE',
    );
  }
  return {items, hasMore: root.has_more, nextCursor};
}

function requireCurrentRefreshToken() {
  const refreshToken = getApiRefreshToken()?.trim() || '';
  if (!refreshToken) {
    throw new ApiClientError(
      '当前设备缺少可验证的登录会话，请重新登录后重试',
      'CURRENT_SESSION_REQUIRED',
    );
  }
  return refreshToken;
}

function normalizeActiveSession(value: unknown): ActiveSessionItem {
  const item = isRecord(value) ? value : {};
  const id = readBoundedInteger(item.id, Number.MAX_SAFE_INTEGER);
  const ipAddress = readRequiredText(item.ip_address);
  const userAgent = readOptionalText(item.user_agent) || '';
  const rawDeviceName = readOptionalText(item.device_name) || '';
  const deviceName = normalizeSessionDeviceName(rawDeviceName, userAgent);
  const createdAt = readRequiredText(item.created_at);
  const lastUsedAt = readOptionalText(item.last_used_at);
  const expiresAt = readRequiredText(item.expires_at);
  if (
    id === null ||
    id <= 0 ||
    !ipAddress ||
    !createdAt ||
    Number.isNaN(Date.parse(createdAt)) ||
    (lastUsedAt !== null && Number.isNaN(Date.parse(lastUsedAt))) ||
    !expiresAt ||
    Number.isNaN(Date.parse(expiresAt)) ||
    typeof item.is_current !== 'boolean'
  ) {
    throw new ApiClientError(
      '活跃设备响应格式无效，请稍后重试',
      'INVALID_SESSION_LIST_RESPONSE',
    );
  }
  return {
    id,
    ipAddress,
    userAgent,
    deviceName,
    createdAt,
    lastUsedAt,
    expiresAt,
    isCurrent: item.is_current,
  };
}

export function normalizeSessionDeviceName(deviceName: string, userAgent: string) {
  const normalized = deviceName.trim();
  const hasUnknownBrowser = /^unknown browser\s*\//i.test(normalized);
  const isUnknown =
    !normalized ||
    hasUnknownBrowser ||
    /^unknown device$/i.test(normalized);
  if (/okhttp|exchangemobile.*android/i.test(userAgent) && isUnknown) {
    return 'ExchangeMobile / Android';
  }
  if (/cfnetwork|iphone|ipad|exchangemobile.*ios/i.test(userAgent) && isUnknown) {
    return 'ExchangeMobile / iOS';
  }
  if (!isUnknown) return normalized;
  return '未知设备';
}

export async function fetchMyActiveSessions(
  signal?: AbortSignal,
): Promise<ActiveSessionList> {
  const payload = await apiClient.post<unknown>(
    '/auth/sessions/list',
    {refresh_token: requireCurrentRefreshToken()},
    {retry: 'none', signal},
  );
  const root = isRecord(payload) ? payload : {};
  const currentSessionId = readBoundedInteger(
    root.current_session_id,
    Number.MAX_SAFE_INTEGER,
  );
  const total = readBoundedInteger(root.total, 50);
  if (
    !Array.isArray(root.items) ||
    currentSessionId === null ||
    currentSessionId <= 0 ||
    total === null ||
    total !== root.items.length
  ) {
    throw new ApiClientError(
      '活跃设备响应格式无效，请稍后重试',
      'INVALID_SESSION_LIST_RESPONSE',
    );
  }
  const items = root.items.map(normalizeActiveSession);
  if (
    items.filter(item => item.isCurrent).length !== 1 ||
    !items.some(item => item.id === currentSessionId && item.isCurrent)
  ) {
    throw new ApiClientError(
      '当前设备会话无法确认，请重新登录后重试',
      'INVALID_SESSION_LIST_RESPONSE',
    );
  }
  return {items, currentSessionId, total};
}

export async function revokeMySession(sessionId: number) {
  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
    throw new ApiClientError('会话编号无效', 'INVALID_SESSION_ID');
  }
  const payload = await apiClient.post<unknown>(
    `/auth/sessions/${sessionId}/revoke`,
    {refresh_token: requireCurrentRefreshToken()},
    {retry: 'none'},
  );
  const root = isRecord(payload) ? payload : {};
  const confirmedId = readBoundedInteger(root.session_id, Number.MAX_SAFE_INTEGER);
  if (root.revoked !== true || confirmedId !== sessionId) {
    throw new ApiClientError(
      '退出设备响应无法确认，请刷新列表检查',
      'INVALID_SESSION_REVOKE_RESPONSE',
    );
  }
  return {sessionId: confirmedId, revoked: true as const};
}

export async function revokeMyOtherSessions() {
  const payload = await apiClient.post<unknown>(
    '/auth/sessions/revoke-others',
    {refresh_token: requireCurrentRefreshToken()},
    {retry: 'none'},
  );
  const root = isRecord(payload) ? payload : {};
  const revokedCount = readBoundedInteger(root.revoked_count, 50);
  const currentSessionId = readBoundedInteger(
    root.current_session_id,
    Number.MAX_SAFE_INTEGER,
  );
  if (
    revokedCount === null ||
    currentSessionId === null ||
    currentSessionId <= 0
  ) {
    throw new ApiClientError(
      '退出其他设备响应无法确认，请刷新列表检查',
      'INVALID_SESSION_REVOKE_RESPONSE',
    );
  }
  return {revokedCount, currentSessionId};
}
