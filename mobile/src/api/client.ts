import {API_BASE_URL, API_TIMEOUT_MS} from '../config/env';

type RequestMethod = 'GET' | 'POST';

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

let authToken: string | null = null;

export function setApiAuthToken(token: string | null) {
  authToken = token;
}

function joinUrl(baseUrl: string, path: string) {
  const base = baseUrl.replace(/\/+$/, '');
  const suffix = path.startsWith('/') ? path : `/${path}`;
  return `${base}${suffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function getErrorMessage(error: unknown, fallback: string) {
  if (isRecord(error) && typeof error.message === 'string') {
    return error.message;
  }
  return fallback;
}

function mapErrorMessage(message: string, code: string) {
  const normalized = `${code} ${message}`.toLowerCase();

  if (normalized.includes('network') || normalized.includes('timeout')) {
    return '网络连接异常，请稍后重试';
  }
  if (
    normalized.includes('invalid credential') ||
    normalized.includes('unauthorized') ||
    normalized.includes('password') ||
    normalized.includes('account not found') ||
    normalized.includes('user not found')
  ) {
    return '登录失败，请检查账号或密码';
  }
  if (normalized.includes('captcha') || normalized.includes('otp')) {
    return '验证码不正确或已过期';
  }
  if (normalized.includes('user_disabled')) {
    return '账户已被停用，请联系客服';
  }

  return message || '请求失败，请稍后重试';
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

async function request<T>(
  method: RequestMethod,
  path: string,
  body?: unknown,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  try {
    const response = await fetch(joinUrl(API_BASE_URL, path), {
      method,
      headers,
      credentials: 'include',
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });

    const payload = await parseResponsePayload(response);

    if (!response.ok) {
      const root = isRecord(payload) ? payload : null;
      const detail = root?.detail;
      const envelopeError = isRecord(root?.error) ? root?.error : null;
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

      throw new ApiClientError(
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

    return unwrapPayload<T>(payload);
  } catch (error) {
    if (error instanceof ApiClientError) throw error;
    const isAbort =
      error instanceof Error &&
      (error.name === 'AbortError' || error.message.includes('aborted'));
    throw new ApiClientError(
      isAbort ? '请求超时，请稍后重试' : '网络连接异常，请稍后重试',
      isAbort ? 'TIMEOUT' : 'NETWORK_ERROR',
      undefined,
      error instanceof Error ? {message: error.message} : undefined,
    );
  } finally {
    clearTimeout(timer);
  }
}

export const apiClient = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
};
