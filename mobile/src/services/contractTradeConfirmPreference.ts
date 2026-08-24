import AsyncStorage from '@react-native-async-storage/async-storage';

export const CONTRACT_TRADE_CONFIRM_HIDDEN_STORAGE_KEY =
  '@exchange-mobile/preferences/contract-trade-confirm-hidden/v2';
export const CONTRACT_CLOSE_ALL_CONFIRM_HIDDEN_STORAGE_KEY =
  '@exchange-mobile/preferences/contract-close-all-confirm-hidden/v1';

export async function loadContractTradeConfirmHidden() {
  try {
    return (
      (await AsyncStorage.getItem(
        CONTRACT_TRADE_CONFIRM_HIDDEN_STORAGE_KEY,
      )) === '1'
    );
  } catch {
    return false;
  }
}

export async function saveContractTradeConfirmHidden(hidden: boolean) {
  try {
    await AsyncStorage.setItem(
      CONTRACT_TRADE_CONFIRM_HIDDEN_STORAGE_KEY,
      hidden ? '1' : '0',
    );
  } catch {
    // This preference is optional. Keep the current in-memory choice if the
    // device storage is temporarily unavailable.
  }
}

export async function loadContractCloseAllConfirmHidden() {
  try {
    return (
      (await AsyncStorage.getItem(
        CONTRACT_CLOSE_ALL_CONFIRM_HIDDEN_STORAGE_KEY,
      )) === '1'
    );
  } catch {
    return false;
  }
}

export async function saveContractCloseAllConfirmHidden(hidden: boolean) {
  try {
    await AsyncStorage.setItem(
      CONTRACT_CLOSE_ALL_CONFIRM_HIDDEN_STORAGE_KEY,
      hidden ? '1' : '0',
    );
  } catch {
    // This preference is optional. Keep the current in-memory choice if the
    // device storage is temporarily unavailable.
  }
}
