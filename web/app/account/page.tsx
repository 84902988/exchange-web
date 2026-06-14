'use client';

import AccountButton from '@/components/account/AccountButton';
import { useLocaleContext } from '@/contexts/LocaleContext';

export default function AccountPage() {
  const { t } = useLocaleContext();

  return (
    <main className="min-h-screen py-8">
      <div className="container mx-auto px-4">
        <h1 className="text-2xl font-bold text-white mb-6">{t('personalCenter', 'common')}</h1>
        
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1 bg-[#0e1117] rounded-xl p-5 border border-white/10 shadow-xl">
            <div className="text-center mb-4">
              <div className="w-20 h-20 bg-[#1a1f2e] rounded-full mx-auto mb-3 flex items-center justify-center">
                <div className="text-white text-xl font-semibold">{t('userFallbackLabel', 'user')}</div>
              </div>
              <div className="text-white font-semibold">{t('username', 'user')}</div>
              <div className="text-sm text-white/50">{t('notSet', 'user')}</div>
            </div>
            
            <div className="space-y-2">
              <AccountButton label={t('accountInformation', 'asset')} isActive />
              <AccountButton label={t('kycVerification', 'user')} />
              <AccountButton label={t('securitySettings', 'user')} />
              <AccountButton label={t('tradingSettings', 'user')} />
              <AccountButton label={t('apiManagement', 'user')} />
              <AccountButton label={t('logout', 'common')} />
            </div>
          </div>
          
          <div className="lg:col-span-2 bg-[#0e1117] rounded-xl p-5 border border-white/10 shadow-xl">
            <h2 className="text-lg font-semibold text-white mb-4">{t('profileBasicInfo', 'user')}</h2>
            
            <form className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-white/50 mb-2">{t('username', 'user')}</div>
                  <input 
                    type="text" 
                    defaultValue={t('userFallbackLabel', 'user')}
                    className="w-full bg-[#1a1f2e] border border-white/10 rounded p-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all duration-200"
                  />
                </div>
                
                <div>
                  <div className="text-sm text-white/50 mb-2">{t('email', 'user')}</div>
                  <input 
                    type="email" 
                    defaultValue=""
                    className="w-full bg-[#1a1f2e] border border-white/10 rounded p-3 text-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all duration-200"
                  />
                </div>
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-white/50 mb-2">{t('realName', 'user')}</div>
                  <input 
                    type="text" 
                    placeholder={t('kycFullNamePlaceholder', 'user')}
                    className="w-full bg-[#1a1f2e] border border-white/10 rounded p-3 text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all duration-200"
                  />
                </div>
                
                <div>
                  <div className="text-sm text-white/50 mb-2">{t('profilePhoneNumber', 'user')}</div>
                  <input 
                    type="tel" 
                    placeholder={t('profilePhonePlaceholder', 'user')}
                    className="w-full bg-[#1a1f2e] border border-white/10 rounded p-3 text-white placeholder-white/50 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition-all duration-200"
                  />
                </div>
              </div>
              
              <div>
                <button className="bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-600 hover:to-amber-700 text-white font-semibold py-3 px-6 rounded transition-all duration-200">{t('saveChanges', 'user')}</button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </main>
  );
}
