'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import enTranslations from '@/config/locales/en.json';
import {withBrandName} from '@/lib/branding';

// 语言类型定义
type Locale = 'en' | 'zh' | 'zh-TW' | 'ja';

// 成员类型定义
interface CommitteeMember {
  position: string;
  name: string;
  bio: string;
}

// 翻译数据类型定义
interface TranslationData {
  common: {
    [key: string]: string;
  };
  auth: {
    [key: string]: string;
  };
  home: {
    [key: string]: string;
  };
  footer: {
    [key: string]: string;
  };
  asset: {
    [key: string]: string;
  };
  markets: {
    [key: string]: string;
  };
  opportunities: {
    [key: string]: string;
  };
  user: {
    [key: string]: string;
  };
  committee: {
    [key: string]: string | CommitteeMember[];
  };
  contracts: {
    [key: string]: string;
  };
  activity: {
    [key: string]: string;
  };
  mastercard?: {
    [key: string]: string;
  };
}

// 语言配置类型定义
// 默认语言
const DEFAULT_LOCALE: Locale = 'en';
const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'zh', 'zh-TW', 'ja'];
const DEFAULT_TRANSLATIONS = enTranslations as TranslationData;
const MOBILE_ADVANCED_CHART_PATH = '/mobile/advanced-chart';
const MOBILE_CHART_LOCALE_ALIASES: Readonly<Record<string, Locale>> = {
  en: 'en',
  'en-US': 'en',
  ja: 'ja',
  'ja-JP': 'ja',
  zh: 'zh',
  'zh-CN': 'zh',
  'zh-TW': 'zh-TW',
};
const MOBILE_CHART_LOAD_FAILURE_TEXT: Readonly<Record<Locale, string>> = {
  en: 'Failed to load K-line data',
  zh: 'K线加载失败',
  'zh-TW': 'K線載入失敗',
  ja: 'Kラインデータの読み込みに失敗しました',
};
const LOADED_LOCALE_TRANSLATIONS = new Map<Locale, TranslationData>([
  [DEFAULT_LOCALE, DEFAULT_TRANSLATIONS],
]);
const MOBILE_CHART_TRANSLATIONS = new Map<Locale, TranslationData>([
  [DEFAULT_LOCALE, DEFAULT_TRANSLATIONS],
]);
const LOCALE_TRANSLATION_LOADERS: Record<Locale, () => Promise<TranslationData>> = {
  en: async () => DEFAULT_TRANSLATIONS,
  zh: async () => (await import('@/config/locales/zh.json')).default as TranslationData,
  'zh-TW': async () => (await import('@/config/locales/zh-TW.json')).default as TranslationData,
  ja: async () => (await import('@/config/locales/ja.json')).default as TranslationData,
};

const normalizeLocale = (locale: string | null): Locale => (
  SUPPORTED_LOCALES.includes(locale as Locale) ? (locale as Locale) : DEFAULT_LOCALE
);

const getMobileAdvancedChartLocale = (): Locale | null => {
  if (typeof window === 'undefined') return null;
  const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
  if (pathname !== MOBILE_ADVANCED_CHART_PATH) return null;

  const requestedLocale = new URLSearchParams(window.location.search).get('lang') || 'zh';
  return MOBILE_CHART_LOCALE_ALIASES[requestedLocale.trim()] || DEFAULT_LOCALE;
};

const getMobileChartTranslations = (locale: Locale): TranslationData => {
  const cachedTranslations = MOBILE_CHART_TRANSLATIONS.get(locale);
  if (cachedTranslations) return cachedTranslations;

  // The embedded chart consumes locale directly. Its only use of `t` is the
  // load-failure label, so keep that exact text without fetching a full locale.
  const translations: TranslationData = {
    ...DEFAULT_TRANSLATIONS,
    asset: {
      ...DEFAULT_TRANSLATIONS.asset,
      spotChartLoadFailed: MOBILE_CHART_LOAD_FAILURE_TEXT[locale],
    },
  };
  MOBILE_CHART_TRANSLATIONS.set(locale, translations);
  return translations;
};

// 加载语言配置
const loadLocaleData = async (locale: Locale): Promise<TranslationData> => {
  const nextLocale = normalizeLocale(locale);
  const loadedTranslations = LOADED_LOCALE_TRANSLATIONS.get(nextLocale);
  if (loadedTranslations) return loadedTranslations;

  const translations = await LOCALE_TRANSLATION_LOADERS[nextLocale]();
  LOADED_LOCALE_TRANSLATIONS.set(nextLocale, translations);
  return translations;
};

// 获取存储的语言
const getStoredLocale = (): Locale => {
  if (typeof window === 'undefined') {
    return DEFAULT_LOCALE;
  }
  try {
    // 同时支持旧系统的'language'键和新系统的'locale'键，优先使用旧系统的键
    const storedLocale = localStorage.getItem('language') || localStorage.getItem('locale');
    return normalizeLocale(storedLocale);
  } catch {
    return DEFAULT_LOCALE;
  }
};

// 存储语言
const storeLocale = (locale: Locale) => {
  if (typeof window !== 'undefined') {
    // 同时更新两个键，确保两套系统兼容
    localStorage.setItem('language', locale);
    localStorage.setItem('locale', locale);
  }
};

export default function useLocale() {
  const [locale, setLocale] = useState<Locale>(DEFAULT_LOCALE);
  const [translations, setTranslations] = useState<TranslationData>(DEFAULT_TRANSLATIONS);
  const [isLoading, setIsLoading] = useState(false);
  const [isInitialized, setIsInitialized] = useState(false);
  const loadSequenceRef = useRef(0);
  const mountedRef = useRef(false);

  // 加载语言数据
  const loadTranslations = useCallback(async (lang: Locale, persist = true) => {
    const nextLocale = normalizeLocale(lang);
    const loadSequence = ++loadSequenceRef.current;
    setIsLoading(true);
    try {
      const data = await loadLocaleData(nextLocale);
      if (!mountedRef.current || loadSequence !== loadSequenceRef.current) return;
      setTranslations(data);
      setLocale(nextLocale);
      if (persist) storeLocale(nextLocale);
    } catch (error) {
      if (!mountedRef.current || loadSequence !== loadSequenceRef.current) return;
      console.error(`Failed to load translations for locale ${nextLocale}:`, error);
      // 加载失败时使用默认语言
      setTranslations(DEFAULT_TRANSLATIONS);
      setLocale(DEFAULT_LOCALE);
      if (persist) storeLocale(DEFAULT_LOCALE);
    } finally {
      if (mountedRef.current && loadSequence === loadSequenceRef.current) {
        setIsLoading(false);
        setIsInitialized(true);
      }
    }
  }, [setTranslations]);

  // 初始化加载
  useEffect(() => {
    mountedRef.current = true;
    const mobileAdvancedChartLocale = getMobileAdvancedChartLocale();
    if (mobileAdvancedChartLocale) {
      setTranslations(getMobileChartTranslations(mobileAdvancedChartLocale));
      setLocale(mobileAdvancedChartLocale);
      setIsLoading(false);
      setIsInitialized(true);
    }
    const storedLocale = getStoredLocale();
    if (!mobileAdvancedChartLocale) {
      void loadTranslations(storedLocale, false);
    }
    
    // 监听语言变化事件（来自旧的国际化实现）
    const handleLanguageChange = (event: CustomEvent) => {
      const lang = normalizeLocale(event.detail as string);
      loadTranslations(lang);
    };
    
    window.addEventListener('languageChanged', handleLanguageChange as EventListener);
    
    return () => {
      mountedRef.current = false;
      loadSequenceRef.current += 1;
      window.removeEventListener('languageChanged', handleLanguageChange as EventListener);
    };
  }, [loadTranslations, setTranslations]);

  // 切换语言
  useEffect(() => {
    if (!isInitialized || typeof window === 'undefined') return;

    const frameId = window.requestAnimationFrame(() => {
      document.documentElement.classList.remove('locale-preload');
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [isInitialized, locale]);

  const changeLocale = useCallback((lang: Locale) => {
    loadTranslations(normalizeLocale(lang));
  }, [loadTranslations]);

  // 获取翻译文本
  const t = useCallback(<T extends string>(key: string, namespace: 'common' | 'auth' | 'home' | 'footer' | 'asset' | 'markets' | 'opportunities' | 'user' | 'committee' | 'contracts' | 'activity' | 'mastercard' = 'common'): T => {
    const activeTranslations = isInitialized ? translations : DEFAULT_TRANSLATIONS;
    const value = activeTranslations[namespace]?.[key];
    if (typeof value === 'string') return withBrandName(value) as T;
    
    // 返回key作为默认值
    const fallbackValue = DEFAULT_TRANSLATIONS[namespace]?.[key];
    if (typeof fallbackValue === 'string') return withBrandName(fallbackValue) as T;
    
    return '' as T;
  }, [isInitialized, translations]);

// 可用语言列表
  return {
    locale,
    changeLocale,
    t,
    isLoading,
    isInitialized,
    availableLocales: ['en', 'zh', 'zh-TW', 'ja'] as Locale[],
    translations,
  };
}
