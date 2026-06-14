import { request } from "@/lib/api/core/request";
import { withContentLanguage } from "@/lib/api/core/locale";

export type Announcement = {
  id: number;
  title: string;
  slug: string;
  category?: "platform" | "activity" | "system" | string | null;
  category_label?: string;
  category_badge?: string;
  summary?: string;
  content?: string;
  is_pinned?: boolean;
  status?: string;
  publish_at?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
};

export type AnnouncementList = {
  items: Announcement[];
  page: number;
  page_size: number;
  total: number;
  pages: number;
};

export async function getAnnouncements(page = 1, pageSize = 10, type = "latest", language?: string): Promise<AnnouncementList> {
  const params = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
    type,
  });
  return request<AnnouncementList>(withContentLanguage(`/announcements?${params.toString()}`, language));
}

export async function getAnnouncement(identifier: string | number, language?: string): Promise<{ item: Announcement }> {
  return request<{ item: Announcement }>(withContentLanguage(`/announcements/${identifier}`, language));
}

export async function getAnnouncementUnreadCount(): Promise<{ unread_count: number }> {
  return request<{ unread_count: number }>("/announcements/unread-count");
}

export async function markAnnouncementRead(id: number): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/announcements/${id}/read`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function markAllAnnouncementsRead(): Promise<{ marked: number }> {
  return request<{ marked: number }>("/announcements/read-all", {
    method: "POST",
    body: JSON.stringify({}),
  });
}
