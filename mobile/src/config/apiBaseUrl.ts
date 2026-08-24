export type ApiBaseUrlPlatform = 'android' | 'ios' | string;

type ResolveApiBaseUrlOptions = {
  platform: ApiBaseUrlPlatform;
  nativeApiBaseUrl?: unknown;
  allowLocalFallback: boolean;
  requireHttps: boolean;
};

const LOCAL_ANDROID_API_BASE_URL = 'http://10.0.2.2:8000';
const LOCAL_DEFAULT_API_BASE_URL = 'http://127.0.0.1:8000';

function normalizeApiBaseUrl(value: unknown) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .replace(/^https?:\/\//i, scheme => scheme.toLowerCase())
    .replace(/\/+$/, '');
}

function validateApiBaseUrl(value: string, requireHttps: boolean) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Mobile API base URL must be a valid HTTP or HTTPS URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Mobile API base URL must use HTTP or HTTPS');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      'Mobile API base URL must not contain credentials, query, or fragment',
    );
  }
  if (requireHttps && url.protocol !== 'https:') {
    throw new Error('Mobile API base URL must use HTTPS in this build');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
  const isIpv6 = hostname.includes(':') || hostname.startsWith('[');
  const isLocal =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local');
  if (requireHttps && (isIpv4 || isIpv6 || isLocal)) {
    throw new Error(
      'Mobile API base URL must use a public HTTPS DNS endpoint in this build',
    );
  }
  return url.toString().replace(/\/+$/, '');
}

export function resolveApiBaseUrl({
  platform,
  nativeApiBaseUrl,
  allowLocalFallback,
  requireHttps,
}: ResolveApiBaseUrlOptions) {
  const configured = normalizeApiBaseUrl(nativeApiBaseUrl);
  if (configured) {
    return validateApiBaseUrl(configured, requireHttps);
  }

  if (allowLocalFallback) {
    return platform === 'android'
      ? LOCAL_ANDROID_API_BASE_URL
      : LOCAL_DEFAULT_API_BASE_URL;
  }

  throw new Error('Mobile API base URL is missing for this build');
}
