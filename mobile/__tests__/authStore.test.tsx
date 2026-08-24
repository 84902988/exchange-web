import AsyncStorage from '@react-native-async-storage/async-storage';
import React from 'react';
import * as Keychain from 'react-native-keychain';
import ReactTestRenderer, {act} from 'react-test-renderer';
import {
  ApiClientError,
  __resetApiClientForTests,
  apiClient,
} from '../src/api/client';
import {readSecureAuthTokens} from '../src/services/secureAuthTokenStorage';
import {readSecureUserSnapshot} from '../src/services/secureUserSnapshotStorage';
import {
  createPendingUserTransferIntent,
  loadPendingUserTransferIntent,
  savePendingUserTransferIntent,
} from '../src/services/pendingUserTransferIntent';

const keychainMock = Keychain as typeof Keychain & {
  __resetMock: () => void;
  __storeMockCredentials: typeof Keychain.setGenericPassword;
};

const mockGetMe = jest.fn();
const mockApiLogin = jest.fn();
const mockApiLogout = jest.fn();
const mockApiRegister = jest.fn();

jest.mock('../src/api', () => {
  const actual = jest.requireActual('../src/api');
  return {
    ...actual,
    getMe: (...args: unknown[]) => mockGetMe(...args),
    login: (...args: unknown[]) => mockApiLogin(...args),
    logout: (...args: unknown[]) => mockApiLogout(...args),
    register: (...args: unknown[]) => mockApiRegister(...args),
  };
});

import {
  AuthProvider,
  shouldClearSessionForError,
  useAuth,
} from '../src/store/authStore';

const cachedUser = {
  id: 7,
  email: 'mobile@example.com',
  status: 1,
  profile: {nickname: 'Mobile User'},
};
const nextUser = {
  id: 8,
  email: 'next@example.com',
  status: 1,
  profile: {nickname: 'Next User'},
};

let latestAuth: ReturnType<typeof useAuth> | null = null;

function AuthProbe() {
  latestAuth = useAuth();
  return null;
}

function jsonResponse(status: number, payload: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: jest.fn().mockResolvedValue(JSON.stringify(payload)),
  } as unknown as Response;
}

async function renderProvider() {
  let renderer: ReactTestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = ReactTestRenderer.create(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>,
    );
  });
  return renderer!;
}

async function captureActError(operation: () => Promise<unknown>) {
  let captured: unknown;
  await act(async () => {
    try {
      await operation();
    } catch (error) {
      captured = error;
    }
  });
  return captured;
}

async function expectAuthStorage(
  accessToken: string | null,
  refreshToken: string | null,
  user: unknown,
) {
  await expect(readSecureAuthTokens()).resolves.toEqual({
    accessToken,
    refreshToken,
  });
  await expect(readSecureUserSnapshot()).resolves.toEqual(user);
  await expect(
    AsyncStorage.getMany(['access_token', 'refresh_token', 'userInfo']),
  ).resolves.toEqual({
    access_token: null,
    refresh_token: null,
    userInfo: null,
  });
}

describe('AuthProvider session policy', () => {
  let renderer: ReactTestRenderer.ReactTestRenderer | null = null;

  beforeEach(async () => {
    __resetApiClientForTests();
    latestAuth = null;
    jest.clearAllMocks();
    keychainMock.__resetMock();
    await AsyncStorage.clear();
    mockApiLogout.mockResolvedValue({message: 'ok'});
    mockApiRegister.mockResolvedValue({message: 'ok'});
  });

  afterEach(async () => {
    if (renderer) {
      await act(async () => {
        renderer?.unmount();
      });
    }
    renderer = null;
  });

  it('keeps cached identity and both tokens when /me has a network error', async () => {
    await AsyncStorage.setMany({
      access_token: 'access-cached',
      refresh_token: 'refresh-cached',
      userInfo: JSON.stringify(cachedUser),
    });
    mockGetMe.mockRejectedValue(
      new ApiClientError('网络连接异常，请稍后重试', 'NETWORK_ERROR'),
    );

    renderer = await renderProvider();

    expect(latestAuth?.isLoggedIn).toBe(true);
    expect(latestAuth?.user).toEqual(cachedUser);
    expect(latestAuth?.loading).toBe(false);
    expect(latestAuth?.error).toBe('网络连接异常，请稍后重试');
    await expectAuthStorage('access-cached', 'refresh-cached', cachedUser);
  });

  it('clears cached identity and tokens after a final 401', async () => {
    await AsyncStorage.setMany({
      access_token: 'access-expired',
      refresh_token: 'refresh-expired',
      userInfo: JSON.stringify(cachedUser),
    });
    mockGetMe.mockRejectedValue(
      new ApiClientError(
        '登录状态已失效，请重新登录',
        'UNAUTHORIZED',
        401,
      ),
    );

    renderer = await renderProvider();

    expect(latestAuth?.isLoggedIn).toBe(false);
    expect(latestAuth?.user).toBeNull();
    expect(latestAuth?.loading).toBe(false);
    await expectAuthStorage(null, null, null);
  });

  it('persists a complete token pair after login', async () => {
    mockApiLogin.mockResolvedValue({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
    });
    mockGetMe.mockResolvedValue(cachedUser);
    renderer = await renderProvider();

    await act(async () => {
      await latestAuth?.login('mobile@example.com', 'secret');
    });

    expect(mockApiLogin).toHaveBeenCalledWith({
      account: 'mobile@example.com',
      password: 'secret',
      remember_me: true,
    });
    expect(latestAuth?.isLoggedIn).toBe(true);
    await expectAuthStorage('access-new', 'refresh-new', cachedUser);
  });

  it('passes a complete normalized captcha challenge to login', async () => {
    mockApiLogin.mockResolvedValue({
      access_token: 'access-captcha',
      refresh_token: 'refresh-captcha',
    });
    mockGetMe.mockResolvedValue(cachedUser);
    renderer = await renderProvider();

    await act(async () => {
      await latestAuth?.login('mobile@example.com', 'secret', {
        captchaId: ' captcha-challenge-store-12345 ',
        captchaCode: ' ab2cd ',
      });
    });

    expect(mockApiLogin).toHaveBeenCalledWith({
      account: 'mobile@example.com',
      password: 'secret',
      captcha_id: 'captcha-challenge-store-12345',
      captcha_code: 'AB2CD',
      remember_me: true,
    });
    expect(latestAuth?.isLoggedIn).toBe(true);
  });

  it('does not send login when a requested captcha challenge is incomplete', async () => {
    renderer = await renderProvider();

    const error = await captureActError(() =>
      latestAuth!.login('mobile@example.com', 'secret', {
        captchaId: '',
        captchaCode: 'AB2CD',
      }),
    );

    expect(error).toEqual(
      expect.objectContaining({
        code: 'INVALID_CAPTCHA_INPUT',
      }),
    );
    expect(mockApiLogin).not.toHaveBeenCalled();
    expect(latestAuth?.isLoggedIn).toBe(false);
  });

  it('rejects an incomplete login token response without keeping a session', async () => {
    mockApiLogin.mockResolvedValue({access_token: 'access-only'});
    renderer = await renderProvider();

    const error = await captureActError(() =>
      latestAuth!.login('mobile@example.com', 'secret'),
    );
    expect(error).toEqual(expect.objectContaining({message: expect.stringContaining('完整令牌')}));
    expect(latestAuth?.isLoggedIn).toBe(false);
    await expectAuthStorage(null, null, null);
  });

  it('rejects an invalid /me identity after login and clears the new tokens', async () => {
    mockApiLogin.mockResolvedValue({
      access_token: 'access-new',
      refresh_token: 'refresh-new',
    });
    mockGetMe.mockResolvedValue({});
    renderer = await renderProvider();

    const error = await captureActError(() =>
      latestAuth!.login('mobile@example.com', 'secret'),
    );
    expect(error).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('用户身份响应缺少有效账号信息'),
      }),
    );

    expect(latestAuth?.isLoggedIn).toBe(false);
    await expectAuthStorage(null, null, null);
  });

  it('does not trust malformed cached identity during a transient /me failure', async () => {
    await AsyncStorage.setMany({
      access_token: 'access-cached',
      refresh_token: 'refresh-cached',
      userInfo: JSON.stringify({}),
    });
    mockGetMe.mockRejectedValue(
      new ApiClientError('网络连接异常，请稍后重试', 'NETWORK_ERROR'),
    );

    renderer = await renderProvider();

    expect(latestAuth?.isLoggedIn).toBe(false);
    expect(latestAuth?.user).toBeNull();
    await expectAuthStorage('access-cached', 'refresh-cached', null);
  });

  it('requires register to return tokens and a validated authenticated user', async () => {
    mockApiRegister.mockResolvedValueOnce({message: 'ok'});
    renderer = await renderProvider();

    const error = await captureActError(() =>
      latestAuth!.register({
          email: 'mobile@example.com',
          otp: '123456',
          password: 'secret1',
      }),
    );
    expect(error).toEqual(
      expect.objectContaining({message: expect.stringContaining('完整令牌')}),
    );
    expect(latestAuth?.isLoggedIn).toBe(false);

    mockApiRegister.mockResolvedValueOnce({
      access_token: 'register-access',
      refresh_token: 'register-refresh',
    });
    mockGetMe.mockResolvedValue(cachedUser);
    await act(async () => {
      await latestAuth?.register({
        email: 'mobile@example.com',
        otp: '654321',
        password: 'secret2',
      });
    });

    expect(latestAuth?.isLoggedIn).toBe(true);
    expect(latestAuth?.user).toEqual(cachedUser);
    await expectAuthStorage('register-access', 'register-refresh', cachedUser);
  });

  it('clears local state before a best-effort remote logout', async () => {
    await AsyncStorage.setMany({
      access_token: 'access-active',
      refresh_token: 'refresh-active',
      userInfo: JSON.stringify(cachedUser),
    });
    mockGetMe.mockResolvedValue(cachedUser);
    mockApiLogout.mockRejectedValue(new TypeError('offline'));
    await savePendingUserTransferIntent(
      createPendingUserTransferIntent({
        ownerKey: '7',
        requestId: 'logout-transfer-intent',
        recipientUserId: 8,
        recipientEmail: 'receiver@example.com',
        symbol: 'USDT',
        amount: '1',
        createdAtMs: 1_800_000_000_000,
      }),
    );
    renderer = await renderProvider();

    await act(async () => {
      await latestAuth?.logout();
    });

    expect(mockApiLogout).toHaveBeenCalledWith({
      refresh_token: 'refresh-active',
    });
    expect(latestAuth?.isLoggedIn).toBe(false);
    expect(latestAuth?.loading).toBe(false);
    await expectAuthStorage(null, null, null);
    await expect(loadPendingUserTransferIntent('7')).resolves.toBeNull();
  });

  it('does not let a late remote logout clear a newer login', async () => {
    await AsyncStorage.setMany({
      access_token: 'access-active',
      refresh_token: 'refresh-active',
      userInfo: JSON.stringify(cachedUser),
    });
    mockGetMe
      .mockResolvedValueOnce(cachedUser)
      .mockResolvedValueOnce(nextUser);
    mockApiLogin.mockResolvedValue({
      access_token: 'access-next',
      refresh_token: 'refresh-next',
    });
    let releaseRemoteLogout!: () => void;
    let markRemoteLogoutStarted!: () => void;
    const remoteLogoutStarted = new Promise<void>(resolve => {
      markRemoteLogoutStarted = resolve;
    });
    const remoteLogoutGate = new Promise<void>(resolve => {
      releaseRemoteLogout = resolve;
    });
    mockApiLogout.mockImplementation(() => {
      markRemoteLogoutStarted();
      return remoteLogoutGate;
    });
    renderer = await renderProvider();

    let logoutPromise!: Promise<void>;
    await act(async () => {
      logoutPromise = latestAuth!.logout();
      await remoteLogoutStarted;
    });
    expect(latestAuth?.isLoggedIn).toBe(false);

    await act(async () => {
      await latestAuth?.login('next@example.com', 'next-secret');
    });
    expect(latestAuth?.user).toEqual(nextUser);

    await act(async () => {
      releaseRemoteLogout();
      await logoutPromise;
    });

    expect(latestAuth?.isLoggedIn).toBe(true);
    expect(latestAuth?.user).toEqual(nextUser);
    await expectAuthStorage('access-next', 'refresh-next', nextUser);
  });

  it('serializes a pending refresh write before logout and a newer login', async () => {
    await AsyncStorage.setMany({
      access_token: 'access-old',
      refresh_token: 'refresh-old',
      userInfo: JSON.stringify(cachedUser),
    });
    mockGetMe
      .mockResolvedValueOnce(cachedUser)
      .mockResolvedValueOnce(nextUser);
    mockApiLogin.mockResolvedValue({
      access_token: 'access-next',
      refresh_token: 'refresh-next',
    });
    renderer = await renderProvider();

    const originalFetch = globalThis.fetch;
    const fetchMock = jest.fn(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith('/auth/refresh')) {
          return Promise.resolve(
            jsonResponse(200, {
              ok: true,
              data: {
                access_token: 'access-rotated-old',
                refresh_token: 'refresh-rotated-old',
              },
            }),
          );
        }
        const authorization = (
          init?.headers as Record<string, string> | undefined
        )?.Authorization;
        if (authorization === 'Bearer access-old') {
          return Promise.resolve(
            jsonResponse(401, {
              detail: 'Invalid or expired access token',
            }),
          );
        }
        return Promise.resolve(
          jsonResponse(200, {ok: true, data: {ok: true}}),
        );
      },
    );
    let releaseRotatedWrite!: () => void;
    let markRotatedWriteStarted!: () => void;
    const rotatedWriteStarted = new Promise<void>(resolve => {
      markRotatedWriteStarted = resolve;
    });
    const rotatedWriteGate = new Promise<void>(resolve => {
      releaseRotatedWrite = resolve;
    });
    const secureWriteSpy = jest
      .spyOn(Keychain, 'setGenericPassword')
      .mockImplementation(async (username, password, options) => {
        if (password.includes('access-rotated-old')) {
          markRotatedWriteStarted();
          await rotatedWriteGate;
        }
        return keychainMock.__storeMockCredentials(username, password, options);
      });
    globalThis.fetch = fetchMock as typeof fetch;

    try {
      const refreshRequest = apiClient.get('/asset/account-balances');
      await rotatedWriteStarted;

      let logoutPromise!: Promise<void>;
      let loginPromise!: Promise<void>;
      await act(async () => {
        logoutPromise = latestAuth!.logout();
        loginPromise = latestAuth!.login('next@example.com', 'next-secret');
        await Promise.resolve();
      });

      releaseRotatedWrite();
      await act(async () => {
        await Promise.allSettled([
          refreshRequest,
          logoutPromise,
          loginPromise,
        ]);
      });

      expect(latestAuth?.isLoggedIn).toBe(true);
      expect(latestAuth?.user).toEqual(nextUser);
      await expectAuthStorage('access-next', 'refresh-next', nextUser);
    } finally {
      secureWriteSpy.mockRestore();
      globalThis.fetch = originalFetch;
    }
  });
});

describe('shouldClearSessionForError', () => {
  it('only treats final authorization errors as terminal', () => {
    expect(
      shouldClearSessionForError(
        new ApiClientError('expired', 'UNAUTHORIZED', 401),
      ),
    ).toBe(true);
    expect(
      shouldClearSessionForError(
        new ApiClientError('disabled', 'USER_DISABLED', 403),
      ),
    ).toBe(true);
    expect(
      shouldClearSessionForError(
        new ApiClientError('forbidden', 'FORBIDDEN', 403),
      ),
    ).toBe(false);
    expect(
      shouldClearSessionForError(
        new ApiClientError('offline', 'NETWORK_ERROR'),
      ),
    ).toBe(false);
    expect(
      shouldClearSessionForError(
        new ApiClientError('temporary', 'SESSION_REFRESH_UNAVAILABLE', 503),
      ),
    ).toBe(false);
    expect(
      shouldClearSessionForError(
        new ApiClientError('invalid me', 'INVALID_ME_RESPONSE'),
      ),
    ).toBe(true);
  });
});
