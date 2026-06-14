'use client';

import React, { createContext, useContext, ReactNode } from 'react';
import useLocale from '@/hooks/useLocale';

// 语言类型定义
export type Locale = 'en' | 'zh' | 'zh-TW' | 'ja';

// 翻译函数类型定义
type TranslateFunction = <T extends string>(key: string, namespace?: 'common' | 'auth' | 'home' | 'footer' | 'asset' | 'markets' | 'opportunities' | 'user' | 'committee' | 'contracts' | 'activity') => T;

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
    [key: string]: string | unknown[];
  };
  contracts: {
    [key: string]: string;
  };
  activity: {
    [key: string]: string;
  };
}

// 语言上下文类型定义
interface LocaleContextType {
  locale: Locale;
  changeLocale: (locale: Locale) => void;
  t: TranslateFunction;
  isLoading: boolean;
  availableLocales: Locale[];
  translations: TranslationData;
}

// 创建语言上下文
const LocaleContext = createContext<LocaleContextType | undefined>(undefined);

// 语言提供者组件属性类型定义
interface LocaleProviderProps {
  children: ReactNode;
}

// 语言提供者组件
export const LocaleProvider: React.FC<LocaleProviderProps> = ({ children }) => {
  const localeHook = useLocale();

  return (
    <LocaleContext.Provider value={localeHook}>
      {children}
    </LocaleContext.Provider>
  );
};

// 语言上下文钩子
export const useLocaleContext = (): LocaleContextType => {
  const context = useContext(LocaleContext);
  if (context === undefined) {
    throw new Error('useLocaleContext must be used within a LocaleProvider');
  }
  return context;
};
