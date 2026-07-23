'use client';

import { useState, useEffect } from 'react';
import { getFinanceAccountOverview, getFinanceProducts, FinanceAccount, FinanceProduct } from '@/lib/api';
import { DEFAULT_LANGUAGE, getCurrentLanguage, getTranslatedLabel } from '@/utils/language';
import { LanguageChangedEvent } from '@/types';
import EmptyState from '@/components/ui/EmptyState';
import FinanceAccountSummary from '@/components/finance/FinanceAccountSummary';
import FinanceProductList from '@/components/finance/FinanceProductList';
import AssetSidebar from '@/components/asset/AssetSidebar';

export default function FinancePage() {
  const [financeAccount, setFinanceAccount] = useState<FinanceAccount | null>(null);
  const [products, setProducts] = useState<FinanceProduct[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 语言状态管理
  const [currentLanguage, setCurrentLanguage] = useState(DEFAULT_LANGUAGE);
  
  // 初始化语言和监听语言变化
  useEffect(() => {
    // 初始加载时获取当前语言
    setCurrentLanguage(getCurrentLanguage());
    
    // 监听语言变化事件
    const handleLanguageChanged = (event: LanguageChangedEvent) => {
      setCurrentLanguage(event.detail);
    };
    
    window.addEventListener('languageChanged', handleLanguageChanged as EventListener);
    
    return () => {
      window.removeEventListener('languageChanged', handleLanguageChanged as EventListener);
    };
  }, []);

  // 获取理财账户概览数据
  const fetchFinanceAccount = async () => {
    try {
      const data = await getFinanceAccountOverview();
      setFinanceAccount(data);
    } catch (err) {
      console.error('Failed to fetch finance account:', err);
      setError('获取理财账户数据失败');
    }
  };

  // 获取理财产品列表数据
  const fetchFinanceProducts = async () => {
    try {
      const data = await getFinanceProducts();
      setProducts(data.list);
    } catch (err) {
      console.error('Failed to fetch finance products:', err);
      setError('获取理财产品数据失败');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchFinanceAccount();
    fetchFinanceProducts();
  }, []);

  // 处理刷新数据
  const handleRefresh = () => {
    setLoading(true);
    setError(null);
    fetchFinanceAccount();
    fetchFinanceProducts();
  };

  // 侧边栏折叠状态管理
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  
  // 切换侧边栏折叠状态
  const toggleSidebar = () => {
    setIsSidebarCollapsed(!isSidebarCollapsed);
  };
  
  if (error) {
    return (
      <main className="min-h-screen py-8 flex">
        {/* 左侧功能选择边栏 */}
        <AssetSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />
        
        {/* 右侧主要内容 */}
        <div className="lg:w-4/5 w-full px-4">
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-white/90">{getTranslatedLabel({ en: 'Finance Account', zh: '理财账户' }, currentLanguage)}</h1>
          </div>
          <EmptyState
            title="加载失败"
            description={error}
            action={
              <button 
                className="bg-amber-500 hover:bg-amber-600 text-white font-semibold py-2 px-4 rounded"
                onClick={handleRefresh}
              >
                {getTranslatedLabel({ en: 'Retry', zh: '重试' }, currentLanguage)}
              </button>
            }
          />
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen py-8 flex">
      {/* 左侧功能选择边栏 */}
      <AssetSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />
      
      {/* 右侧主要内容 */}
      <div className="lg:w-4/5 w-full px-4">
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-white/90">{getTranslatedLabel({ en: 'Finance Account', zh: '理财账户' }, currentLanguage)}</h1>
        </div>

        {/* 理财账户概览 */}
        <div className="mb-8">
          <FinanceAccountSummary 
            totalAmount={financeAccount?.totalAmount || '0.00'} 
            totalEarnings={financeAccount?.totalEarnings || '0.00'} 
            loading={loading} 
          />
        </div>

        {/* 理财产品列表 */}
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <h2 className="text-xl font-semibold text-white">{getTranslatedLabel({ en: 'Finance Products', zh: '理财产品' }, currentLanguage)}</h2>
          </div>
          
          <FinanceProductList 
            products={products} 
            loading={loading} 
          />
        </div>
      </div>
    </main>
  );
}
