const LOCAL_API_BASE_URL = "http://127.0.0.1:8000";
const CPOLAR_IO_API_BASE_URL = "https://moralis-api.cpolar.io";

function getConfiguredApiBaseUrl(): string | null {
  const value = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  return value || null;
}

function isLocalApiBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  } catch {
    return value.includes("127.0.0.1") || value.includes("localhost");
  }
}

function getCpolarIoApiBaseUrl(host: string): string | null {
  if (host === "moralis-hook.zaf.cpolar.io") {
    return CPOLAR_IO_API_BASE_URL;
  }

  if (!host.endsWith(".cpolar.io")) {
    return null;
  }

  if (host.startsWith("moralis-hook.")) {
    return `https://${host.replace(/^moralis-hook\./, "moralis-api.")}`;
  }

  if (host.includes("-hook.")) {
    return `https://${host.replace("-hook.", "-api.")}`;
  }

  return null;
}

export function getRuntimeApiBaseUrl(): string {
  if (typeof window !== "undefined") {
    const host = window.location.hostname;

    if (host === "127.0.0.1" || host === "localhost") {
      return LOCAL_API_BASE_URL;
    }

    const cpolarIoApiBaseUrl = getCpolarIoApiBaseUrl(host);
    if (cpolarIoApiBaseUrl) {
      return cpolarIoApiBaseUrl;
    }

    const configuredApiBaseUrl = getConfiguredApiBaseUrl();
    if (configuredApiBaseUrl && !isLocalApiBaseUrl(configuredApiBaseUrl)) {
      return configuredApiBaseUrl;
    }

    if (host.endsWith(".cpolar.top")) {
      return CPOLAR_IO_API_BASE_URL;
    }
  }

  return getConfiguredApiBaseUrl() || LOCAL_API_BASE_URL;
}

export const getBaseUrl = getRuntimeApiBaseUrl;
