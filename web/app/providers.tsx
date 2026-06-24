'use client';

import { Provider } from 'react-redux';
import store from '@/store/store';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider } from '@/lib/authContext';
import ErrorBoundary from '@/components/ui/ErrorBoundary';
import SiteTitleSync from '@/components/layout/SiteTitleSync';

// 创建 QueryClient 实例
const queryClient = new QueryClient();

export default function Providers({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ErrorBoundary>
      <Provider store={store}>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <SiteTitleSync />
            {children}
          </AuthProvider>
        </QueryClientProvider>
      </Provider>
    </ErrorBoundary>
  );
}
