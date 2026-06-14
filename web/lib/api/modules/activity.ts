import { getRuntimeApiBaseUrl } from "@/lib/api/core/baseUrl";
import { withContentLanguage } from "@/lib/api/core/locale";
import { request } from "@/lib/api/core/request";

export type ActivityStatus = "active" | "inactive" | "ended" | string;
export type ActivityMediaType = "image" | "video" | string;

export type Activity = {
  id: number;
  title: string;
  subtitle?: string | null;
  description?: string | null;
  detail_content?: string | null;
  reward_text?: string | null;
  reward_value?: string | number | null;
  cover_url?: string | null;
  banner_url?: string | null;
  banner_type?: ActivityMediaType;
  video_url?: string | null;
  status?: ActivityStatus;
  status_label?: string;
  sort_order?: number;
  start_at?: string | null;
  end_at?: string | null;
  cta_text?: string | null;
  cta_url?: string | null;
};

export type ActivityBanner = {
  id: number;
  title: string;
  subtitle?: string | null;
  media_type?: ActivityMediaType;
  media_url?: string | null;
  link_url?: string | null;
  sort_order?: number;
  enabled?: boolean;
  start_at?: string | null;
  end_at?: string | null;
};

export async function getActivities(limit = 6, language?: string): Promise<{ items: Activity[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  return request<{ items: Activity[] }>(withContentLanguage(`/activities?${params.toString()}`, language));
}

export async function getActivity(id: string | number, language?: string): Promise<{ item: Activity }> {
  return request<{ item: Activity }>(withContentLanguage(`/activities/${id}`, language));
}

export async function getActivityBanners(limit = 6, language?: string): Promise<{ items: ActivityBanner[] }> {
  const params = new URLSearchParams({ limit: String(limit) });
  return request<{ items: ActivityBanner[] }>(withContentLanguage(`/activities/banners?${params.toString()}`, language));
}

export function resolveActivityMediaUrl(url?: string | null): string {
  const value = String(url || "").trim();
  if (!value) return "";
  if (/^(https?:)?\/\//i.test(value) || value.startsWith("data:")) return value;
  if (value.startsWith("/static/")) {
    return `${getRuntimeApiBaseUrl().replace(/\/+$/, "")}${value}`;
  }
  return value;
}
