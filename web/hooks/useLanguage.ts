"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_LANGUAGE,
  getCurrentLanguage,
  LanguageChangedEvent,
} from "@/utils/language";

export function useLanguage() {
  const [currentLanguage, setCurrentLanguageState] = useState(DEFAULT_LANGUAGE);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCurrentLanguageState(getCurrentLanguage());
    }, 0);

    const handleLanguageChanged = (event: LanguageChangedEvent) => {
      setCurrentLanguageState(event.detail);
    };

    window.addEventListener("languageChanged", handleLanguageChanged as EventListener);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("languageChanged", handleLanguageChanged as EventListener);
    };
  }, []);

  return { currentLanguage };
}
