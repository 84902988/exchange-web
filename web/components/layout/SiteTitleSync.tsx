"use client";

import { useEffect } from "react";

import { useLocaleContext } from "@/contexts/LocaleContext";
import { fallbackSiteConfig, getSiteConfig } from "@/lib/api/modules/site";

const FALLBACK_SITE_TITLE = fallbackSiteConfig.site_name || "Royal Exchange";

function normalizeTitle(value: string | null | undefined) {
  const title = value?.trim();
  return title || FALLBACK_SITE_TITLE;
}

export default function SiteTitleSync() {
  const { locale } = useLocaleContext();

  useEffect(() => {
    let cancelled = false;

    document.title = normalizeTitle(document.title);

    getSiteConfig(locale)
      .then((config) => {
        if (cancelled) return;
        document.title = normalizeTitle(config.site_name);
      })
      .catch(() => {
        if (cancelled) return;
        document.title = FALLBACK_SITE_TITLE;
      });

    return () => {
      cancelled = true;
    };
  }, [locale]);

  return null;
}
