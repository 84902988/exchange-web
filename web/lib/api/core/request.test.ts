import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { clearTokens, setTokens } from './token';
import { AUTH_EXPIRED_EVENT, publicRequest, request } from './request';

function response(status: number, payload: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : 'OK',
    json: async () => payload,
  } as Response;
}

describe('request refresh ownership', () => {
  beforeEach(() => {
    clearTokens();
  });

  afterEach(() => {
    clearTokens();
    jest.restoreAllMocks();
  });

  it('attempts refresh only once when /me ends in 401', async () => {
    let refreshCount = 0;
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        refreshCount += 1;
        return response(401, { detail: 'missing refresh token' });
      }
      return response(401, { detail: 'missing access token' });
    });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });

    await expect(request('/me', { method: 'GET' })).rejects.toBeDefined();
    expect(refreshCount).toBe(1);
  });

  it('keeps concurrent 401 recovery single-flight', async () => {
    setTokens({ access_token: 'expired', refresh_token: 'refresh-hint' });
    let refreshCount = 0;
    const privateCalls = new Map<string, number>();
    const fetchMock = jest.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/auth/refresh')) {
        refreshCount += 1;
        await Promise.resolve();
        return response(200, {
          ok: true,
          data: { access_token: 'renewed', refresh_token: 'renewed-refresh' },
        });
      }
      const path = url.endsWith('/private-a') ? 'a' : 'b';
      const count = (privateCalls.get(path) || 0) + 1;
      privateCalls.set(path, count);
      return count === 1
        ? response(401, { detail: 'invalid or expired access token' })
        : response(200, { ok: true, data: { recovered: true } });
    });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });

    const results = await Promise.all([
      request<{ recovered: boolean }>('/private-a'),
      request<{ recovered: boolean }>('/private-b'),
    ]);

    expect(refreshCount).toBe(1);
    expect(results).toEqual([{ recovered: true }, { recovered: true }]);
  });

  it('omits credentials and authorization for explicit public requests', async () => {
    setTokens({ access_token: 'signed-in-token', refresh_token: 'refresh-hint' });
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return response(200, { ok: true, data: { value: 1 } });
    });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });

    await expect(publicRequest<{ value: number }>('/market/tickers')).resolves.toEqual({ value: 1 });

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(requestInit?.credentials).toBe('omit');
    expect(new Headers(requestInit?.headers).has('Authorization')).toBe(false);
  });

  it('does not refresh a public request after a 401 response', async () => {
    setTokens({ access_token: 'signed-in-token', refresh_token: 'refresh-hint' });
    const authExpiredListener = jest.fn();
    window.addEventListener(AUTH_EXPIRED_EVENT, authExpiredListener);
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return response(401, { detail: 'unauthorized' });
    });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });

    await expect(publicRequest('/market/tickers')).rejects.toBeDefined();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/market/tickers');
    expect(authExpiredListener).not.toHaveBeenCalled();
    window.removeEventListener(AUTH_EXPIRED_EVENT, authExpiredListener);
  });

  it('keeps the authenticated request behavior unchanged by default', async () => {
    setTokens({ access_token: 'signed-in-token', refresh_token: 'refresh-hint' });
    const fetchMock = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return response(200, { ok: true, data: { value: 1 } });
    });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: fetchMock });

    await request('/private');

    const requestInit = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(requestInit?.credentials).toBe('include');
    expect(new Headers(requestInit?.headers).get('Authorization')).toBe('Bearer signed-in-token');
  });
});
