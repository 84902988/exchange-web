import { request } from "@/lib/api/core/request";
import { withContentLanguage } from "@/lib/api/core/locale";
import type { Language } from "@/utils/language";

type LocalizedText = Partial<Record<Language, string>>;

export type SiteConfig = {
  id?: number;
  site_name: string;
  site_slogan?: string;
  logo_url?: string;
  support_email?: string;
  risk_disclaimer?: string;
  footer_disclaimer?: string;
  stock_token_locks_notice_title?: string;
  stock_token_locks_notice_content?: string;
  home_hero_title?: string;
  home_hero_subtitle?: string;
  home_hero_cta_text?: string;
  home_hero_cta_text_i18n?: LocalizedText | null;
  home_hero_cta_link?: string;
  home_hero_image?: string;
  show_risk_link?: boolean;
  risk_link_url?: string;
  show_terms_link?: boolean;
  terms_link_url?: string;
  show_privacy_link?: boolean;
  privacy_link_url?: string;
  locale?: string;
};

export type HomeBanner = {
  id: number;
  title: string;
  subtitle?: string | null;
  image_url?: string;
  link_url?: string;
  sort_order?: number;
  status?: string;
  start_at?: string | null;
  end_at?: string | null;
};

export type LatestAnnouncement = {
  id: number;
  title: string;
  slug: string;
  category?: string | null;
  category_label?: string;
  category_badge?: string;
  summary?: string;
  content?: string;
  is_pinned?: boolean;
  status?: string;
  publish_at?: string | null;
};

export type AboutPageSectionItem = {
  title: string;
  body: string[];
};

export type AboutPageSection = {
  id: "who" | "story" | "vision" | "mission" | "values" | string;
  title: string;
  eyebrow?: string;
  body: string[];
  items?: AboutPageSectionItem[];
};

export type AboutPageContent = {
  slug: string;
  title: string;
  subtitle?: string;
  sections: AboutPageSection[];
  locale?: string;
};

export type LegalPageKey = "risk" | "terms" | "privacy";

export type LegalPageContent = {
  key: LegalPageKey | string;
  title: string;
  content: string;
  locale?: string;
};

export const fallbackSiteConfig: SiteConfig = {
  site_name: "RE",
  site_slogan: "",
  logo_url: "/icons/logo-1.svg",
  support_email: "",
  risk_disclaimer: "",
  footer_disclaimer: "",
  stock_token_locks_notice_title: "",
  stock_token_locks_notice_content: "",
  home_hero_title: "",
  home_hero_subtitle: "",
  home_hero_cta_text: "",
  home_hero_cta_link: "/register",
  home_hero_image: "/homepage-bg.mp4",
  show_risk_link: true,
  risk_link_url: "/risk",
  show_terms_link: true,
  terms_link_url: "/terms",
  show_privacy_link: true,
  privacy_link_url: "/privacy",
  locale: "zh",
};

export async function getSiteConfig(language?: string): Promise<SiteConfig> {
  return request<SiteConfig>(withContentLanguage("/site/config", language));
}

export async function getHomeBanners(language?: string): Promise<{ items: HomeBanner[] }> {
  return request<{ items: HomeBanner[] }>(withContentLanguage("/home/banners", language));
}

export async function getLatestAnnouncements(language?: string): Promise<{ items: LatestAnnouncement[] }> {
  return request<{ items: LatestAnnouncement[] }>(withContentLanguage("/announcements/latest", language));
}

export async function getAboutPage(language?: string): Promise<AboutPageContent> {
  return request<AboutPageContent>(withContentLanguage("/site/pages/about", language));
}

export async function getLegalPage(pageKey: LegalPageKey, language?: string): Promise<LegalPageContent> {
  return request<LegalPageContent>(withContentLanguage(`/site/pages/legal/${pageKey}`, language));
}
