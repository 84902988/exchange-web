import {Platform} from 'react-native';

const LOCAL_ANDROID_API_BASE_URL = 'http://10.0.2.2:8000';
const LOCAL_DEFAULT_API_BASE_URL = 'http://127.0.0.1:8000';

export const API_BASE_URL =
  Platform.OS === 'android'
    ? LOCAL_ANDROID_API_BASE_URL
    : LOCAL_DEFAULT_API_BASE_URL;

export const API_TIMEOUT_MS = 15000;
