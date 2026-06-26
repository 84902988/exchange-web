'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  ApiError,
  getMe,
  login as apiLogin,
  logout as apiLogout,
  refreshToken as apiRefreshToken,
  type MeOut,
} from '@/lib/api';
import { AUTH_EXPIRED_EVENT } from '@/lib/api/core/request';

interface AuthState {
  user: MeOut | null;
  isLoggedIn: boolean;
  authChecked: boolean;
  loading: boolean;
  error: string | null;
}

interface AuthContextType extends AuthState {
  login: (
    account: string,
    password: string,
    captcha?: { captcha_id?: string; captcha_code?: string },
    rememberMe?: boolean
  ) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  patchCurrentUser: (patch: Partial<MeOut>) => void;
}

const initialAuthState: AuthState = {
  user: null,
  isLoggedIn: false,
  authChecked: false,
  loading: true,
  error: null,
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);
const ACCOUNT_DISABLED_MESSAGE = '账户已被停用，请联系平台运营人员';
const LOGIN_SESSION_NOT_SAVED_MESSAGE = '登录状态未保存，请检查当前访问域名或刷新后重试';

function clearLocalAuth() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('userInfo');
}

function cacheUser(user: MeOut | null) {
  if (!user) {
    localStorage.removeItem('userInfo');
    return;
  }
  localStorage.setItem('userInfo', JSON.stringify(user));
}

function isUnauthorizedError(error: unknown) {
  if (!(error instanceof ApiError)) return false;

  const code = String(error.code || '').toUpperCase();
  const message = String(error.message || '').toLowerCase();

  return (
    code.includes('UNAUTHORIZED') ||
    code.includes('TOKEN') ||
    code.includes('401') ||
    message.includes('unauthorized') ||
    message.includes('token') ||
    message.includes('401')
  );
}

function isDisabledAccountError(error: unknown) {
  if (!(error instanceof ApiError)) return false;

  const code = String(error.code || '').toUpperCase();
  const message = String(error.message || '').toLowerCase();

  return (
    code.includes('USER_DISABLED') ||
    message.includes('账户已被停用') ||
    message.includes('user is disabled') ||
    message.includes('user disabled')
  );
}

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [authState, setAuthState] = useState<AuthState>(initialAuthState);
  const checkingRef = useRef<Promise<void> | null>(null);
  const refreshingRef = useRef<Promise<void> | null>(null);

  const doRefresh = useCallback(async () => {
    if (refreshingRef.current) return refreshingRef.current;

    refreshingRef.current = (async () => {
      await apiRefreshToken();
    })();

    try {
      return await refreshingRef.current;
    } finally {
      refreshingRef.current = null;
    }
  }, []);

  const finishLoggedOut = useCallback((error: string | null = null) => {
    clearLocalAuth();
    cacheUser(null);
    setAuthState({
      user: null,
      isLoggedIn: false,
      authChecked: true,
      loading: false,
      error,
    });
  }, []);

  const checkAuthStatus = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (checkingRef.current) return checkingRef.current;

      checkingRef.current = (async () => {
        const silent = opts?.silent ?? false;

        if (!silent) {
          setAuthState((prev) => ({
            ...prev,
            authChecked: false,
            loading: true,
            error: null,
          }));
        } else {
          setAuthState((prev) => ({ ...prev, error: null }));
        }

        try {
          const user = await getMe();
          cacheUser(user);
          setAuthState({
            user,
            isLoggedIn: true,
            authChecked: true,
            loading: false,
            error: null,
          });
          return;
        } catch (error) {
          if (isDisabledAccountError(error)) {
            const message = error instanceof ApiError ? error.message : ACCOUNT_DISABLED_MESSAGE;
            finishLoggedOut(message || ACCOUNT_DISABLED_MESSAGE);
            return;
          }
          if (!isUnauthorizedError(error)) {
            const message = error instanceof ApiError ? error.message : 'Auth check failed';
            setAuthState((prev) => ({
              ...prev,
              authChecked: true,
              loading: false,
              error: message,
            }));
            return;
          }
        }

        try {
          await doRefresh();
          const user = await getMe();
          cacheUser(user);
          setAuthState({
            user,
            isLoggedIn: true,
            authChecked: true,
            loading: false,
            error: null,
          });
        } catch {
          finishLoggedOut();
        }
      })();

      try {
        await checkingRef.current;
      } finally {
        checkingRef.current = null;
      }
    },
    [doRefresh, finishLoggedOut]
  );

  useEffect(() => {
    checkAuthStatus({ silent: false });

    const timer = setInterval(() => {
      checkAuthStatus({ silent: true });
    }, 5 * 60 * 1000);

    return () => clearInterval(timer);
  }, [checkAuthStatus]);

  const login = useCallback(async (
    account: string,
    password: string,
    captcha?: { captcha_id?: string; captcha_code?: string },
    rememberMe: boolean = false
  ) => {
    setAuthState((prev) => ({
      ...prev,
      error: null,
    }));

    try {
      clearLocalAuth();
      await apiLogin({ account, password, remember_me: rememberMe, ...captcha });
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'Login failed';
      finishLoggedOut(message);
      throw error;
    }

    try {
      const user = await getMe();
      cacheUser(user);
      setAuthState({
        user,
        isLoggedIn: true,
        authChecked: true,
        loading: false,
        error: null,
      });
    } catch (error) {
      console.warn('[Auth] login succeeded but session check failed', error);
      const message = isUnauthorizedError(error)
        ? LOGIN_SESSION_NOT_SAVED_MESSAGE
        : error instanceof ApiError
          ? error.message
          : LOGIN_SESSION_NOT_SAVED_MESSAGE;
      finishLoggedOut(message);
      throw new Error(message);
    }
  }, [finishLoggedOut]);

  const logout = useCallback(async () => {
    setAuthState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      await apiLogout();
    } catch {
      // Local cleanup below is authoritative for the UI.
    } finally {
      finishLoggedOut();
    }
  }, [finishLoggedOut]);

  const refreshUser = useCallback(async () => {
    await checkAuthStatus({ silent: true });
  }, [checkAuthStatus]);

  const patchCurrentUser = useCallback((patch: Partial<MeOut>) => {
    setAuthState((prev) => {
      if (!prev.user) return prev;
      const nextUser: MeOut = {
        ...prev.user,
        ...patch,
        profile: {
          ...(prev.user.profile || {}),
          ...(patch.profile || {}),
        },
      };
      cacheUser(nextUser);
      return {
        ...prev,
        user: nextUser,
      };
    });
  }, []);

  useEffect(() => {
    const handleAuthExpired = () => finishLoggedOut();

    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    return () => window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
  }, [finishLoggedOut]);

  return (
    <AuthContext.Provider
      value={{
        ...authState,
        login,
        logout,
        refreshUser,
        patchCurrentUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = (): AuthContextType => {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider');
  return ctx;
};
