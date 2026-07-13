import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { clearTokens, setTokens } from './token';
import { request } from './request';

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
});
