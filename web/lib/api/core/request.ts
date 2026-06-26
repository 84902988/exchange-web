import { ApiResponse } from "./types";
import { ApiError } from "./error";
import { getRuntimeApiBaseUrl } from "./baseUrl";
import { getAccessToken, getRefreshToken, setTokens } from "./token";

export const AUTH_EXPIRED_EVENT = "app:auth-expired";

function joinUrl(base: string, path: string) {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return `${b}${p}`;
}

function isAuthExpiredError(status: number, code: string, message: string) {
  if (status !== 401) return false;

  const normalizedCode = (code || "").toUpperCase();
  const normalizedMessage = (message || "").toLowerCase();

  return (
    normalizedCode.includes("UNAUTHORIZED") ||
    normalizedCode.includes("TOKEN") ||
    normalizedMessage.includes("unauthorized") ||
    normalizedMessage.includes("missing access token") ||
    normalizedMessage.includes("invalid or expired access token") ||
    normalizedMessage.includes("invalid token type") ||
    normalizedMessage.includes("invalid token payload") ||
    normalizedMessage.includes("refresh token revoked") ||
    normalizedMessage.includes("missing refresh token") ||
    normalizedMessage.includes("invalid or expired refresh token")
  );
}

function isAccountDisabledError(status: number, code: string, message: string) {
  if (status !== 403) return false;

  const normalizedCode = (code || "").toUpperCase();
  const normalizedMessage = (message || "").toLowerCase();

  return (
    normalizedCode.includes("USER_DISABLED") ||
    normalizedMessage.includes("账户已被停用") ||
    normalizedMessage.includes("user is disabled") ||
    normalizedMessage.includes("user disabled")
  );
}

function broadcastAuthExpired() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT));
}

function isObjectBody(body: unknown): body is Record<string, unknown> {
  return (
    typeof body === "object" &&
    body !== null &&
    !(body instanceof FormData) &&
    !(body instanceof Blob) &&
    !(body instanceof ArrayBuffer)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

// ====== Refresh 并发控制：同一时间只发一次 refresh ======
let refreshPromise: Promise<boolean> | null = null;

type RefreshTokenPayload = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  access_expires_in?: number;
};

function extractRefreshTokenPayload(payload: unknown): RefreshTokenPayload | null {
  if (!isRecord(payload)) return null;

  const rootAccessToken = readString(payload.access_token);
  const rootRefreshToken = readString(payload.refresh_token);
  if (rootAccessToken || rootRefreshToken) {
    return {
      access_token: rootAccessToken,
      refresh_token: rootRefreshToken,
      token_type: readString(payload.token_type),
      access_expires_in:
        typeof payload.access_expires_in === "number" ? payload.access_expires_in : undefined,
    };
  }

  const data = payload.data;
  if (!isRecord(data)) return null;

  const accessToken = readString(data.access_token);
  const refreshToken = readString(data.refresh_token);
  if (!accessToken && !refreshToken) return null;

  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: readString(data.token_type),
    access_expires_in:
      typeof data.access_expires_in === "number" ? data.access_expires_in : undefined,
  };
}

async function refreshSession(baseUrl: string): Promise<boolean> {
  // 你后端 refresh 路径按你项目改：
  // 常见：/auth/refresh 或 /auth/token/refresh
  const refreshUrl = joinUrl(baseUrl, "/auth/refresh");
  const refreshToken = getRefreshToken();

  try {
    const resp = await fetch(refreshUrl, {
      method: "POST",
      credentials: "include", // ✅ refresh_token 是 HttpOnly cookie
      headers: {
        "Content-Type": "application/json",
      },
      // 如果你后端要求 body，就给一个空对象；不需要就删掉
      body: JSON.stringify(refreshToken ? { refresh_token: refreshToken } : {}),
      cache: "no-store",
    });

    if (!resp.ok) return false;

    const data = (await resp.json()) as ApiResponse<RefreshTokenPayload> | RefreshTokenPayload;
    const tokens = extractRefreshTokenPayload(data);
    if (tokens) {
      setTokens(tokens);
    }

    return isRecord(data) && "ok" in data ? data.ok === true : Boolean(tokens);
  } catch {
    return false;
  }
}

function parseApiErrorFromResponsePayload(payload: unknown, httpStatus: number, httpStatusText: string) {
  let errorMessage = `HTTP Error ${httpStatus}: ${httpStatusText}`;
  let errorCode = "HTTP_ERROR";
  let traceId = "local-trace-" + Date.now();
  let errorData: Record<string, unknown> | undefined;
  const root = isRecord(payload) ? payload : null;

  // 兼容你们 ApiResponse
  const apiError = root && isRecord(root.error) ? root.error : null;
  if (apiError) {
    errorMessage = readString(apiError.message) || errorMessage;
    errorCode = readString(apiError.code) || errorCode;
    traceId = readString(root?.trace_id) || traceId;
    errorData = { ...apiError };
    return { errorMessage, errorCode, traceId, errorData };
  }

  // 兼容 FastAPI 原生 detail
  const detail = root?.detail;
  if (detail) {
    if (typeof detail === "string") {
      errorMessage = detail;
    } else if (isRecord(detail)) {
      errorMessage = readString(detail.message) || errorMessage;
      errorCode = readString(detail.code) || errorCode;
      errorData = { ...detail };
    }
    traceId = readString(root?.trace_id) || traceId;
    return { errorMessage, errorCode, traceId, errorData };
  }

  return { errorMessage, errorCode, traceId, errorData };
}

export const request = async <T>(
  path: string,
  options: RequestInit = {},
  retryCount: number = 0,
  maxRetries: number = 1,
  _internal?: { retriedAfterRefresh?: boolean } // 防止无限 refresh 重试
): Promise<T> => {
  const baseUrl = getRuntimeApiBaseUrl();
  const url = joinUrl(baseUrl, path);

  try {
    const headers = new Headers(options.headers || {});

    const isFormData =
      typeof FormData !== "undefined" && options.body instanceof FormData;

    const hasBody = options.body !== undefined && options.body !== null;

    // ✅ 只有有 body 且不是 FormData 才设置 JSON Content-Type
    if (hasBody && !isFormData && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }

    const accessToken = getAccessToken();
    if (accessToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${accessToken}`);
    }

    // ✅（可选）CSRF 预留：如果你后端做了 CSRF（双重提交），这里带上 header
    // const csrf = getCookie("csrf_token"); // 你可自行实现 getCookie
    // if (csrf && !headers.has("X-CSRF-Token")) headers.set("X-CSRF-Token", csrf);

    // ✅ 如果 body 是普通对象，自动 JSON.stringify
    let body = options.body;
    if (hasBody && !isFormData && isObjectBody(body)) {
      body = JSON.stringify(body);
    }

    const response = await fetch(url, {
      ...options,
      headers,
      body,
      cache: "no-store",
      credentials: "include", // ✅ 关键：让浏览器存/带 HttpOnly Cookie
    });

    // ====== 关键：401 自动 refresh 再重放（大所 Web 常见） ======
    const canRefreshAfter401 = !["/auth/login", "/auth/refresh"].includes(path);
    if (response.status === 401 && canRefreshAfter401 && !_internal?.retriedAfterRefresh) {
      // 同一时间只发一次 refresh
      if (!refreshPromise) {
        refreshPromise = refreshSession(baseUrl).finally(() => {
          refreshPromise = null;
        });
      }
      const ok = await refreshPromise;

      if (ok) {
        // refresh 成功：重放原请求（只重放一次）
        return request<T>(path, options, retryCount, maxRetries, {
          retriedAfterRefresh: true,
        });
      }
      // refresh 失败：继续走下面的错误解析（抛 401）
    }

    // ====== 非 2xx：解析错误 ======
    if (!response.ok) {
      let payload: unknown = null;
      try {
        payload = await response.json();
      } catch {
        // ignore
      }

      const { errorMessage, errorCode, traceId, errorData } = parseApiErrorFromResponsePayload(
        payload,
        response.status,
        response.statusText
      );

      if (
        isAuthExpiredError(response.status, errorCode, errorMessage) ||
        isAccountDisabledError(response.status, errorCode, errorMessage)
      ) {
        broadcastAuthExpired();
      }

      throw new ApiError(errorMessage, errorCode, traceId, undefined, errorData);
    }

    const data = await response.json();

    const isApiEnvelope =
      typeof data === "object" &&
      data !== null &&
      "ok" in data &&
      "data" in data;

    if (!isApiEnvelope) {
      return data as T;
    }

    const envelope = data as ApiResponse<T>;

    if (!envelope.ok) {
      throw new ApiError(
        envelope.error?.message || "Unknown error",
        envelope.error?.code || "INTERNAL_ERROR",
        envelope.trace_id || ("local-trace-" + Date.now()),
        undefined,
        envelope.error ? { ...envelope.error } : undefined
      );
    }

    return envelope.data as T;
  } catch (error) {
    // 网络重试（保留你原逻辑）
    if (
      retryCount < maxRetries &&
      ((error instanceof ApiError && error.code === "NETWORK_ERROR") ||
        error instanceof TypeError)
    ) {
      await new Promise((resolve) =>
        setTimeout(resolve, 1000 * Math.pow(2, retryCount))
      );
      return request(path, options, retryCount + 1, maxRetries, _internal);
    }

    if (error instanceof ApiError) throw error;

    throw new ApiError(
      error instanceof Error ? error.message : "Network error",
      "NETWORK_ERROR",
      "local-trace-" + Date.now(),
      error instanceof Error ? error : undefined
    );
  }
};
