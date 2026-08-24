type ResolveChartWebBaseUrlOptions = {
  nativeChartWebBaseUrl?: unknown;
  allowLocalFallback: boolean;
  requireHttps: boolean;
};

const LOCAL_CHART_WEB_BASE_URL = 'http://127.0.0.1:3000';

function normalizeChartOrigin(value: unknown, requireHttps: boolean) {
  if (typeof value !== 'string' || !value.trim()) return '';

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error('Mobile chart URL must be a valid HTTP or HTTPS origin');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Mobile chart URL must use HTTP or HTTPS');
  }
  if (requireHttps && url.protocol !== 'https:') {
    throw new Error('Mobile chart URL must use HTTPS in this build');
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
  const isIpv6 = hostname.includes(':') || hostname.startsWith('[');
  const isLocal =
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local');
  if (requireHttps && (isIpv4 || isIpv6 || isLocal)) {
    throw new Error('Mobile chart URL must use a public HTTPS DNS origin in this build');
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '' && url.pathname !== '/')
  ) {
    throw new Error('Mobile chart URL must be an origin without credentials, path, query, or fragment');
  }

  return url.origin;
}

export function resolveChartWebBaseUrl({
  nativeChartWebBaseUrl,
  allowLocalFallback,
  requireHttps,
}: ResolveChartWebBaseUrlOptions) {
  const configured = normalizeChartOrigin(
    nativeChartWebBaseUrl,
    requireHttps,
  );
  if (configured) return configured;

  if (allowLocalFallback) return LOCAL_CHART_WEB_BASE_URL;

  throw new Error('Mobile chart URL is missing for this build');
}
