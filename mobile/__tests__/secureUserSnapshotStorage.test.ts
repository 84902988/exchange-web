import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';
import {
  clearSecureUserSnapshot,
  readOrMigrateSecureUserSnapshot,
  readSecureUserSnapshot,
  writeSecureUserSnapshot,
} from '../src/services/secureUserSnapshotStorage';

const keychainMock = Keychain as typeof Keychain & {__resetMock: () => void};
const user = {
  id: 7,
  email: 'mobile@example.com',
  status: 1,
  profile: {nickname: 'Mobile User'},
};

describe('secureUserSnapshotStorage', () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    keychainMock.__resetMock();
    await AsyncStorage.clear();
  });

  it('stores a cached identity in native secure storage only', async () => {
    await writeSecureUserSnapshot(user);
    await expect(readSecureUserSnapshot()).resolves.toEqual(user);
    await expect(AsyncStorage.getItem('userInfo')).resolves.toBeNull();
  });

  it('migrates a legacy plaintext identity only after secure persistence', async () => {
    await AsyncStorage.setItem('userInfo', JSON.stringify(user));
    await expect(readOrMigrateSecureUserSnapshot()).resolves.toEqual(user);
    await expect(AsyncStorage.getItem('userInfo')).resolves.toBeNull();
    await expect(readSecureUserSnapshot()).resolves.toEqual(user);
  });

  it('keeps the legacy identity if its secure migration fails', async () => {
    await AsyncStorage.setItem('userInfo', JSON.stringify(user));
    jest.mocked(Keychain.setGenericPassword).mockResolvedValueOnce(false);
    await expect(readOrMigrateSecureUserSnapshot()).rejects.toThrow(
      '无法安全保存账户资料',
    );
    await expect(AsyncStorage.getItem('userInfo')).resolves.toBe(
      JSON.stringify(user),
    );
  });

  it('rejects malformed or oversized snapshots and clears invalid legacy data', async () => {
    await expect(writeSecureUserSnapshot(['not-a-user'])).rejects.toThrow(
      '无法安全保存账户资料',
    );
    await AsyncStorage.setItem('userInfo', '{invalid');
    await expect(readOrMigrateSecureUserSnapshot()).resolves.toBeNull();
    await expect(AsyncStorage.getItem('userInfo')).resolves.toBeNull();
  });

  it('clears the secure identity during logout', async () => {
    await writeSecureUserSnapshot(user);
    await clearSecureUserSnapshot();
    await expect(readSecureUserSnapshot()).resolves.toBeNull();
  });
});
