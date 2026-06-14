// lib/core/token.ts
export type TokenPair = {
  access_token: string;
  refresh_token: string;
};

const ACCESS_KEY = "access_token";
const REFRESH_KEY = "refresh_token";

export function getAccessToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(ACCESS_KEY);
}

export function getRefreshToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(REFRESH_KEY);
}

export function setTokens(tokens: Partial<TokenPair> | null | undefined) {
  if (typeof window === "undefined" || !tokens) return;

  if (tokens.access_token) {
    localStorage.setItem(ACCESS_KEY, tokens.access_token);
  }
  if (tokens.refresh_token) {
    localStorage.setItem(REFRESH_KEY, tokens.refresh_token);
  }
}

export function clearTokens() {
  if (typeof window === "undefined") return;
  localStorage.removeItem(ACCESS_KEY);
  localStorage.removeItem(REFRESH_KEY);
}
