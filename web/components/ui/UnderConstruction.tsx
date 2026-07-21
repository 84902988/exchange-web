'use client';

import Image from 'next/image';
import { ReactNode, useState, useEffect } from 'react';
import { DEFAULT_LANGUAGE, getCurrentLanguage, getTranslatedLabel } from '@/utils/language';
import { Language, LanguageChangedEvent } from '@/types';
import { DEFAULT_SITE_LOGO_URL } from '@/lib/siteLogo';

interface TranslatedText {
  en: string;
  zh: string;
  [key: string]: string;
}

interface UnderConstructionProps {
  title?: string | TranslatedText;
  description?: string | TranslatedText;
  children?: ReactNode;
}

export default function UnderConstruction({ 
  title = { en: 'Coming Soon', zh: '此功能暂未开放', 'zh-TW': '此功能暫未開放' }, 
  description = { en: 'Stay tuned for updates', zh: '敬请期待', 'zh-TW': '敬請期待' },
  children 
}: UnderConstructionProps) {
  // 直接使用函数形式初始化状态，避免在 useEffect 中设置初始值
  // 初始化时使用默认语言，避免hydration不匹配
  const [currentLanguage, setCurrentLanguage] = useState<Language>(DEFAULT_LANGUAGE);
  
  // 在客户端渲染完成后，异步更新为用户偏好的语言
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const userLanguage = getCurrentLanguage();
      if (userLanguage !== DEFAULT_LANGUAGE) {
        setCurrentLanguage(userLanguage);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  
  // 监听语言变化事件
  useEffect(() => {
    const handleLanguageChanged = (event: LanguageChangedEvent) => {
      setCurrentLanguage(event.detail);
    };
    
    window.addEventListener('languageChanged', handleLanguageChanged as EventListener);
    
    return () => {
      window.removeEventListener('languageChanged', handleLanguageChanged as EventListener);
    };
  }, []);
  
  // 获取翻译后的文本
  const getText = (text: string | TranslatedText) => {
    if (typeof text === 'string') {
      return text;
    }
    return getTranslatedLabel(text, currentLanguage);
  };
  
  return (
    <div className="min-h-screen bg-[#0a0a0d] text-white flex flex-col items-center justify-center py-12 px-4">
      <div className="max-w-4xl mx-auto text-center">
        {/* 主标题 */}
        <h1 className="text-4xl md:text-5xl font-bold text-white mb-6">
          {getText(title)}
        </h1>
        
        {/* 描述 */}
        <p className="text-xl text-white/70 mb-12">
          {getText(description)}
        </p>
        
        {/* 可选的子内容 */}
        {children}
        
        {/* 装饰性图标或图像 */}
        <div className="mt-12 flex justify-center">
          <div className="w-40 h-40 rounded-full bg-white/10 flex items-center justify-center">
            <Image
              src={DEFAULT_SITE_LOGO_URL}
              alt="Logo"
              width={80}
              height={80}
              className="h-20 w-20 object-contain"
            />
          </div>
        </div>
      </div>
    </div>
  );
}
