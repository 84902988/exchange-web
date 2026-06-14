import type { Language as BaseLanguage } from "@/config/menuConfig";

export type Language = BaseLanguage;
export type LanguageChangedEvent = CustomEvent<Language>;

const DEFAULT_LANGUAGE: Language = "zh";
const SUPPORTED_LANGUAGES: readonly Language[] = ["en", "zh", "zh-TW", "ja"];

const isSupportedLanguage = (language: string | null): language is Language => (
  !!language && SUPPORTED_LANGUAGES.includes(language as Language)
);

const getCurrentLanguage = (): Language => {
  if (typeof window === "undefined") {
    return DEFAULT_LANGUAGE;
  }

  const savedLanguage = localStorage.getItem("language");
  return isSupportedLanguage(savedLanguage) ? savedLanguage : DEFAULT_LANGUAGE;
};

const setCurrentLanguage = (language: Language): void => {
  if (typeof window !== "undefined") {
    const nextLanguage = isSupportedLanguage(language) ? language : DEFAULT_LANGUAGE;
    localStorage.setItem("language", nextLanguage);
  }
};

const getTranslatedLabel = <
  T extends { en: string; zh: string; zh_tw?: string; "zh-TW"?: string; [key: string]: string | undefined },
>(
  label: T,
  language?: Language,
): string => {
  const currentLang = language || getCurrentLanguage();
  if (currentLang === "ja") {
    return (
      label.ja ||
      label.en ||
      label["zh-TW"] ||
      label.zh_tw ||
      label.zh
    );
  }

  return (
    label[currentLang] ||
    label["zh-TW"] ||
    label.zh_tw ||
    label.zh ||
    label.en
  );
};

export { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, getCurrentLanguage, setCurrentLanguage, getTranslatedLabel };
