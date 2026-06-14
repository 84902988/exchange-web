import { DEFAULT_LANGUAGE, getCurrentLanguage } from "@/utils/language";

export function getContentApiLanguage(): string {
  return getCurrentLanguage() || DEFAULT_LANGUAGE;
}

export function withContentLanguage(path: string, language = getContentApiLanguage()): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}lang=${encodeURIComponent(language)}`;
}
