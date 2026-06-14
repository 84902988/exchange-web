type AvatarLike = {
  avatar?: string | null;
  avatar_url?: string | null;
  username?: string | null;
  nickname?: string | null;
  email?: string | null;
  profile?: {
    avatar_url?: string | null;
    username?: string | null;
    nickname?: string | null;
    email?: string | null;
  } | null;
  user_profile?: {
    avatar_url?: string | null;
    username?: string | null;
    nickname?: string | null;
    email?: string | null;
  } | null;
};

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function getUserAvatarUrl(user: AvatarLike | null | undefined): string {
  if (!user) return "";
  return (
    cleanString(user.avatar_url) ||
    cleanString(user.profile?.avatar_url) ||
    cleanString(user.user_profile?.avatar_url) ||
    cleanString(user.avatar)
  );
}

export function getUserDisplayName(user: AvatarLike | null | undefined): string {
  if (!user) return "";
  return (
    cleanString(user.nickname) ||
    cleanString(user.profile?.nickname) ||
    cleanString(user.user_profile?.nickname) ||
    cleanString(user.username) ||
    cleanString(user.profile?.username) ||
    cleanString(user.user_profile?.username) ||
    cleanString(user.profile?.email) ||
    cleanString(user.user_profile?.email) ||
    cleanString(user.email)
  );
}

export function getUserAvatarInitial(user: AvatarLike | null | undefined, fallback = "U"): string {
  const source = getUserDisplayName(user) || fallback;
  return (source.charAt(0) || fallback).toUpperCase();
}
