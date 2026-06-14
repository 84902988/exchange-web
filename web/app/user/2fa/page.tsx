'use client';

import { useState } from 'react';
import { useLocaleContext } from '@/contexts/LocaleContext';
import UserSidebar from '@/components/user/UserSidebar';
import UnderConstruction from '@/components/ui/UnderConstruction';

export default function TwoFactorAuthPage() {
  const { t } = useLocaleContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);

  const toggleSidebar = () => {
    setIsSidebarCollapsed(!isSidebarCollapsed);
  };

  const pageTitle = t('twoFactorAuthentication', 'user');

  return (
    <main className="min-h-screen py-8 flex bg-[#0a0a0d]">
      <UserSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />
      
      <div className="lg:w-4/5 w-full px-4 py-10">
        <div className="max-w-7xl mx-auto">
          <h1 className="text-2xl font-bold text-white mb-8">
            {pageTitle}
          </h1>

          <div className="rounded-lg p-6 bg-[#0a0a0d] border border-white/10">
            <UnderConstruction 
              title={pageTitle}
              description={t('featureComingSoonDesc', 'user')}
            />
          </div>
        </div>
      </div>
    </main>
  );
}
