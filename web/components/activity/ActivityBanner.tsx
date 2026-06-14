"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

import { useLocaleContext } from "@/contexts/LocaleContext";
import { resolveActivityMediaUrl, type ActivityBanner as ActivityBannerItem } from "@/lib/api/modules/activity";

type Props = {
  banners: ActivityBannerItem[];
};

function BannerMedia({ banner }: { banner: ActivityBannerItem }) {
  const mediaUrl = resolveActivityMediaUrl(banner.media_url);

  if (mediaUrl && banner.media_type === "video") {
    return (
      <video
        className="absolute inset-0 h-full w-full object-cover"
        src={mediaUrl}
        autoPlay
        muted
        loop
        playsInline
      />
    );
  }

  if (mediaUrl) {
    return <img src={mediaUrl} alt={banner.title} className="absolute inset-0 h-full w-full object-cover" />;
  }

  return (
    <div className="absolute inset-0 bg-[radial-gradient(circle_at_20%_20%,rgba(245,158,11,0.35),transparent_34%),linear-gradient(135deg,#14110b_0%,#09090b_48%,#231a08_100%)]" />
  );
}

export default function ActivityBanner({ banners }: Props) {
  const { t } = useLocaleContext();
  const displayBanners = useMemo<ActivityBannerItem[]>(
    () =>
      banners.length > 0
        ? banners
        : [
            {
              id: 0,
              title: `Royal Exchange ${t("activityCenter", "activity")}`,
              subtitle: t("activityHeroSubtitle", "activity"),
              media_type: "image",
              media_url: "",
              link_url: "/activity",
            },
          ],
    [banners, t],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const activeBanner = displayBanners[activeIndex] || displayBanners[0];

  useEffect(() => {
    if (displayBanners.length <= 1) return;
    const timer = window.setInterval(() => {
      setActiveIndex((current) => (current + 1) % displayBanners.length);
    }, 6000);
    return () => window.clearInterval(timer);
  }, [displayBanners.length]);

  const content = (
    <section className="relative min-h-[300px] overflow-hidden border-b border-white/10 sm:min-h-[380px] lg:min-h-[430px]">
      <BannerMedia banner={activeBanner} />
      <div className="absolute inset-0 bg-gradient-to-r from-black/85 via-black/55 to-black/25" />
      <div className="absolute inset-0 bg-gradient-to-t from-[#0b0b0f] via-transparent to-transparent" />
      <div className="relative z-10 mx-auto flex min-h-[300px] max-w-7xl flex-col justify-end px-4 pb-10 pt-20 sm:min-h-[380px] sm:px-6 lg:min-h-[430px] lg:px-8">
        <div className="max-w-3xl">
          <div className="mb-4 inline-flex h-8 items-center rounded-full border border-amber-400/30 bg-amber-400/10 px-3 text-sm font-semibold text-amber-200">
            {t("activityCenter", "activity")}
          </div>
          <h1 className="text-4xl font-bold leading-tight text-white sm:text-5xl lg:text-6xl">{activeBanner.title}</h1>
          {activeBanner.subtitle ? (
            <p className="mt-4 max-w-2xl text-base leading-7 text-white/70 sm:text-lg">{activeBanner.subtitle}</p>
          ) : null}
        </div>

        {displayBanners.length > 1 ? (
          <div className="mt-8 flex gap-2">
            {displayBanners.map((banner, index) => (
              <button
                key={banner.id}
                type="button"
                aria-label={t("switchActivityBanner", "activity").replace("{index}", String(index + 1))}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setActiveIndex(index);
                }}
                className={`h-2 rounded-full transition-all ${
                  index === activeIndex ? "w-10 bg-amber-400" : "w-2 bg-white/35 hover:bg-white/60"
                }`}
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  );

  if (activeBanner.link_url) {
    return (
      <Link href={activeBanner.link_url} className="block">
        {content}
      </Link>
    );
  }

  return content;
}
