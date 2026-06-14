'use client';

import { useState, useEffect, useCallback } from 'react';
import zhTranslations from '@/config/locales/zh.json';

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
}

// 语言配置类型定义
// 默认语言
const DEFAULT_LOCALE: Locale = 'zh';
const SUPPORTED_LOCALES: readonly Locale[] = ['en', 'zh', 'zh-TW', 'ja'];
const DEFAULT_TRANSLATIONS = zhTranslations as TranslationData;

const normalizeLocale = (locale: string | null): Locale => (
  SUPPORTED_LOCALES.includes(locale as Locale) ? (locale as Locale) : DEFAULT_LOCALE
);

// 加载语言配置
const loadLocaleData = async (locale: Locale): Promise<TranslationData> => {
  const translations = await import(`@/config/locales/${locale}.json`);
  return translations.default;
};

// 获取存储的语言
const getStoredLocale = (): Locale => {
  if (typeof window === 'undefined') {
    return DEFAULT_LOCALE;
  }
  // 同时支持旧系统的'language'键和新系统的'locale'键，优先使用旧系统的键
  const storedLocale = localStorage.getItem('language') || localStorage.getItem('locale');
  return normalizeLocale(storedLocale);
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
// 初始化加载
  const [translations, setTranslations] = useState<TranslationData>(DEFAULT_TRANSLATIONS);
  const [isLoading, setIsLoading] = useState(false);

  // 加载语言数据
  const loadTranslations = useCallback(async (lang: Locale) => {
    const nextLocale = normalizeLocale(lang);
    setIsLoading(true);
    try {
      const data = await loadLocaleData(nextLocale);
      setTranslations(data);
      setLocale(nextLocale);
      storeLocale(nextLocale);
    } catch (error) {
      console.error(`Failed to load translations for locale ${nextLocale}:`, error);
      // 加载失败时使用默认语言
      setTranslations(DEFAULT_TRANSLATIONS);
      setLocale(DEFAULT_LOCALE);
      storeLocale(DEFAULT_LOCALE);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 初始化加载
  useEffect(() => {
    const storedLocale = getStoredLocale();
    loadTranslations(storedLocale);
    
    // 监听语言变化事件（来自旧的国际化实现）
    const handleLanguageChange = (event: CustomEvent) => {
      const lang = normalizeLocale(event.detail as string);
      loadTranslations(lang);
    };
    
    window.addEventListener('languageChanged', handleLanguageChange as EventListener);
    
    return () => {
      window.removeEventListener('languageChanged', handleLanguageChange as EventListener);
    };
  }, [loadTranslations]);

  // 切换语言
  const changeLocale = useCallback((lang: Locale) => {
    loadTranslations(normalizeLocale(lang));
  }, [loadTranslations]);

  // 获取翻译文本
  const t = useCallback(<T extends string>(key: string, namespace: 'common' | 'auth' | 'home' | 'footer' | 'asset' | 'markets' | 'opportunities' | 'user' | 'committee' | 'contracts' | 'activity' = 'common'): T => {
    const value = translations[namespace]?.[key];
    if (typeof value === 'string') return value as T;
    
    // 返回key作为默认值
    const fallbackValue = DEFAULT_TRANSLATIONS[namespace]?.[key];
    if (typeof fallbackValue === 'string') return fallbackValue as T;
    
    return '' as T;
  }, [translations]);

// 可用语言列表
  return {
    locale,
    changeLocale,
    t,
    isLoading,
    availableLocales: ['en', 'zh', 'zh-TW', 'ja'] as Locale[],
    translations,
  };
}
