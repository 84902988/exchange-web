import {
  __resetApiClientForTests,
  apiClient,
  getApiAccessTokenSnapshot,
  getApiRefreshToken,
  publicApiClient,
  setApiAuthLifecycleHandlers,
  setApiAuthTokens,
  subscribeApiAccessToken,
} from '../src/api/client';

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  } as unknown as Response;
}

function requestUrl(call: unknown[]) {
  return String(call[0]);
}

function requestHeaders(call: unknown[]) {
  return (call[1] as RequestInit | undefined)?.headers as
    | Record<string, string>
    | undefined;
}

describe('apiClient session and retry policy', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    __resetApiClientForTests();
    fetchMock = jest.fn();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  it('publishes access-token lifecycle snapshots without exposing refresh tokens', () => {
    const listener = jest.fn();
    const unsubscribe = subscribeApiAccessToken(listener);

    expect(listener).toHaveBeenLastCalledWith({
      accessToken: null,
      sessionEpoch: 0,
    });
    setApiAuthTokens({
      accessToken: 'access-private',
      refreshToken: 'refresh-private',
    });

    expect(getApiAccessTokenSnapshot()).toEqual({
      accessToken: 'access-private',
      sessionEpoch: 1,
    });
    expect(listener).toHaveBeenLastCalledWith({
      accessToken: 'access-private',
      sessionEpoch: 1,
    });
    expect(JSON.stringify(listener.mock.calls)).not.toContain(
      'refresh-private',
    );

    unsubscribe();
    setApiAuthTokens(null);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('sends authenticated PATCH requests as JSON without network replay', async () => {
    setApiAuthTokens({accessToken: 'access-patch', refreshToken: 'refresh-patch'});
    fetchMock.mockResolvedValue(
      jsonResponse(200, {ok: true, data: {nickname: '移动用户'}}),
    );

    await expect(
      apiClient.patch('/me', {nickname: '移动用户'}, {retry: 'none'}),
    ).resolves.toEqual({nickname: '移动用户'});

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe('PATCH');
    expect(init.credentials).toBe('omit');
    expect(init.body).toBe(JSON.stringify({nickname: '移动用户'}));
    expect((init.headers as Record<string, string>).Authorization).toBe(
      'Bearer access-patch',
    );
  });

  it('single-flights concurrent 401 refreshes and replays each GET once', async () => {
    setApiAuthTokens({
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
    });
    const onTokensRefreshed = jest.fn().mockResolvedValue(undefined);
    setApiAuthLifecycleHandlers({onTokensRefreshed});

    let releaseRefresh!: (response: Response) => void;
    const refreshGate = new Promise<Response>(resolve => {
      releaseRefresh = resolve;
    });

    fetchMock.mockImplementation(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/auth/refresh')) {
          return refreshGate;
        }
        const authorization = (
          init?.headers as Record<string, string> | undefined
        )?.Authorization;
        if (authorization === 'Bearer access-old') {
          return Promise.resolve(
            jsonResponse(401, {detail: 'Invalid or expired access token'}),
          );
        }
        return Promise.resolve(
          jsonResponse(200, {ok: true, data: {authorization}}),
        );
      },
    );

    const requests = [
      apiClient.get<{authorization: string}>('/asset/account-balances'),
      apiClient.get<{authorization: string}>('/asset/account-balances'),
      apiClient.get<{authorization: string}>('/asset/account-balances'),
    ];
    await Promise.resolve();
    await Promise.resolve();
    releaseRefresh(
      jsonResponse(200, {
        ok: true,
        data: {
          access_token: 'access-new',
          refresh_token: 'refresh-new',
        },
      }),
    );

    await expect(Promise.all(requests)).resolves.toEqual([
      {authorization: 'Bearer access-new'},
      {authorization: 'Bearer access-new'},
      {authorization: 'Bearer access-new'},
    ]);
    expect(
      fetchMock.mock.calls.filter(call =>
        requestUrl(call).endsWith('/auth/refresh'),
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(
        call =>
          requestHeaders(call)?.Authorization === 'Bearer access-old',
      ),
    ).toHaveLength(3);
    expect(
      fetchMock.mock.calls.filter(
        call =>
          requestHeaders(call)?.Authorization === 'Bearer access-new',
      ),
    ).toHaveLength(3);
    expect(onTokensRefreshed).toHaveBeenCalledWith({
      accessToken: 'access-new',
      refreshToken: 'refresh-new',
    });
    for (const call of fetchMock.mock.calls) {
      expect((call[1] as RequestInit).credentials).toBe('omit');
    }
    expect(getApiRefreshToken()).toBe('refresh-new');
  });

  it('keeps the session when refresh is temporarily unavailable', async () => {
    setApiAuthTokens({
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
    });
    const onAuthExpired = jest.fn();
    setApiAuthLifecycleHandlers({onAuthExpired});
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).endsWith('/auth/refresh')
        ? Promise.reject(new TypeError('offline'))
        : Promise.resolve(
            jsonResponse(401, {detail: 'Invalid or expired access token'}),
          ),
    );

    await expect(
      apiClient.get('/asset/account-balances'),
    ).rejects.toMatchObject({
      code: 'SESSION_REFRESH_UNAVAILABLE',
    });
    expect(onAuthExpired).not.toHaveBeenCalled();
    expect(getApiRefreshToken()).toBe('refresh-old');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not replay a POST after a successful refresh', async () => {
    setApiAuthTokens({
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
    });
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).endsWith('/auth/refresh')
        ? Promise.resolve(
            jsonResponse(200, {
              ok: true,
              data: {
                access_token: 'access-new',
                refresh_token: 'refresh-new',
              },
            }),
          )
        : Promise.resolve(
            jsonResponse(401, {detail: 'Invalid or expired access token'}),
          ),
    );

    await expect(
      apiClient.post('/contract/orders/open', {symbol: 'BTCUSDT'}),
    ).rejects.toMatchObject({
      code: 'AUTH_REFRESHED_RETRY_REQUIRED',
    });
    expect(
      fetchMock.mock.calls.filter(call =>
        requestUrl(call).endsWith('/contract/orders/open'),
      ),
    ).toHaveLength(1);
    expect(
      fetchMock.mock.calls.filter(call =>
        requestUrl(call).endsWith('/auth/refresh'),
      ),
    ).toHaveLength(1);
    expect(getApiRefreshToken()).toBe('refresh-new');
  });

  it('never retries a POST after a network error', async () => {
    setApiAuthTokens({
      accessToken: 'access',
      refreshToken: 'refresh',
    });
    fetchMock.mockRejectedValue(new TypeError('offline'));

    await expect(
      apiClient.post('/order/create', {symbol: 'BTCUSDT'}),
    ).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps auth business codes to formal Chinese copy', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(400, {
          detail: {code: 'ACCOUNT_EXISTS', message: 'Account already exists.'},
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(429, {
          detail: {code: 'RATE_LIMIT', message: 'Too many requests'},
        }),
      );

    await expect(
      publicApiClient.post('/auth/register', {}),
    ).rejects.toMatchObject({
      code: 'ACCOUNT_EXISTS',
      message: '该邮箱已注册，请直接登录',
    });
    await expect(
      publicApiClient.post('/auth/otp/send', {}),
    ).rejects.toMatchObject({
      code: 'RATE_LIMIT',
      message: '操作过于频繁，请稍后再试',
    });
  });

  it('does not expose unknown infrastructure errors to the UI', async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(500, {
          detail: 'Database connection pool exception at /app/service.py',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(500, {
          detail: '数据库异常 exception at /app/service.py',
        }),
      );

    await expect(publicApiClient.get('/private-detail')).rejects.toMatchObject({
      message: '请求失败，请稍后重试',
    });
    await expect(publicApiClient.get('/private-detail')).rejects.toMatchObject({
      message: '请求失败，请稍后重试',
    });
  });

  it('omits credentials for public market requests and ignores public 401', async () => {
    setApiAuthTokens({
      accessToken: 'access-private',
      refreshToken: 'refresh-private',
    });
    const onAuthExpired = jest.fn();
    setApiAuthLifecycleHandlers({onAuthExpired});
    fetchMock.mockResolvedValue(
      jsonResponse(401, {detail: 'Public request denied'}),
    );

    await expect(apiClient.get('/market/tickers')).rejects.toMatchObject({
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0];
    expect(requestHeaders(request)?.Authorization).toBeUndefined();
    expect((request[1] as RequestInit).credentials).toBe('omit');
    expect(onAuthExpired).not.toHaveBeenCalled();
    expect(getApiRefreshToken()).toBe('refresh-private');
  });

  it('retries a safe GET once after a network error', async () => {
    jest.useFakeTimers();
    fetchMock
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(
        jsonResponse(200, {ok: true, data: {price: 100}}),
      );

    const request = apiClient.get<{price: number}>('/market/tickers');
    await jest.advanceTimersByTimeAsync(400);

    await expect(request).resolves.toEqual({price: 100});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending GET retry without issuing another fetch', async () => {
    jest.useFakeTimers();
    const controller = new AbortController();
    fetchMock.mockRejectedValueOnce(new TypeError('offline'));

    const request = apiClient.get('/market/tickers', {
      signal: controller.signal,
    });
    const rejection = request.catch(error => error);
    await Promise.resolve();
    controller.abort();
    await jest.runOnlyPendingTimersAsync();

    await expect(rejection).resolves.toMatchObject({
      code: 'ABORTED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a safe GET once after a transient gateway response', async () => {
    jest.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(jsonResponse(503, {detail: 'Unavailable'}))
      .mockResolvedValueOnce(
        jsonResponse(200, {ok: true, data: {price: 100}}),
      );

    const request = apiClient.get<{price: number}>('/market/tickers');
    await jest.advanceTimersByTimeAsync(400);

    await expect(request).resolves.toEqual({price: 100});
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('honors an external abort without retrying the request', async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectAbort = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal?.aborted) {
            rejectAbort();
            return;
          }
          signal?.addEventListener('abort', rejectAbort, {once: true});
        }),
    );

    const request = apiClient.get('/market/tickers', {
      signal: controller.signal,
    });
    controller.abort();

    await expect(request).rejects.toMatchObject({
      code: 'ABORTED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('times out once without treating the timeout as a retryable network error', async () => {
    jest.useFakeTimers();
    fetchMock.mockImplementation(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const rejectAbort = () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          };
          if (signal?.aborted) {
            rejectAbort();
            return;
          }
          signal?.addEventListener('abort', rejectAbort, {once: true});
        }),
    );

    const request = apiClient.get('/market/tickers');
    const rejection = request.catch(error => error);
    await jest.advanceTimersByTimeAsync(15_000);

    await expect(rejection).resolves.toMatchObject({
      code: 'TIMEOUT',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('broadcasts terminal refresh rejection once for concurrent requests', async () => {
    setApiAuthTokens({
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
    });
    const onAuthExpired = jest.fn().mockResolvedValue(undefined);
    setApiAuthLifecycleHandlers({onAuthExpired});
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).endsWith('/auth/refresh')
        ? Promise.resolve(
            jsonResponse(401, {detail: 'Refresh token revoked'}),
          )
        : Promise.resolve(
            jsonResponse(401, {detail: 'Invalid or expired access token'}),
          ),
    );

    const results = await Promise.allSettled([
      apiClient.get('/asset/account-balances'),
      apiClient.get('/contract/account/summary'),
    ]);

    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(
      fetchMock.mock.calls.filter(call =>
        requestUrl(call).endsWith('/auth/refresh'),
      ),
    ).toHaveLength(1);
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(getApiRefreshToken()).toBeNull();
  });

  it('clears the session when a replayed GET still returns 401', async () => {
    setApiAuthTokens({
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
    });
    const onAuthExpired = jest.fn().mockResolvedValue(undefined);
    setApiAuthLifecycleHandlers({onAuthExpired});
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).endsWith('/auth/refresh')
        ? Promise.resolve(
            jsonResponse(200, {
              ok: true,
              data: {
                access_token: 'access-new',
                refresh_token: 'refresh-new',
              },
            }),
          )
        : Promise.resolve(
            jsonResponse(401, {detail: 'Invalid or expired access token'}),
          ),
    );

    await expect(
      apiClient.get('/asset/account-balances'),
    ).rejects.toMatchObject({
      status: 401,
    });
    expect(
      fetchMock.mock.calls.filter(call =>
        requestUrl(call).endsWith('/asset/account-balances'),
      ),
    ).toHaveLength(2);
    expect(
      fetchMock.mock.calls.filter(call =>
        requestUrl(call).endsWith('/auth/refresh'),
      ),
    ).toHaveLength(1);
    expect(onAuthExpired).toHaveBeenCalledTimes(1);
    expect(getApiRefreshToken()).toBeNull();
  });

  it('does not let an old request refresh or clear a newer session', async () => {
    setApiAuthTokens({
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    });
    const onAuthExpired = jest.fn();
    setApiAuthLifecycleHandlers({onAuthExpired});

    let releaseRequest!: (response: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>(resolve => {
          releaseRequest = resolve;
        }),
    );

    const oldRequest = apiClient.get('/asset/account-balances');
    await Promise.resolve();
    setApiAuthTokens({
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
    });
    releaseRequest(
      jsonResponse(401, {detail: 'Invalid or expired access token'}),
    );

    await expect(oldRequest).rejects.toMatchObject({
      code: 'AUTH_SESSION_CHANGED',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onAuthExpired).not.toHaveBeenCalled();
    expect(getApiRefreshToken()).toBe('refresh-b');
  });

  it('does not deliver a successful private response to a newer session', async () => {
    setApiAuthTokens({
      accessToken: 'access-a',
      refreshToken: 'refresh-a',
    });
    let releaseRequest!: (response: Response) => void;
    fetchMock.mockImplementation(
      () =>
        new Promise<Response>(resolve => {
          releaseRequest = resolve;
        }),
    );

    const oldRequest = apiClient.get('/asset/account-balances');
    await Promise.resolve();
    setApiAuthTokens({
      accessToken: 'access-b',
      refreshToken: 'refresh-b',
    });
    releaseRequest(jsonResponse(200, {ok: true, data: {balance: 10}}));

    await expect(oldRequest).rejects.toMatchObject({
      code: 'AUTH_SESSION_CHANGED',
    });
    expect(getApiRefreshToken()).toBe('refresh-b');
  });

  it('does not replay when rotated tokens cannot be persisted', async () => {
    setApiAuthTokens({
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
    });
    const onAuthExpired = jest.fn();
    setApiAuthLifecycleHandlers({
      onAuthExpired,
      onTokensRefreshed: jest
        .fn()
        .mockRejectedValue(new Error('storage unavailable')),
    });
    fetchMock.mockImplementation((input: RequestInfo | URL) =>
      String(input).endsWith('/auth/refresh')
        ? Promise.resolve(
            jsonResponse(200, {
              ok: true,
              data: {
                access_token: 'access-new',
                refresh_token: 'refresh-new',
              },
            }),
          )
        : Promise.resolve(
            jsonResponse(401, {detail: 'Invalid or expired access token'}),
          ),
    );

    await expect(
      apiClient.get('/asset/account-balances'),
    ).rejects.toMatchObject({
      code: 'SESSION_REFRESH_UNAVAILABLE',
    });
    expect(
      fetchMock.mock.calls.filter(call =>
        requestUrl(call).endsWith('/asset/account-balances'),
      ),
    ).toHaveLength(1);
    expect(onAuthExpired).not.toHaveBeenCalled();
    expect(getApiRefreshToken()).toBe('refresh-old');
  });
});
