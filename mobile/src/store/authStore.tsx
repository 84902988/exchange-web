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
  getMe,
  login as apiLogin,
  register as apiRegister,
  setApiAuthToken,
  type MeOut,
  type RegisterIn,
  type TokenOut,
} from '../api';

type AuthContextValue = {
  isLoggedIn: boolean;
  user: MeOut | null;
  loading: boolean;
  error: string | null;
  restoreSession: () => Promise<void>;
  login: (account: string, password: string) => Promise<void>;
  register: (payload: RegisterIn) => Promise<boolean>;
  logout: () => Promise<void>;
};

const ACCESS_TOKEN_KEY = 'access_token';
const REFRESH_TOKEN_KEY = 'refresh_token';
const USER_KEY = 'userInfo';

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

function hasToken(payload: {access_token?: string}): payload is TokenOut {
  return Boolean(payload.access_token);
}

async function persistTokens(tokens: TokenOut) {
  if (tokens.access_token) {
    await AsyncStorage.setItem(ACCESS_TOKEN_KEY, tokens.access_token);
    setApiAuthToken(tokens.access_token);
  }
  if (tokens.refresh_token) {
    await AsyncStorage.setItem(REFRESH_TOKEN_KEY, tokens.refresh_token);
  }
}

async function persistUser(user: MeOut | null) {
  if (!user) {
    await AsyncStorage.removeItem(USER_KEY);
    return;
  }
  await AsyncStorage.setItem(USER_KEY, JSON.stringify(user));
}

async function clearAuthStorage() {
  setApiAuthToken(null);
  await Promise.all([
    AsyncStorage.removeItem(ACCESS_TOKEN_KEY),
    AsyncStorage.removeItem(REFRESH_TOKEN_KEY),
    AsyncStorage.removeItem(USER_KEY),
  ]);
}

function readCachedUser(value: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as MeOut;
  } catch {
    return null;
  }
}

export function AuthProvider({children}: {children: ReactNode}) {
  const [user, setUser] = useState<MeOut | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const finishLoggedOut = useCallback(async (message: string | null = null) => {
    try {
      await clearAuthStorage();
    } catch {
      setApiAuthToken(null);
    }
    setUser(null);
    setError(message);
    setLoading(false);
  }, []);

  const restoreSession = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [accessToken, cachedUser] = await Promise.all([
        AsyncStorage.getItem(ACCESS_TOKEN_KEY),
        AsyncStorage.getItem(USER_KEY),
      ]);

      if (!accessToken) {
        await finishLoggedOut();
        return;
      }

      setApiAuthToken(accessToken);
      const parsedUser = readCachedUser(cachedUser);
      if (parsedUser) {
        setUser(parsedUser);
      }

      const currentUser = await getMe();
      setUser(currentUser);
      await persistUser(currentUser);
      setLoading(false);
    } catch (requestError) {
      await finishLoggedOut(
        requestError instanceof Error ? requestError.message : null,
      );
    }
  }, [finishLoggedOut]);

  useEffect(() => {
    restoreSession().catch(restoreError => {
      setError(restoreError instanceof Error ? restoreError.message : '恢复登录态失败');
      setLoading(false);
    });
  }, [restoreSession]);

  const login = useCallback(async (account: string, password: string) => {
    setLoading(true);
    setError(null);
    try {
      await clearAuthStorage();
      const tokens = await apiLogin({
        account: account.trim(),
        password,
        remember_me: true,
      });
      if (!hasToken(tokens)) {
        throw new Error('登录成功但未返回 access_token，移动端暂无法保存登录态');
      }
      await persistTokens(tokens);
      const currentUser = await getMe();
      setUser(currentUser);
      await persistUser(currentUser);
      setLoading(false);
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : '登录失败，请稍后重试';
      await finishLoggedOut(message);
      throw requestError;
    }
  }, [finishLoggedOut]);

  const register = useCallback(async (payload: RegisterIn) => {
    setLoading(true);
    setError(null);
    try {
      const result = await apiRegister(payload);
      if ('access_token' in result && result.access_token) {
        await persistTokens(result);
        const currentUser = await getMe();
        setUser(currentUser);
        await persistUser(currentUser);
        setLoading(false);
        return true;
      }
      setLoading(false);
      return false;
    } catch (requestError) {
      const message =
        requestError instanceof Error ? requestError.message : '注册失败，请稍后重试';
      setError(message);
      setLoading(false);
      throw requestError;
    }
  }, []);

  const logout = useCallback(async () => {
    setLoading(true);
    await finishLoggedOut();
  }, [finishLoggedOut]);

  const value = useMemo<AuthContextValue>(
    () => ({
      isLoggedIn: Boolean(user),
      user,
      loading,
      error,
      restoreSession,
      login,
      register,
      logout,
    }),
    [error, loading, login, logout, register, restoreSession, user],
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
