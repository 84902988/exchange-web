import {API_BASE_URL, API_TIMEOUT_MS} from '../config/env';

type RequestMethod = 'GET' | 'POST' | 'PATCH';

type ApiEnvelope<T> = {
  ok?: boolean;
  data?: T;
  error?: {
    code?: string;
    message?: string;
    [key: string]: unknown;
  };
  trace_id?: string;
};

export type ApiClientErrorData = Record<string, unknown> | undefined;
export type ApiAuthPolicy = 'auto' | 'omit';
export type ApiRetryPolicy = 'default' | 'none';

export type ApiRequestOptions = {
  auth?: ApiAuthPolicy;
  headers?: Record<string, string>;
  retry?: ApiRetryPolicy;
  signal?: AbortSignal;
  timeoutMs?: number;
};

export type ApiAuthTokenState = {
  accessToken: string | null;
  refreshToken: string | null;
};

export type ApiAccessTokenSnapshot = {
  accessToken: string | null;
  sessionEpoch: number;
};

export type ApiAccessTokenListener = (
  snapshot: ApiAccessTokenSnapshot,
) => void;

export type ApiAuthLifecycleHandlers = {
  onAuthExpired?: (error: ApiClientError) => Promise<void> | void;
  onTokensRefreshed?: (tokens: ApiAuthTokenState) => Promise<void> | void;
};

export class ApiClientError extends Error {
  code: string;
  status?: number;
  data?: ApiClientErrorData;

  constructor(
    message: string,
    code = 'API_ERROR',
    status?: number,
    data?: ApiClientErrorData,
  ) {
    super(message);
    this.name = 'ApiClientError';
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

type RefreshResult =
  | {status: 'success'}
  | {status: 'rejected' | 'unavailable'; error: ApiClientError};

type RequestState = {
  networkRetryCount: number;
  retriedAfterRefresh: boolean;
  sessionEpoch: number;
};

const GET_NETWORK_RETRY_DELAY_MS = 400;
const RETRYABLE_GET_STATUSES = new Set([502, 503, 504]);
const AUTH_REFRESH_PATH = '/auth/refresh';
const AUTH_REFRESH_EXCLUDED_PATHS = new Set([
  '/auth/login',
  '/auth/logout',
  '/auth/refresh',
  '/auth/register',
]);
const PUBLIC_PATH_PREFIXES = ['/market/', '/contract/market/'];

let authTokens: ApiAuthTokenState = {
  accessToken: null,
  refreshToken: null,
};
let authHandlers: ApiAuthLifecycleHandlers = {};
let refreshPromise: Promise<RefreshResult> | null = null;
let authExpiredNotified = false;
let authSessionEpoch = 0;
const accessTokenListeners = new Set<ApiAccessTokenListener>();

export function getApiAccessTokenSnapshot(): ApiAccessTokenSnapshot {
  return {
    accessToken: authTokens.accessToken,
    sessionEpoch: authSessionEpoch,
  };
}

function notifyApiAccessTokenListeners() {
  const snapshot = getApiAccessTokenSnapshot();
  for (const listener of Array.from(accessTokenListeners)) {
    listener(snapshot);
  }
}

export function subscribeApiAccessToken(
  listener: ApiAccessTokenListener,
) {
  accessTokenListeners.add(listener);
  listener(getApiAccessTokenSnapshot());
  return () => {
    accessTokenListeners.delete(listener);
  };
}

export function setApiAuthToken(token: string | null) {
  setApiAuthTokens({
    accessToken: token,
    refreshToken: authTokens.refreshToken,
  });
}

export function setApiAuthTokens(tokens: ApiAuthTokenState | null) {
  authSessionEpoch += 1;
  authTokens = tokens || {accessToken: null, refreshToken: null};
  if (authTokens.accessToken || authTokens.refreshToken) {
    authExpiredNotified = false;
  }
  notifyApiAccessTokenListeners();
}

function setRefreshedApiAuthTokens(tokens: ApiAuthTokenState) {
  authTokens = tokens;
  authExpiredNotified = false;
  notifyApiAccessTokenListeners();
}

export function getApiRefreshToken() {
  return authTokens.refreshToken;
}

export function setApiAuthLifecycleHandlers(
  handlers: ApiAuthLifecycleHandlers,
) {
  authHandlers = handlers;
  return () => {
    if (authHandlers === handlers) {
      authHandlers = {};
    }
  };
}

function joinUrl(baseUrl: string, path: string) {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function getErrorMessage(error: unknown, fallback: string) {
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  return fallback;
}

function mapErrorMessage(message: string, code: string) {
  const safeMessage = message.trim();
  const normalizedCode = code.trim().toUpperCase();
  const normalized = `${normalizedCode} ${safeMessage}`.toLowerCase();

  if (normalized.includes('network') || normalized.includes('timeout')) {
    return '网络连接异常，请稍后重试';
  }
  if (
    normalizedCode === 'RATE_LIMIT' ||
    normalizedCode === 'TOO_MANY_REQUESTS' ||
    normalized.includes('too many requests')
  ) {
    return '操作过于频繁，请稍后再试';
  }
  if (normalizedCode === 'EMAIL_SEND_FAILED') {
    return '验证码邮件发送失败，请稍后重试';
  }
  if (normalizedCode === 'ACCOUNT_EXISTS') {
    return '该邮箱已注册，请直接登录';
  }
  if (normalizedCode === 'ACCOUNT_NOT_FOUND') {
    return '账号不存在，请检查后重试';
  }
  if (normalizedCode === 'USERNAME_TAKEN') {
    return '该用户名已被使用，请更换后重试';
  }
  if (normalizedCode === 'INVALID_OLD_PASSWORD') {
    return '当前密码不正确';
  }
  if (normalizedCode === 'PASSWORD_UNCHANGED') {
    return '新密码不能与当前密码相同';
  }
  if (
    normalizedCode === 'CURRENT_SESSION_REQUIRED' ||
    normalizedCode === 'CURRENT_SESSION_INVALID' ||
    normalizedCode === 'CURRENT_SESSION_REVOKED'
  ) {
    return '当前设备会话已失效，请重新登录';
  }
  if (normalizedCode === 'CURRENT_SESSION_MISMATCH') {
    return '当前设备会话与登录账户不一致，请重新登录';
  }
  if (normalizedCode === 'SESSION_NOT_FOUND') {
    return '该设备会话已退出，请刷新列表';
  }
  if (normalizedCode === 'CANNOT_REVOKE_CURRENT_SESSION') {
    return '当前设备请通过账户页退出登录';
  }
  if (normalizedCode === 'INVALID_FILE_TYPE') {
    return '仅支持 JPG、PNG 或 WebP 图片';
  }
  if (
    normalizedCode === 'INVALID_IMAGE' ||
    normalizedCode === 'IMAGE_DIMENSIONS_INVALID'
  ) {
    return '头像图片无效或尺寸过大，请重新选择';
  }
  if (normalizedCode === 'FILE_TOO_LARGE') {
    return '图片文件过大，请压缩后重试';
  }
  if (normalizedCode === 'TICKET_CLOSED') {
    return '该客服工单已关闭，无法继续补充消息';
  }
  if (normalizedCode === 'TICKET_NOT_FOUND') {
    return '客服工单不存在或已不可访问';
  }
  if (
    normalizedCode === 'SUPPORT_TICKET_CREATE_FAILED' ||
    normalizedCode === 'SUPPORT_TICKET_MESSAGE_FAILED' ||
    normalizedCode === 'SUPPORT_TICKET_CLOSE_FAILED' ||
    normalizedCode === 'SUPPORT_TICKET_READ_FAILED'
  ) {
    return '客服操作暂未完成，请稍后重试';
  }
  if (normalizedCode === 'SUPPORT_TICKET_READ_CURSOR_INVALID') {
    return '客服消息已更新，请刷新后重试';
  }
  if (normalizedCode === 'MOBILE_ANNOUNCEMENT_NOT_FOUND') {
    return '公告不存在或已下线';
  }
  if (normalizedCode === 'MOBILE_ANNOUNCEMENT_READ_STATE_LIMIT') {
    return '公告已读状态请求过多，请刷新后重试';
  }
  if (
    normalizedCode === 'OTP_EXPIRED' ||
    normalizedCode === 'OTP_USED'
  ) {
    return '验证码已失效，请重新获取';
  }
  if (
    normalizedCode === 'OTP_LOCKED' ||
    normalizedCode === 'OTP_TOO_MANY_TRIES'
  ) {
    return '验证码错误次数过多，请重新获取';
  }
  if (
    normalizedCode === 'OTP_INVALID' ||
    normalizedCode === 'OTP_REQUIRED'
  ) {
    return '验证码不正确或已过期';
  }
  if (
    normalizedCode === 'INVALID_CREDENTIALS' ||
    normalized.includes('invalid credential') ||
    normalized.includes('invalid password')
  ) {
    return '登录失败，请检查账号或密码';
  }
  if (
    normalized.includes('unauthorized') ||
    normalized.includes('invalid or expired access token') ||
    normalized.includes('missing access token') ||
    normalized.includes('invalid or expired refresh token') ||
    normalized.includes('refresh token revoked')
  ) {
    return '登录状态已失效，请重新登录';
  }
  if (normalized.includes('captcha') || normalized.includes('otp')) {
    return '验证码不正确或已过期';
  }
  if (normalized.includes('user_disabled')) {
    return '账户已被停用，请联系客服';
  }

  // Backend messages may originate from infrastructure exceptions. Only pass
  // through short, intentional Chinese business copy; never expose raw English,
  // stack traces, SQL fragments or filesystem details in the mobile UI.
  const containsChinese = /[\u3400-\u9fff]/.test(safeMessage);
  const looksTechnical =
    /traceback|exception|sqlalchemy|\bselect\b|\binsert\b|\bupdate\b|\bdelete\b|[a-z]:\\|\/usr\/|\/app\//i.test(
      safeMessage,
    );
  if (containsChinese && safeMessage.length <= 160 && !looksTechnical) {
    return safeMessage;
  }
  return '请求失败，请稍后重试';
}

async function parseResponsePayload(response: Response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function unwrapPayload<T>(payload: unknown): T {
  if (
    isRecord(payload) &&
    'ok' in payload &&
    ('data' in payload || 'error' in payload)
  ) {
    const envelope = payload as ApiEnvelope<T>;
    if (envelope.ok === false) {
      const message = envelope.error?.message || '请求失败，请稍后重试';
      const code = envelope.error?.code || 'API_ERROR';
      throw new ApiClientError(
        mapErrorMessage(message, code),
        code,
        undefined,
        envelope.error ? {...envelope.error} : undefined,
      );
    }
    return envelope.data as T;
  }

  return payload as T;
}

function responseError(response: Response, payload: unknown) {
  const root = isRecord(payload) ? payload : null;
  const detail = root?.detail;
  const envelopeError = isRecord(root?.error) ? root.error : null;
  const detailMessage =
    typeof detail === 'string'
      ? detail
      : isRecord(detail) && typeof detail.message === 'string'
        ? detail.message
        : undefined;
  const message =
    detailMessage ||
    getErrorMessage(envelopeError, `HTTP ${response.status}`);
  const code =
    (isRecord(detail) && typeof detail.code === 'string'
      ? detail.code
      : undefined) ||
    (isRecord(envelopeError) && typeof envelopeError.code === 'string'
      ? envelopeError.code
      : undefined) ||
    'HTTP_ERROR';

  return new ApiClientError(
    mapErrorMessage(message, code),
    code,
    response.status,
    isRecord(detail)
      ? {...detail}
      : isRecord(envelopeError)
        ? {...envelopeError}
        : undefined,
  );
}

function transportError(
  error: unknown,
  timedOut: boolean,
  externallyAborted: boolean,
) {
  if (externallyAborted) {
    return new ApiClientError(
      '请求已取消',
      'ABORTED',
      undefined,
      error instanceof Error ? {message: error.message} : undefined,
    );
  }

  return new ApiClientError(
    timedOut ? '请求超时，请稍后重试' : '网络连接异常，请稍后重试',
    timedOut ? 'TIMEOUT' : 'NETWORK_ERROR',
    undefined,
    error instanceof Error ? {message: error.message} : undefined,
  );
}

function isTerminalAuthError(error: ApiClientError) {
  return (
    error.status === 401 ||
    (error.status === 403 && error.code.toUpperCase() === 'USER_DISABLED')
  );
}

async function notifyAuthExpired(error: ApiClientError) {
  if (authExpiredNotified) return;
  authExpiredNotified = true;
  setApiAuthTokens(null);
  try {
    await authHandlers.onAuthExpired?.(error);
  } catch {
    // Request errors remain authoritative even if local cleanup has an issue.
  }
}

function createAbortContext(
  externalSignal?: AbortSignal,
  timeoutMs = API_TIMEOUT_MS,
) {
  const controller = new AbortController();
  let timedOut = false;
  const onExternalAbort = () => controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1, timeoutMs));

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', onExternalAbort, {once: true});
    }
  }

  return {
    controller,
    didTimeOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

async function refreshSession(): Promise<RefreshResult> {
  const refreshToken = authTokens.refreshToken;
  const sessionEpoch = authSessionEpoch;
  if (!refreshToken) {
    return {
      status: 'rejected',
      error: new ApiClientError(
        '登录状态已失效，请重新登录',
        'UNAUTHORIZED',
        401,
      ),
    };
  }

  const abort = createAbortContext();
  try {
    const response = await fetch(joinUrl(API_BASE_URL, AUTH_REFRESH_PATH), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      // Mobile authentication is Bearer-only. Never allow a Web cookie jar
      // (including cookies left by an older build) to restore a logged-out
      // session or become a second, invisible authentication authority.
      credentials: 'omit',
      body: JSON.stringify({refresh_token: refreshToken}),
      signal: abort.controller.signal,
    });
    const payload = await parseResponsePayload(response);

    if (!response.ok) {
      const error = responseError(response, payload);
      return {
        status: isTerminalAuthError(error) ? 'rejected' : 'unavailable',
        error,
      };
    }

    const result = unwrapPayload<{
      access_token?: string;
      refresh_token?: string;
    }>(payload);
    const accessToken = readString(result?.access_token);
    const nextRefreshToken =
      readString(result?.refresh_token) || authTokens.refreshToken;
    if (!accessToken) {
      return {
        status: 'unavailable',
        error: new ApiClientError(
          '刷新登录态未返回 access_token',
          'INVALID_REFRESH_RESPONSE',
        ),
      };
    }

    const nextTokens = {
      accessToken,
      refreshToken: nextRefreshToken,
    };
    if (
      authSessionEpoch !== sessionEpoch ||
      authTokens.refreshToken !== refreshToken
    ) {
      return {
        status: 'unavailable',
        error: new ApiClientError(
          '登录状态已变更，请重新发起请求',
          'AUTH_SESSION_CHANGED',
        ),
      };
    }
    try {
      await authHandlers.onTokensRefreshed?.(nextTokens);
    } catch (error) {
      return {
        status: 'unavailable',
        error: new ApiClientError(
          '刷新后的登录态保存失败，请稍后重试',
          'TOKEN_PERSIST_FAILED',
          undefined,
          error instanceof Error ? {message: error.message} : undefined,
        ),
      };
    }
    if (
      authSessionEpoch !== sessionEpoch ||
      authTokens.refreshToken !== refreshToken
    ) {
      return {
        status: 'unavailable',
        error: new ApiClientError(
          '登录状态已变更，请重新发起请求',
          'AUTH_SESSION_CHANGED',
        ),
      };
    }
    setRefreshedApiAuthTokens(nextTokens);
    return {status: 'success'};
  } catch (error) {
    return {
      status: 'unavailable',
      error: transportError(error, abort.didTimeOut(), false),
    };
  } finally {
    abort.cleanup();
  }
}

function getRefreshResult() {
  if (!refreshPromise) {
    refreshPromise = refreshSession().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

function canAttemptRefresh(path: string, authPolicy: ApiAuthPolicy) {
  return (
    authPolicy === 'auto' &&
    Boolean(authTokens.refreshToken) &&
    !AUTH_REFRESH_EXCLUDED_PATHS.has(path)
  );
}

function getDefaultAuthPolicy(path: string): ApiAuthPolicy {
  return PUBLIC_PATH_PREFIXES.some(prefix => path.startsWith(prefix))
    ? 'omit'
    : 'auto';
}

function shouldRetryNetwork(
  method: RequestMethod,
  options: ApiRequestOptions,
  state: RequestState,
  error: ApiClientError,
) {
  return (
    method === 'GET' &&
    options.retry !== 'none' &&
    state.networkRetryCount === 0 &&
    (error.code === 'NETWORK_ERROR' ||
      (error.status !== undefined &&
        RETRYABLE_GET_STATUSES.has(error.status))) &&
    !options.signal?.aborted
  );
}

function waitForNetworkRetry(signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const rejectAborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', rejectAborted);
      reject(new ApiClientError('请求已取消', 'ABORTED'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', rejectAborted);
      resolve();
    }, GET_NETWORK_RETRY_DELAY_MS);
    if (signal?.aborted) {
      rejectAborted();
      return;
    }
    signal?.addEventListener('abort', rejectAborted, {once: true});
  });
}

async function request<T>(
  method: RequestMethod,
  path: string,
  body?: unknown,
  options: ApiRequestOptions = {},
  state: RequestState = {
    networkRetryCount: 0,
    retriedAfterRefresh: false,
    sessionEpoch: authSessionEpoch,
  },
): Promise<T> {
  const authPolicy = options.auth || getDefaultAuthPolicy(path);
  if (authPolicy === 'auto' && state.sessionEpoch !== authSessionEpoch) {
    throw new ApiClientError(
      '登录状态已变更，请重新发起请求',
      'AUTH_SESSION_CHANGED',
    );
  }
  const abort = createAbortContext(options.signal, options.timeoutMs);
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...options.headers,
  };

  const isFormDataBody =
    typeof FormData !== 'undefined' && body instanceof FormData;
  if (body !== undefined && !isFormDataBody) {
    headers['Content-Type'] = 'application/json';
  }
  const requestAccessToken =
    authPolicy === 'auto' ? authTokens.accessToken : null;
  if (requestAccessToken) {
    headers.Authorization = `Bearer ${requestAccessToken}`;
  } else {
    delete headers.Authorization;
  }

  try {
    const response = await fetch(joinUrl(API_BASE_URL, path), {
      method,
      headers,
      credentials: 'omit',
      body:
        body === undefined
          ? undefined
          : isFormDataBody
            ? body
            : JSON.stringify(body),
      signal: abort.controller.signal,
    });
    const payload = await parseResponsePayload(response);

    if (
      response.status === 401 &&
      !state.retriedAfterRefresh &&
      canAttemptRefresh(path, authPolicy)
    ) {
      if (state.sessionEpoch !== authSessionEpoch) {
        throw new ApiClientError(
          '登录状态已变更，请重新发起请求',
          'AUTH_SESSION_CHANGED',
        );
      }
      if (
        requestAccessToken &&
        authTokens.accessToken &&
        requestAccessToken !== authTokens.accessToken
      ) {
        if (method !== 'GET') {
          throw new ApiClientError(
            '登录状态已更新，请确认后重新提交',
            'AUTH_REFRESHED_RETRY_REQUIRED',
          );
        }
        return request<T>(method, path, body, options, {
          ...state,
          retriedAfterRefresh: true,
        });
      }
      const refreshResult = await getRefreshResult();
      if (refreshResult.status === 'success') {
        if (method !== 'GET') {
          throw new ApiClientError(
            '登录状态已更新，请确认后重新提交',
            'AUTH_REFRESHED_RETRY_REQUIRED',
          );
        }
        return request<T>(method, path, body, options, {
          ...state,
          retriedAfterRefresh: true,
        });
      }
      if (refreshResult.status === 'rejected') {
        await notifyAuthExpired(refreshResult.error);
      }
      if (refreshResult.status === 'unavailable') {
        throw new ApiClientError(
          refreshResult.error.message,
          'SESSION_REFRESH_UNAVAILABLE',
          refreshResult.error.status,
          refreshResult.error.data,
        );
      }
      throw refreshResult.error;
    }

    if (!response.ok) {
      const error = responseError(response, payload);
      if (
        authPolicy === 'auto' &&
        state.sessionEpoch === authSessionEpoch &&
        isTerminalAuthError(error)
      ) {
        await notifyAuthExpired(error);
      }
      throw error;
    }

    if (
      authPolicy === 'auto' &&
      state.sessionEpoch !== authSessionEpoch
    ) {
      throw new ApiClientError(
        '登录状态已变更，请重新发起请求',
        'AUTH_SESSION_CHANGED',
      );
    }
    return unwrapPayload<T>(payload);
  } catch (error) {
    const normalizedError =
      error instanceof ApiClientError
        ? error
        : transportError(
            error,
            abort.didTimeOut(),
            Boolean(options.signal?.aborted),
          );

    if (shouldRetryNetwork(method, options, state, normalizedError)) {
      await waitForNetworkRetry(options.signal);
      return request<T>(method, path, body, options, {
        ...state,
        networkRetryCount: state.networkRetryCount + 1,
      });
    }
    throw normalizedError;
  } finally {
    abort.cleanup();
  }
}

export const apiClient = {
  get: <T>(path: string, options?: ApiRequestOptions) =>
    request<T>('GET', path, undefined, options),
  post: <T>(path: string, body?: unknown, options?: ApiRequestOptions) =>
    request<T>('POST', path, body, options),
  patch: <T>(path: string, body?: unknown, options?: ApiRequestOptions) =>
    request<T>('PATCH', path, body, options),
};

export const publicApiClient = {
  get: <T>(path: string, options?: Omit<ApiRequestOptions, 'auth'>) =>
    request<T>('GET', path, undefined, {...options, auth: 'omit'}),
  post: <T>(
    path: string,
    body?: unknown,
    options?: Omit<ApiRequestOptions, 'auth'>,
  ) => request<T>('POST', path, body, {...options, auth: 'omit'}),
  patch: <T>(
    path: string,
    body?: unknown,
    options?: Omit<ApiRequestOptions, 'auth'>,
  ) => request<T>('PATCH', path, body, {...options, auth: 'omit'}),
};

export function __resetApiClientForTests() {
  authTokens = {accessToken: null, refreshToken: null};
  authHandlers = {};
  refreshPromise = null;
  authExpiredNotified = false;
  authSessionEpoch = 0;
  accessTokenListeners.clear();
}
