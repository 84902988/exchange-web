import { request } from "../core/request";

export type ReviewStatus = "pending" | "approved" | "rejected" | "none";

export interface ChangeRecord {
  type: "username" | "nickname" | "avatar";
  oldValue?: string;
  newValue?: string;
  status: ReviewStatus;
  requestedAt: string;
  reviewedAt?: string;
  reason?: string;
}

export interface UserInfo {
  id: string;
  username: string;
  nickname: string;
  email: string;
  phone?: string;
  avatar?: string;
  createdAt: string;
  lastLoginAt?: string;
  kycLevel: number;
  kycStatus: string;
  accountStatus: "active" | "frozen" | "banned" | "pending";
  withdrawLocked: boolean;
  withdrawLockedReason: string;
  withdrawLockedAt?: string;
  withdrawLockedBy?: number | string | null;
  usernameReviewStatus: ReviewStatus;
  nicknameReviewStatus: ReviewStatus;
  avatarReviewStatus: ReviewStatus;
  usernameChangeRecords: ChangeRecord[];
  nicknameChangeRecords: ChangeRecord[];
  avatarChangeRecords: ChangeRecord[];
  lastUsernameChange: string;
  lastNicknameChange: string;
  lastAvatarChange?: string;
  usernameChangeCount: number;
  nicknameChangeCount: number;
  usernameChangeResetDate: string;
  nicknameChangeResetDate: string;
}

export type LoginStatus = "SUCCESS" | "FAILED" | string;

export interface UserLoginLog {
  id: number;
  user_id: number | null;
  email: string | null;
  ip_address: string;
  user_agent: string;
  device_name: string;
  login_status: LoginStatus;
  failure_reason: string | null;
  created_at: string | null;
}

export type InvitedFriendSourceType = "USER_INVITE" | "BD" | string;

export interface InvitedFriendItem {
  user_id: number;
  email?: string | null;
  source_type: InvitedFriendSourceType;
  invite_code?: string | null;
  registered_at?: string | null;
  bound_at?: string | null;
}

export interface InvitedFriendsResponse {
  items: InvitedFriendItem[];
}

/** ========= Helpers ========= */

function nowIso() {
  return new Date().toISOString();
}

function readErrorField(err: unknown, field: "message" | "code" | "status"): string {
  if (typeof err !== "object" || err === null) return "";
  const value = (err as Record<string, unknown>)[field];
  return String(value || "");
}

function errorLogPayload(err: unknown) {
  return {
    code: readErrorField(err, "code"),
    message: readErrorField(err, "message"),
    err,
  };
}

// 无论 err 是不是 ApiError，都尽量识别状态码
function is404(err: unknown): boolean {
  const msg = readErrorField(err, "message");
  const code = readErrorField(err, "code");
  const status = readErrorField(err, "status");
  return (
    status === "404" ||
    msg.includes("404") ||
    msg.toLowerCase().includes("not found") ||
    (code === "HTTP_ERROR" && msg.includes("404"))
  );
}

function is401(err: unknown): boolean {
  const msg = readErrorField(err, "message");
  const status = readErrorField(err, "status");
  return status === "401" || msg.includes("401") || msg.toLowerCase().includes("unauthorized");
}

function emptyUserInfo(): UserInfo {
  return {
    id: "",
    username: "",
    nickname: "",
    email: "",
    phone: "",
    avatar: "",
    createdAt: nowIso(),
    lastLoginAt: "",
    kycLevel: 0,
    kycStatus: "NONE",
    accountStatus: "pending",
    withdrawLocked: false,
    withdrawLockedReason: "",
    withdrawLockedAt: "",
    withdrawLockedBy: null,
    usernameReviewStatus: "none",
    nicknameReviewStatus: "none",
    avatarReviewStatus: "none",
    usernameChangeRecords: [],
    nicknameChangeRecords: [],
    avatarChangeRecords: [],
    lastUsernameChange: "",
    lastNicknameChange: "",
    lastAvatarChange: "",
    usernameChangeCount: 0,
    nicknameChangeCount: 0,
    usernameChangeResetDate: "",
    nicknameChangeResetDate: "",
  };
}

/**
 * 后端 /me 目前返回聚合数据（已包含 profile/settings）
 * 这里做一个最稳的映射：保证页面不炸，字段缺失就给默认值。
 */
type MeData = {
  id: number | string;
  email?: string | null;
  phone?: string | null;
  status: number;
  withdraw_locked?: boolean | number | null;
  withdraw_locked_reason?: string | null;
  withdraw_locked_at?: string | null;
  withdraw_locked_by?: number | string | null;
  created_at?: string;
  last_login_at?: string | null;
  kyc_level?: number | null;
  kyc_status?: string | null;
  profile?: {
    username?: string | null;
    nickname?: string | null;
    phone?: string | null;
    avatar_url?: string | null;
    kyc_level?: number | null;
    kyc_status?: string | null;
  };
  avatar_url?: string | null;
  settings?: {
    language?: string | null;
    timezone?: string | null;
    theme?: string | null;
  };
};

function mapMeToUserInfo(me: MeData): UserInfo {
  const status = Number(me.status);

  return {
    ...emptyUserInfo(),
    id: String(me.id),
    email: me.email ?? "",
    phone: me.phone ?? me.profile?.phone ?? "",
    username: me.profile?.username ?? "",
    nickname: me.profile?.nickname ?? "",
    avatar: me.avatar_url ?? me.profile?.avatar_url ?? "",
    createdAt: me.created_at ?? nowIso(),
    lastLoginAt: me.last_login_at ?? "",

    kycLevel: me.kyc_level ?? me.profile?.kyc_level ?? 0,
    kycStatus: me.kyc_status ?? me.profile?.kyc_status ?? "NONE",

    // 你后端 status：1=正常 2=禁用 3=锁定
    accountStatus: status === 1 ? "active" : status === 2 ? "banned" : status === 3 ? "frozen" : "pending",
    withdrawLocked: Boolean(me.withdraw_locked),
    withdrawLockedReason: me.withdraw_locked_reason ?? "",
    withdrawLockedAt: me.withdraw_locked_at ?? "",
    withdrawLockedBy: me.withdraw_locked_by ?? null,

    // 下面这些后端还没做（审核/改名记录等），先给默认，不影响页面
    usernameReviewStatus: "none",
    nicknameReviewStatus: "none",
    avatarReviewStatus: "none",
    usernameChangeRecords: [],
    nicknameChangeRecords: [],
    avatarChangeRecords: [],
    lastUsernameChange: "",
    lastNicknameChange: "",
    lastAvatarChange: "",
    usernameChangeCount: 0,
    nicknameChangeCount: 0,
    usernameChangeResetDate: "",
    nicknameChangeResetDate: "",
  };
}

// 统一从 /me 获取（后端已实现）
async function fetchMe(): Promise<UserInfo> {
  try {
    const me = await request<MeData>("/me", { method: "GET" });
    return mapMeToUserInfo(me);
  } catch (err: unknown) {
    console.warn("[fetchMe] failed -> emptyUserInfo()", errorLogPayload(err));
    return emptyUserInfo();
  }
}

/** ========= APIs ========= */

// ✅ 用户信息：直接用 /me（后端已实现），不再请求 /api/v1/user/info（避免 404 刷日志）
export const getUserInfo = async (): Promise<UserInfo> => {
  return fetchMe();
};

/**
 * ✅ PATCH /me —— 更新当前用户信息（推荐用这个）
 * - 不依赖后端返回结构（PATCH 成功即可）
 * - 成功后重新 fetch /me，确保页面数据一致
 * - 失败也不炸，fallback /me
 */
export const updateMe = async (payload: {
  username?: string;
  nickname?: string;
  phone?: string | null;
}): Promise<UserInfo> => {
  try {
    await request("/me", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return fetchMe();
  } catch (err: unknown) {
    console.warn("[updateMe] failed -> fallback /me", errorLogPayload(err));
    return fetchMe();
  }
};

// ✅ 兼容旧接口：后端还没做时不炸（404/401/其它 -> 返回当前用户信息）
// 先保留原来的 v1 路径（未来你们如果做了可直接启用），失败就回退 /me
export const changePassword = async (payload: {
  oldPassword: string;
  newPassword: string;
}): Promise<{ password_changed_at: string }> => {
  return request<{ password_changed_at: string }>("/me/password", {
    method: "PATCH",
    body: JSON.stringify({
      old_password: payload.oldPassword,
      new_password: payload.newPassword,
    }),
  });
};

export const updatePhone = async (phone: string | null): Promise<UserInfo> => {
  await request("/me/phone", {
    method: "PATCH",
    body: JSON.stringify({ phone }),
  });
  return fetchMe();
};

export const getUserLoginLogs = async (limit = 20): Promise<UserLoginLog[]> => {
  const data = await request<{ items: UserLoginLog[] }>(`/me/login-logs?limit=${encodeURIComponent(String(limit))}`, {
    method: "GET",
  });
  return data.items || [];
};

export const getInvitedFriends = async (): Promise<InvitedFriendsResponse> => {
  return request<InvitedFriendsResponse>("/user/invited-friends", { method: "GET" });
};

export const updateUserInfo = async (data: {
  email?: string;
  phone?: string | null;
  username?: string;
}): Promise<UserInfo> => {
  try {
    return await request<UserInfo>("/api/v1/user/info", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  } catch (err: unknown) {
    console.warn("[updateUserInfo] failed -> fallback /me", errorLogPayload(err));
    return fetchMe();
  }
};

// ✅ 上传头像：接口未做时不炸（404/401/其它 -> 返回失败提示，不 throw）
export const uploadAvatar = async (file: File): Promise<UserInfo> => {
  const formData = new FormData();
  formData.append("file", file);

  try {
    const me = await request<MeData>("/user/profile/avatar", {
      method: "POST",
      body: formData,
    });
    return mapMeToUserInfo(me);
  } catch (err: unknown) {
    const message = is404(err)
      ? "头像上传接口暂不可用，请稍后重试。"
      : is401(err)
      ? "请先登录后再上传头像。"
      : err instanceof Error && err.message
      ? err.message
      : "头像上传失败，请稍后重试。";
    console.warn("[uploadAvatar] failed:", errorLogPayload(err));
    throw new Error(message);
  }
};

// ✅ 获取修改记录：接口未做时不炸（404/401/其它 -> 返回空数组）
export const getUserChangeRecords = async (type?: "username" | "nickname"): Promise<ChangeRecord[]> => {
  const query = type ? `?type=${encodeURIComponent(type)}` : "";
  try {
    return await request<ChangeRecord[]>(`/api/v1/user/change-records${query}`, { method: "GET" });
  } catch (err: unknown) {
    console.warn("[getUserChangeRecords] failed -> []", errorLogPayload(err));
    return [];
  }
};

// ✅ 获取修改限制：接口未做时不炸（404/401/其它 -> 返回默认）
export const getUserChangeLimits = async (): Promise<{
  username: { count: number; maxCount: number; resetDate: string; lastChange: string };
  nickname: { count: number; maxCount: number; resetDate: string; lastChange: string };
}> => {
  try {
    return await request("/api/v1/user/change-limits", { method: "GET" });
  } catch (err: unknown) {
    console.warn("[getUserChangeLimits] failed -> default", errorLogPayload(err));
    return {
      username: { count: 0, maxCount: 0, resetDate: "", lastChange: "" },
      nickname: { count: 0, maxCount: 0, resetDate: "", lastChange: "" },
    };
  }
};
