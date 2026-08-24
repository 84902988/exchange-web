import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Keychain from 'react-native-keychain';

const KEYCHAIN_SERVICE = 'com.exchangemobile.auth.user.v1';
const KEYCHAIN_USERNAME = 'mobile-user';
export const LEGACY_USER_SNAPSHOT_KEY = 'userInfo';
const MAX_USER_SNAPSHOT_BYTES = 64 * 1024;

export type StoredUserSnapshot = Record<string, unknown>;

function normalizeSnapshot(value: unknown): StoredUserSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  try {
    const serialized = JSON.stringify(value);
    return serialized.length <= MAX_USER_SNAPSHOT_BYTES
      ? (value as StoredUserSnapshot)
      : null;
  } catch {
    return null;
  }
}

function parseSnapshot(value: string) {
  if (!value || value.length > MAX_USER_SNAPSHOT_BYTES) return null;
  try {
    return normalizeSnapshot(JSON.parse(value));
  } catch {
    return null;
  }
}

export async function readSecureUserSnapshot() {
  const credentials = await Keychain.getGenericPassword({
    service: KEYCHAIN_SERVICE,
  });
  if (!credentials) return null;
  if (credentials.username !== KEYCHAIN_USERNAME) {
    await clearSecureUserSnapshot();
    return null;
  }
  const snapshot = parseSnapshot(credentials.password);
  if (!snapshot) {
    await clearSecureUserSnapshot();
    return null;
  }
  return snapshot;
}

export async function writeSecureUserSnapshot(value: unknown) {
  const snapshot = normalizeSnapshot(value);
  if (!snapshot) {
    throw new Error('无法安全保存账户资料');
  }
  const result = await Keychain.setGenericPassword(
    KEYCHAIN_USERNAME,
    JSON.stringify(snapshot),
    {
      service: KEYCHAIN_SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    },
  );
  if (!result) {
    throw new Error('无法安全保存账户资料');
  }
  await AsyncStorage.removeItem(LEGACY_USER_SNAPSHOT_KEY);
}

export async function clearSecureUserSnapshot() {
  await Keychain.resetGenericPassword({service: KEYCHAIN_SERVICE});
}

export async function readOrMigrateSecureUserSnapshot() {
  const secureSnapshot = await readSecureUserSnapshot();
  if (secureSnapshot) {
    await AsyncStorage.removeItem(LEGACY_USER_SNAPSHOT_KEY);
    return secureSnapshot;
  }

  const legacyRaw = await AsyncStorage.getItem(LEGACY_USER_SNAPSHOT_KEY);
  if (!legacyRaw) return null;
  const legacySnapshot = parseSnapshot(legacyRaw);
  if (!legacySnapshot) {
    await AsyncStorage.removeItem(LEGACY_USER_SNAPSHOT_KEY);
    return null;
  }

  // Preserve the plaintext fallback until the native secure write succeeds.
  await writeSecureUserSnapshot(legacySnapshot);
  return legacySnapshot;
}
