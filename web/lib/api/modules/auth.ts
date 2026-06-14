// lib/api/modules/auth.ts
import { request } from "../core/request";
import { clearTokens, setTokens } from "../core/token";

/** ===== Types ===== */

export interface TokenOut {
  access_token?: string;
  refresh_token?: string;
  token_type: "bearer" | string;
  // 你后端如果有 access_expires_in 也可以加上
  access_expires_in?: number;
}

export interface LoginIn {
  account: string;
  password: string;
  captcha_id?: string;
  captcha_code?: string;
  remember_me?: boolean;
}

export interface LoginCaptchaOut {
  captcha_id: string;
  image: string;
  expires_in?: number;
}

export interface RefreshIn {
  refresh_token?: string;
}

export interface OtpSendIn {
  email?: string;
  phone?: string;
  scene?: "register" | "login" | "reset" | "reset_password" | string;
}

export interface RegisterIn {
  email?: string;
  phone?: string;
  otp: string;
  password: string;
  invite_code?: string;
  invite_type?: "bd" | "user" | string;
}

export interface MeOut {
  id: number | string;
  email?: string | null;
  phone?: string | null;
  invite_code?: string | null;
  avatar_url?: string | null;
  profile?: {
    username?: string | null;
    nickname?: string | null;
    phone?: string | null;
    avatar_url?: string | null;
  } | null;
  status: number;
  created_at?: string | null;
}

/** ===== Helpers ===== */

function clearStoredTokens() {
  clearTokens();
}

/** ===== APIs ===== */

// POST /auth/otp/send
export const sendOtp = (data: OtpSendIn): Promise<{ dev_code?: string; message?: string }> => {
  return request<{ dev_code?: string; message?: string }>("/auth/otp/send", {
    method: "POST",
    body: JSON.stringify(data),
  });
};

// POST /auth/register
// 注意：你后端可能返回 {message} 或直接返回 TokenOut（你原来就是这么写的）
export const register = async (data: RegisterIn): Promise<{ message?: string } | TokenOut> => {
  const res = await request<{ message?: string } | TokenOut>("/auth/register", {
    method: "POST",
    body: JSON.stringify(data),
  });

  if ("access_token" in res || "refresh_token" in res) {
    setTokens(res);
  } else {
    clearStoredTokens();
  }

  return res;
};

// POST /auth/login
export const login = async (data: LoginIn): Promise<TokenOut> => {
  const out = await request<TokenOut>("/auth/login", {
    method: "POST",
    body: JSON.stringify(data),
  });

  setTokens(out);

  return out;
};

// GET /auth/captcha
export const getLoginCaptcha = (): Promise<LoginCaptchaOut> => {
  return request<LoginCaptchaOut>("/auth/captcha", { method: "GET" });
};

// POST /auth/refresh
export const refreshToken = async (): Promise<TokenOut> => {
  const out = await request<TokenOut>("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({} as RefreshIn),
  });

  setTokens(out);

  return out;
};

// POST /auth/logout  ✅ 带 refresh_token
export const logout = async (
  refresh_token?: string
): Promise<{ message?: string; success?: boolean }> => {
  const res = await request<{ message?: string; success?: boolean }>("/auth/logout", {
    method: "POST",
    body: JSON.stringify({ refresh_token: refresh_token ?? "" } as RefreshIn),
  });

  clearStoredTokens();

  return res;
};

// GET /me  ✅ 注意不是 /auth/me
export const getMe = (): Promise<MeOut> => {
  return request<MeOut>("/me", { method: "GET" });
};
