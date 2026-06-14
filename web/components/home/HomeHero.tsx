"use client";

import Link from "next/link";
import { useState } from "react";

import HeroBackgroundVideo from "@/components/home/HeroBackgroundVideo";
import { useLocaleContext } from "@/contexts/LocaleContext";
import type { Language } from "@/utils/language";

type HeroLocalizedText = Partial<Record<Language, string>>;

export type HeroTopBar = {
  visible?: boolean;
  text?: HeroLocalizedText;
  ctaText?: HeroLocalizedText;
  ctaHref?: string;
};

export type HomeHeroProps = {
  topBar?: HeroTopBar;
  backgroundMediaSrc?: string;
  backgroundAlt?: string;
  heightClassName?: string;
  heroTitle?: string;
  heroSubtitle?: string;
  ctaText?: string;
  ctaLink?: string;
};

const defaultTopBar: HeroTopBar = {
  visible: true,
  ctaHref: "/user/identity",
};

export default function HomeHero({
  topBar = defaultTopBar,
  backgroundMediaSrc = "",
  backgroundAlt = "homepage-background",
  heightClassName = "h-[360px] md:h-[480px]",
  heroTitle,
  heroSubtitle,
  ctaText,
  ctaLink = "/register",
}: HomeHeroProps) {
  const { locale, t } = useLocaleContext();
  const mediaSrc = backgroundMediaSrc || "";
  const fallbackImageSrc = "/homepage-background.png";
  const isVideoMedia = /\.(mp4|webm)(?:[?#].*)?$/i.test(mediaSrc);
  const heroVideoSrc = isVideoMedia ? mediaSrc : "";
  const heroImageSrc = !isVideoMedia ? mediaSrc : "";
  const currentLanguage: Language = locale;
  const [inputValue, setInputValue] = useState("");
  const [isTopBarVisible, setIsTopBarVisible] = useState(topBar.visible !== false);
  const [failedVideoSrc, setFailedVideoSrc] = useState("");
  const isVideoUnavailable = Boolean(heroVideoSrc) && failedVideoSrc === heroVideoSrc;
  const shouldShowVideo = Boolean(heroVideoSrc) && !isVideoUnavailable;
  const visibleImageSrc = heroImageSrc || (isVideoUnavailable ? fallbackImageSrc : "");
  const pickHeroLabel = (label: HeroLocalizedText | undefined, fallback: string) =>
    label?.[currentLanguage] ?? label?.en ?? label?.zh ?? label?.["zh-TW"] ?? fallback;

  const translatedTopBar = {
    visible: topBar.visible,
    text: pickHeroLabel(topBar.text, t("kycVerification", "home")),
    ctaText: pickHeroLabel(topBar.ctaText, t("verifyNow", "home")),
    ctaHref: topBar.ctaHref,
  };

  const fallbackHeroTitle = t("heroTitle", "home");
  const emailPhonePlaceholder = t("heroPlaceholder", "home");
  const getStartedText = ctaText || t("heroRegister", "home");

  const handleRegisterClick = (e: React.MouseEvent) => {
    e.preventDefault();
    const baseLink = ctaLink || "/register";
    const separator = baseLink.includes("?") ? "&" : "?";
    const targetUrl =
      inputValue && baseLink.startsWith("/register")
        ? `${baseLink}${separator}emailOrPhone=${encodeURIComponent(inputValue)}`
        : baseLink;
    window.location.href = targetUrl;
  };

  return (
    <section className="w-full">
      {isTopBarVisible && (
        <div className="relative flex items-center justify-center border border-white/10 bg-[#0a0a0d] px-4 py-2 text-center text-sm font-semibold text-white backdrop-blur-md">
          <span className="truncate">{translatedTopBar.text}</span>

          {translatedTopBar.ctaText && translatedTopBar.ctaHref && (
            <Link href={translatedTopBar.ctaHref} className="ml-3 whitespace-nowrap text-amber-400 hover:text-amber-300">
              {translatedTopBar.ctaText}
            </Link>
          )}

          <button
            className="absolute right-3 flex h-5 w-5 items-center justify-center rounded-full transition-colors hover:bg-white/10"
            onClick={() => setIsTopBarVisible(false)}
            aria-label={t("modalClose", "home")}
          >
            <svg className="h-3 w-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      <div className={`relative w-full overflow-hidden ${heightClassName}`}>
        {shouldShowVideo && (
          <HeroBackgroundVideo
            src={heroVideoSrc}
            onReady={() => setFailedVideoSrc("")}
            onError={() => setFailedVideoSrc(heroVideoSrc)}
          />
        )}

        {visibleImageSrc && (
          <img
            src={visibleImageSrc}
            alt={backgroundAlt}
            className="absolute inset-0 z-0 h-full w-full object-cover"
          />
        )}

        <div className="pointer-events-none absolute inset-0 z-[1] bg-gradient-to-b from-black/45 via-black/25 to-black/55" />

        <div className="absolute inset-0 z-10 flex flex-col items-center justify-start px-4 pt-24 text-center sm:justify-center sm:pt-32 md:px-6 md:pt-0">
          <h1 className="mb-3 text-3xl font-bold leading-snug text-white sm:text-3xl md:mb-4 md:text-5xl lg:text-5xl">
            {heroTitle || fallbackHeroTitle}
          </h1>

          {heroSubtitle && (
            <p className="mb-4 max-w-[720px] text-sm font-medium leading-relaxed text-white/75 sm:text-base md:mb-7">
              {heroSubtitle}
            </p>
          )}

          <div className="flex w-full max-w-[320px] flex-col gap-3 sm:max-w-[420px] md:max-w-[500px] md:flex-row md:gap-4">
            <div className="relative flex-1">
              <input
                type="text"
                placeholder={emailPhonePlaceholder}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                className="w-full rounded-md border border-white/20 bg-white/10 px-3 py-2 text-sm text-white placeholder-white/60 focus:outline-none focus:ring-2 focus:ring-white/30 md:rounded-lg md:px-4 md:py-3 md:text-base"
              />
            </div>
            <button
              onClick={handleRegisterClick}
              className="whitespace-nowrap rounded-md bg-gradient-to-r from-white to-gray-100 px-4 py-2 text-sm font-semibold text-black transition-all duration-300 hover:from-amber-400 hover:to-amber-300 hover:text-white md:rounded-lg md:px-8 md:py-3 md:text-base"
            >
              {getStartedText}
            </button>
          </div>
        </div>

        <div className="absolute inset-x-0 bottom-0 z-10 h-[80px] bg-gradient-to-t from-black/60 to-transparent sm:h-[140px]" />
      </div>
    </section>
  );
}
