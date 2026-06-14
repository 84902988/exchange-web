"use client";

import { useEffect, useMemo, useState } from "react";

import HomeHero from "@/components/home/HomeHero";
import HomeNotice, { NoticeItem } from "@/components/home/HomeNotice";
import PromoCards, { PromoCardItem } from "@/components/home/PromoCards";
import { useLocaleContext } from "@/contexts/LocaleContext";
import {
  fallbackSiteConfig,
  getHomeBanners,
  getLatestAnnouncements,
  getSiteConfig,
  HomeBanner,
  LatestAnnouncement,
  SiteConfig,
} from "@/lib/api/modules/site";
import type { Language } from "@/utils/language";

type LocalizedText = Partial<Record<Language | "zh_tw", string>>;

function pickCurrentLocaleText(value: LocalizedText | null | undefined, locale: Language): string {
  if (!value) {
    return "";
  }

  const keys: Array<keyof LocalizedText> = locale === "zh-TW" ? ["zh-TW", "zh_tw"] : [locale];
  for (const key of keys) {
    const text = value[key]?.trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function mapBannerToPromoCard(banner: HomeBanner): PromoCardItem {
  return {
    id: String(banner.id),
    title: banner.title,
    subtitle: banner.subtitle || undefined,
    imageSrc: banner.image_url || undefined,
    href: banner.link_url || undefined,
  };
}

function mapAnnouncement(item: LatestAnnouncement): NoticeItem {
  return {
    id: item.slug || String(item.id),
    title: item.title,
    url: item.slug ? `/notice/${item.slug}` : `/notice/${item.id}`,
    publishedAt: item.publish_at || new Date().toISOString(),
    type: item.is_pinned ? "pinned" : "platform",
  };
}

export default function HomePageContent() {
  const { locale, t } = useLocaleContext();
  const [siteConfig, setSiteConfig] = useState<SiteConfig>(fallbackSiteConfig);
  const [homeHeroMedia, setHomeHeroMedia] = useState("");
  const [banners, setBanners] = useState<HomeBanner[]>([]);
  const [announcements, setAnnouncements] = useState<LatestAnnouncement[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadHomeContent() {
      setLoading(true);
      try {
        const [config, bannerResult, announcementResult] = await Promise.all([
          getSiteConfig(locale),
          getHomeBanners(locale),
          getLatestAnnouncements(locale),
        ]);
        if (cancelled) return;
        setSiteConfig({ ...fallbackSiteConfig, ...config });
        setHomeHeroMedia(config.home_hero_image || "");
        setBanners(bannerResult.items || []);
        setAnnouncements(announcementResult.items || []);
      } catch {
        if (!cancelled) {
          setSiteConfig(fallbackSiteConfig);
          setHomeHeroMedia(fallbackSiteConfig.home_hero_image || "");
          setBanners([]);
          setAnnouncements([]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadHomeContent();
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const promoItems = useMemo(() => banners.map(mapBannerToPromoCard), [banners]);
  const noticeItems = useMemo(() => announcements.map(mapAnnouncement), [announcements]);
  const heroCtaText =
    pickCurrentLocaleText(siteConfig.home_hero_cta_text_i18n, locale) || t("heroStart", "home");

  return (
    <div className="min-h-screen bg-[#0b0b0f] text-white">
      <HomeHero
        heroTitle={siteConfig.home_hero_title}
        heroSubtitle={siteConfig.home_hero_subtitle}
        ctaText={heroCtaText}
        ctaLink={siteConfig.home_hero_cta_link}
        backgroundMediaSrc={homeHeroMedia}
      />
      <PromoCards items={promoItems} loading={loading && promoItems.length === 0} />
      <HomeNotice items={noticeItems} loading={loading && noticeItems.length === 0} />
    </div>
  );
}
