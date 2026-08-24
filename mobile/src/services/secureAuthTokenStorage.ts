import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

export type StoredAuthTokens = {
  accessToken: string | null;
  refreshToken: string | null;
};

const KEYCHAIN_SERVICE = 'com.exchangemobile.auth.tokens.v1';
const KEYCHAIN_USERNAME = 'mobile-session';
export const LEGACY_ACCESS_TOKEN_KEY = 'access_token';
export const LEGACY_REFRESH_TOKEN_KEY = 'refresh_token';
export const AUTH_LOGOUT_PENDING_KEY = 'auth_logout_pending_v1';
const MAX_TOKEN_LENGTH = 16 * 1024;

function normalizeToken(value: unknown) {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  return token && token.length <= MAX_TOKEN_LENGTH ? token : null;
}

function parseStoredTokens(value: string): StoredAuthTokens | null {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    const tokens = {
      accessToken: normalizeToken(parsed.accessToken),
      refreshToken: normalizeToken(parsed.refreshToken),
    };
    return tokens.accessToken || tokens.refreshToken ? tokens : null;
  } catch {
    return null;
  }
}

export async function readSecureAuthTokens(): Promise<StoredAuthTokens> {
  const credentials = await Keychain.getGenericPassword({
    service: KEYCHAIN_SERVICE,
  });
  if (!credentials) return {accessToken: null, refreshToken: null};
  if (credentials.username !== KEYCHAIN_USERNAME) {
    await Keychain.resetGenericPassword({service: KEYCHAIN_SERVICE});
    return {accessToken: null, refreshToken: null};
  }
  const tokens = parseStoredTokens(credentials.password);
  if (!tokens) {
    await Keychain.resetGenericPassword({service: KEYCHAIN_SERVICE});
    return {accessToken: null, refreshToken: null};
  }
  return tokens;
}

export async function writeSecureAuthTokens(tokens: StoredAuthTokens) {
  const normalized = {
    accessToken: normalizeToken(tokens.accessToken),
    refreshToken: normalizeToken(tokens.refreshToken),
  };
  if (!normalized.accessToken && !normalized.refreshToken) {
    await clearSecureAuthTokens();
    return;
  }
  const result = await Keychain.setGenericPassword(
    KEYCHAIN_USERNAME,
    JSON.stringify(normalized),
    {
      service: KEYCHAIN_SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    },
  );
  if (!result) {
    throw new Error('无法安全保存登录状态');
  }
  // A completed secure write starts a new authenticated session. If removing
  // the marker fails, the next launch deliberately fails closed and clears
  // these credentials instead of restoring a possibly logged-out session.
  await AsyncStorage.removeItem(AUTH_LOGOUT_PENDING_KEY);
}

export async function clearSecureAuthTokens() {
  await Keychain.resetGenericPassword({service: KEYCHAIN_SERVICE});
}

export async function clearAuthTokensForLogout() {
  try {
    await AsyncStorage.setItem(AUTH_LOGOUT_PENDING_KEY, '1');
  } catch (markerError) {
    // Still attempt the authoritative secret removal when marker persistence
    // is unavailable. Propagate the marker error so callers do not mistake
    // this degraded path for a fully verified cleanup.
    await clearSecureAuthTokens();
    await AsyncStorage.removeMany([
      LEGACY_ACCESS_TOKEN_KEY,
      LEGACY_REFRESH_TOKEN_KEY,
    ]);
    throw markerError;
  }

  await clearSecureAuthTokens();
  await AsyncStorage.removeMany([
    LEGACY_ACCESS_TOKEN_KEY,
    LEGACY_REFRESH_TOKEN_KEY,
    AUTH_LOGOUT_PENDING_KEY,
  ]);
}

export async function readOrMigrateAuthTokens(): Promise<StoredAuthTokens> {
  const logoutPending = await AsyncStorage.getItem(AUTH_LOGOUT_PENDING_KEY);
  if (logoutPending) {
    // A previous logout could not prove that native credentials were removed.
    // Never restore that session; finish cleanup before reading any token.
    await clearSecureAuthTokens();
    await AsyncStorage.removeMany([
      LEGACY_ACCESS_TOKEN_KEY,
      LEGACY_REFRESH_TOKEN_KEY,
      AUTH_LOGOUT_PENDING_KEY,
    ]);
    return {accessToken: null, refreshToken: null};
  }

  const secureTokens = await readSecureAuthTokens();
  if (secureTokens.accessToken || secureTokens.refreshToken) {
    await AsyncStorage.removeMany([
      LEGACY_ACCESS_TOKEN_KEY,
      LEGACY_REFRESH_TOKEN_KEY,
    ]);
    return secureTokens;
  }

  const legacy = await AsyncStorage.getMany([
    LEGACY_ACCESS_TOKEN_KEY,
    LEGACY_REFRESH_TOKEN_KEY,
  ]);
  const legacyTokens = {
    accessToken: normalizeToken(legacy[LEGACY_ACCESS_TOKEN_KEY]),
    refreshToken: normalizeToken(legacy[LEGACY_REFRESH_TOKEN_KEY]),
  };
  if (!legacyTokens.accessToken && !legacyTokens.refreshToken) {
    return legacyTokens;
  }

  // Remove plaintext only after the native secure write succeeds.
  await writeSecureAuthTokens(legacyTokens);
  await AsyncStorage.removeMany([
    LEGACY_ACCESS_TOKEN_KEY,
    LEGACY_REFRESH_TOKEN_KEY,
  ]);
  return legacyTokens;
}
