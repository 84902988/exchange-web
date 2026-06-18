'use client';

import { useState, useEffect } from 'react';
import { DEFAULT_LANGUAGE, getCurrentLanguage } from '@/utils/language';
import { Language, LanguageChangedEvent } from '@/types';
import AssetSidebar from '@/components/asset/AssetSidebar';
import UnderConstruction from '@/components/ui/UnderConstruction';

export default function LendingPage() {
  // 语言状态管理
  const [currentLanguage, setCurrentLanguage] = useState(DEFAULT_LANGUAGE);
  
  // 初始化语言和监听语言变化
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setCurrentLanguage(getCurrentLanguage());
    }, 0);
    
    // 监听语言变化事件
    const handleLanguageChanged = (event: LanguageChangedEvent) => {
      setCurrentLanguage(event.detail);
    };
    
    window.addEventListener('languageChanged', handleLanguageChanged as EventListener);
    
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('languageChanged', handleLanguageChanged as EventListener);
    };
  }, []);

  // 侧边栏折叠状态管理
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  
  // 切换侧边栏折叠状态
  const toggleSidebar = () => {
    setIsSidebarCollapsed(!isSidebarCollapsed);
  };
  
  return (
    <main className="min-h-screen py-8 flex">
      {/* 左侧功能选择边栏 */}
      <AssetSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />
      
      {/* 右侧主要内容 */}
      <div className="lg:w-4/5 w-full px-4">
        <UnderConstruction title="币币借贷" description="币币借贷功能正在开发中，敬请期待" />
      </div>
    </main>
  );
}
