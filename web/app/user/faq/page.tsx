'use client';

import { useState } from 'react';
import { useLocaleContext } from '@/contexts/LocaleContext';
import UserSidebar from '@/components/user/UserSidebar';

export default function FAQPage() {
  const { t } = useLocaleContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  const toggleSidebar = () => {
    setIsSidebarCollapsed(!isSidebarCollapsed);
  };

  const pageTitle = t('faq', 'common');

  return (
    <main className="min-h-screen py-8 flex bg-[#0a0a0d]">
      <UserSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />
      
      <div className="lg:w-4/5 w-full px-4 py-10">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-2xl font-bold text-white mb-8">
            {pageTitle}
          </h1>

          <div className="rounded-lg p-6 bg-[#0a0a0d] border border-white/10">
            <div className="text-center py-12">
              <div className="text-6xl mb-6" aria-hidden="true">{"\u{1F6A7}"}</div>
              <h2 className="text-3xl font-bold text-white mb-4">
                {t('featureComingSoon', 'user')}
              </h2>
              <p className="text-white/70 mb-8 max-w-2xl mx-auto">
                {t('featureComingSoonDesc', 'user')}
              </p>
              <a 
                href="/user/profile" 
                className="inline-block px-6 py-3 bg-amber-500 rounded text-white hover:bg-amber-600 transition-colors"
              >
                {t('returnToProfile', 'user')}
              </a>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}
