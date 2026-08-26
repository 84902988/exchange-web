'use client';

import { Provider } from 'react-redux';
import store from '@/store/store';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { usePathname } from 'next/navigation';
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
  const pathname = usePathname();

  // The embedded mobile chart consumes public REST/WebSocket market data only.
  // Keep it out of the PC auth/query shell so opening a WebView never triggers
  // `/me`, refresh-token traffic, or the five-minute private-session poller.
  if (pathname === '/mobile/advanced-chart') {
    return <ErrorBoundary>{children}</ErrorBoundary>;
  }

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
