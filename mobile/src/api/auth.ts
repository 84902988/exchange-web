import {apiClient} from './client';

export type TokenOut = {
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  access_expires_in?: number;
};

export type LoginIn = {
  account: string;
  password: string;
  captcha_id?: string;
  captcha_code?: string;
  remember_me?: boolean;
};

export type RegisterIn = {
  email?: string;
  phone?: string;
  otp: string;
  password: string;
  invite_code?: string;
  invite_type?: 'bd' | 'user' | string;
};

export type UserProfile = {
  username?: string | null;
  nickname?: string | null;
  phone?: string | null;
  avatar_url?: string | null;
};

export type MeOut = {
  id: number | string;
  email?: string | null;
  phone?: string | null;
  invite_code?: string | null;
  avatar_url?: string | null;
  profile?: UserProfile | null;
  status?: number;
  created_at?: string | null;
};

export function login(data: LoginIn) {
  return apiClient.post<TokenOut>('/auth/login', data);
}

export function register(data: RegisterIn) {
  return apiClient.post<{message?: string} | TokenOut>('/auth/register', data);
}

export function getMe() {
  return apiClient.get<MeOut>('/me');
}
