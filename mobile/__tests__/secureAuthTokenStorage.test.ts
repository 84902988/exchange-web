import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import {
  AUTH_LOGOUT_PENDING_KEY,
  clearAuthTokensForLogout,
  clearSecureAuthTokens,
  readOrMigrateAuthTokens,
  readSecureAuthTokens,
  writeSecureAuthTokens,
} from '../src/services/secureAuthTokenStorage';

const keychainMock = Keychain as typeof Keychain & {__resetMock: () => void};

describe('secureAuthTokenStorage', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    keychainMock.__resetMock();
    await AsyncStorage.clear();
  });

  it('stores tokens in native secure storage instead of AsyncStorage', async () => {
    await writeSecureAuthTokens({
      accessToken: 'access-secure',
      refreshToken: 'refresh-secure',
    });

    await expect(readSecureAuthTokens()).resolves.toEqual({
      accessToken: 'access-secure',
      refreshToken: 'refresh-secure',
    });
    await expect(
      AsyncStorage.getMany(['access_token', 'refresh_token']),
    ).resolves.toEqual({access_token: null, refresh_token: null});
  });

  it('migrates legacy plaintext only after a successful secure write', async () => {
    await AsyncStorage.setMany({
      access_token: 'access-legacy',
      refresh_token: 'refresh-legacy',
    });

    await expect(readOrMigrateAuthTokens()).resolves.toEqual({
      accessToken: 'access-legacy',
      refreshToken: 'refresh-legacy',
    });
    await expect(
      AsyncStorage.getMany(['access_token', 'refresh_token']),
    ).resolves.toEqual({access_token: null, refresh_token: null});
    await expect(readSecureAuthTokens()).resolves.toEqual({
      accessToken: 'access-legacy',
      refreshToken: 'refresh-legacy',
    });
  });

  it('keeps legacy plaintext when secure migration fails', async () => {
    await AsyncStorage.setMany({
      access_token: 'access-legacy',
      refresh_token: 'refresh-legacy',
    });
    jest.mocked(Keychain.setGenericPassword).mockResolvedValueOnce(false);

    await expect(readOrMigrateAuthTokens()).rejects.toThrow('无法安全保存登录状态');
    await expect(
      AsyncStorage.getMany(['access_token', 'refresh_token']),
    ).resolves.toEqual({
      access_token: 'access-legacy',
      refresh_token: 'refresh-legacy',
    });
  });

  it('removes the native secret on logout cleanup', async () => {
    await writeSecureAuthTokens({
      accessToken: 'access-secure',
      refreshToken: 'refresh-secure',
    });
    await clearSecureAuthTokens();
    await expect(readSecureAuthTokens()).resolves.toEqual({
      accessToken: null,
      refreshToken: null,
    });
  });

  it('prevents session resurrection when native logout cleanup initially fails', async () => {
    await writeSecureAuthTokens({
      accessToken: 'access-secure',
      refreshToken: 'refresh-secure',
    });
    jest
      .mocked(Keychain.resetGenericPassword)
      .mockRejectedValueOnce(new Error('keystore temporarily unavailable'));

    await expect(clearAuthTokensForLogout()).rejects.toThrow(
      'keystore temporarily unavailable',
    );
    await expect(AsyncStorage.getItem(AUTH_LOGOUT_PENDING_KEY)).resolves.toBe(
      '1',
    );

    await expect(readOrMigrateAuthTokens()).resolves.toEqual({
      accessToken: null,
      refreshToken: null,
    });
    await expect(AsyncStorage.getItem(AUTH_LOGOUT_PENDING_KEY)).resolves.toBeNull();
    await expect(readSecureAuthTokens()).resolves.toEqual({
      accessToken: null,
      refreshToken: null,
    });
  });
});
