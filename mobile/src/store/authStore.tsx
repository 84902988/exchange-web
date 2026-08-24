import AsyncStorage from '@react-native-async-storage/async-storage';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiClientError,
  getMe,
  login as apiLogin,
  logout as apiLogout,
  register as apiRegister,
  requireAuthenticatedUser,
  setApiAuthLifecycleHandlers,
  setApiAuthTokens,
  type ApiAuthTokenState,
  type MeOut,
  type RegisterIn,
  type TokenOut,
} from '../api';
import {
  clearAuthTokensForLogout,
  LEGACY_ACCESS_TOKEN_KEY,
  LEGACY_REFRESH_TOKEN_KEY,
  readOrMigrateAuthTokens,
  readSecureAuthTokens,
  writeSecureAuthTokens,
} from '../services/secureAuthTokenStorage';
import {
  clearSecureUserSnapshot,
  LEGACY_USER_SNAPSHOT_KEY,
  readOrMigrateSecureUserSnapshot,
  writeSecureUserSnapshot,
} from '../services/secureUserSnapshotStorage';
import {clearPendingUserTransferIntentForLogout} from '../services/pendingUserTransferIntent';

type AuthContextValue = {
  isLoggedIn: boolean;
  user: MeOut | null;
  loading: boolean;
  error: string | null;
  restoreSession: () => Promise<void>;
  refreshUser: () => Promise<MeOut>;
  login: (
    account: string,
    password: string,
    captcha?: {captchaId: string; captchaCode: string},
  ) => Promise<void>;
  register: (payload: RegisterIn) => Promise<void>;
  logout: () => Promise<void>;
};

const AuthContext = createContext<AuthContextValue | undefined>(undefined);
let authStorageTail: Promise<void> = Promise.resolve();

function enqueueAuthStorageOperation<T>(operation: () => Promise<T>) {
  const result = authStorageTail.catch(() => undefined).then(operation);
  authStorageTail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

function hasTokenPair(
  payload: TokenOut,
): payload is TokenOut & {access_token: string; refresh_token: string} {
  return Boolean(payload.access_token?.trim() && payload.refresh_token?.trim());
}

async function persistTokenStorage(tokens: ApiAuthTokenState) {
  await enqueueAuthStorageOperation(() =>
    writeSecureAuthTokens({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    }),
  );
}

async function persistApiTokenState(tokens: ApiAuthTokenState) {
  await persistTokenStorage(tokens);
  setApiAuthTokens(tokens);
}

async function persistTokens(tokens: TokenOut) {
  await persistApiTokenState({
    accessToken: tokens.access_token?.trim() || null,
    refreshToken: tokens.refresh_token?.trim() || null,
  });
}

async function persistUser(user: MeOut | null) {
  await enqueueAuthStorageOperation(async () => {
    if (!user) {
      await Promise.all([
        clearSecureUserSnapshot(),
        AsyncStorage.removeItem(LEGACY_USER_SNAPSHOT_KEY),
      ]);
      return;
    }
    await writeSecureUserSnapshot(user);
  });
}

async function clearAuthStorage() {
  setApiAuthTokens(null);
  await enqueueAuthStorageOperation(() =>
    Promise.all([
      clearAuthTokensForLogout(),
      clearPendingUserTransferIntentForLogout(),
      clearSecureUserSnapshot(),
      AsyncStorage.removeMany([
        LEGACY_ACCESS_TOKEN_KEY,
        LEGACY_REFRESH_TOKEN_KEY,
        LEGACY_USER_SNAPSHOT_KEY,
      ]),
    ]).then(() => undefined),
  );
}

function readCachedUser(value: unknown) {
  if (!value) return null;
  try {
    return requireAuthenticatedUser(value);
  } catch {
    return null;
  }
}

export function shouldClearSessionForError(error: unknown) {
  if (!(error instanceof ApiClientError)) return false;
  const code = error.code.toUpperCase();
  return (
    error.status === 401 ||
    (error.status === 403 && code === 'USER_DISABLED') ||
    code === 'INVALID_ME_RESPONSE'
  );
}

export function AuthProvider({children}: {children: ReactNode}) {
  const [user, setUser] = useState<MeOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const finishLoggedOut = useCallback(async (message: string | null = null) => {
    try {
      await clearAuthStorage();
    } catch {
      setApiAuthTokens(null);
    }
    setUser(null);
    setError(message);
    setLoading(false);
  }, []);

  const restoreSession = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [tokens, cachedUser] =
        await enqueueAuthStorageOperation(() =>
          Promise.all([
            readOrMigrateAuthTokens(),
            readOrMigrateSecureUserSnapshot(),
          ]),
        );
      const {accessToken, refreshToken} = tokens;

      if (!accessToken && !refreshToken) {
        await finishLoggedOut();
        return;
      }

      setApiAuthTokens({accessToken, refreshToken});
      const parsedUser = readCachedUser(cachedUser);
      if (parsedUser) {
        setUser(parsedUser);
      } else if (cachedUser) {
        await persistUser(null);
      }

      const currentUser = requireAuthenticatedUser(await getMe());
      setUser(currentUser);
      await persistUser(currentUser);
      setLoading(false);
    } catch (requestError) {
      const message =
        requestError instanceof Error
          ? requestError.message
          : '登录状态检查失败，请稍后重试';
      if (shouldClearSessionForError(requestError)) {
        await finishLoggedOut(message);
        return;
      }
      setError(message);
      setLoading(false);
    }
  }, [finishLoggedOut]);

  const refreshUser = useCallback(async () => {
    try {
      const currentUser = requireAuthenticatedUser(await getMe());
      setUser(currentUser);
      await persistUser(currentUser);
      setError(null);
      return currentUser;
    } catch (requestError) {
      const message =
        requestError instanceof Error
          ? requestError.message
          : '账户资料刷新失败，请稍后重试';
      if (shouldClearSessionForError(requestError)) {
        await finishLoggedOut(message);
      } else {
        setError(message);
      }
      throw requestError;
    }
  }, [finishLoggedOut]);

  useEffect(
    () =>
      setApiAuthLifecycleHandlers({
        onAuthExpired: sessionError =>
          finishLoggedOut(sessionError.message),
        onTokensRefreshed: persistTokenStorage,
      }),
    [finishLoggedOut],
  );

  useEffect(() => {
    restoreSession().catch(restoreError => {
      setError(restoreError instanceof Error ? restoreError.message : '恢复登录态失败');
      setLoading(false);
    });
  }, [restoreSession]);

  const login = useCallback(async (
    account: string,
    password: string,
    captcha?: {captchaId: string; captchaCode: string},
  ) => {
    setLoading(true);
    setError(null);
    let tokensPersisted = false;
    try {
      const captchaId = captcha?.captchaId.trim() || '';
      const captchaCode = captcha?.captchaCode.trim().toUpperCase() || '';
      if (
        captcha &&
        (!/^[A-Za-z0-9_-]{20,128}$/.test(captchaId) ||
          !/^[A-HJ-NP-Z2-9]{5}$/.test(captchaCode))
      ) {
        throw new ApiClientError(
          '图形验证码信息无效，未发送登录请求',
          'INVALID_CAPTCHA_INPUT',
        );
      }
      await clearAuthStorage();
      const tokens = await apiLogin({
        account: account.trim(),
        password,
        ...(captcha
          ? {captcha_id: captchaId, captcha_code: captchaCode}
          : {}),
        remember_me: true,
      });
      if (!hasTokenPair(tokens)) {
        throw new Error('登录成功但未返回完整令牌，移动端暂无法保存登录态');
      }
      await persistTokens(tokens);
      tokensPersisted = true;
      const currentUser = requireAuthenticatedUser(await getMe());
      setUser(currentUser);
      await persistUser(currentUser);
      setLoading(false);
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : '登录失败，请稍后重试';
      if (!tokensPersisted || shouldClearSessionForError(requestError)) {
        await finishLoggedOut(message);
      } else {
        setError(message);
        setLoading(false);
      }
      throw requestError;
    }
  }, [finishLoggedOut]);

  const register = useCallback(async (payload: RegisterIn) => {
    setLoading(true);
    setError(null);
    let tokensPersisted = false;
    try {
      await clearAuthStorage();
      const result = await apiRegister(payload);
      if (!hasTokenPair(result)) {
        throw new ApiClientError(
          '注册响应缺少完整令牌，未建立登录态',
          'INVALID_REGISTER_RESPONSE',
        );
      }
      await persistTokens(result);
      tokensPersisted = true;
      const currentUser = requireAuthenticatedUser(await getMe());
      setUser(currentUser);
      await persistUser(currentUser);
      setLoading(false);
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : '注册失败，请稍后重试';
      if (!tokensPersisted || shouldClearSessionForError(requestError)) {
        await finishLoggedOut(message);
      } else {
        setError(message);
        setLoading(false);
      }
      throw requestError;
    }
  }, [finishLoggedOut]);

  const logout = useCallback(async () => {
    setLoading(true);
    let refreshToken: string | null = null;
    try {
      const tokens = await enqueueAuthStorageOperation(readSecureAuthTokens);
      refreshToken = tokens.refreshToken;
    } catch {
      // A missing local snapshot must not block logout.
    }
    await finishLoggedOut();
    try {
      await apiLogout(refreshToken ? {refresh_token: refreshToken} : {});
    } catch {
      // Local cleanup remains authoritative if remote revocation is unavailable.
    }
  }, [finishLoggedOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isLoggedIn: Boolean(user),
      user,
      loading,
      error,
      restoreSession,
      refreshUser,
      login,
      register,
      logout,
    }),
    [error, loading, login, logout, refreshUser, register, restoreSession, user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
