'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/lib/authContext';

interface AuthGuardProps {
  children: React.ReactNode;
  requireLogin?: boolean;
}

export default function AuthGuard({
  children,
  requireLogin = true,
}: AuthGuardProps) {
  const { isLoggedIn, authChecked, loading } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!authChecked || loading) return;

    if (requireLogin && !isLoggedIn) {
      router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
    }
  }, [authChecked, loading, isLoggedIn, requireLogin, router, pathname]);

  if (!authChecked || loading) {
    return null;
  }

  if (requireLogin && !isLoggedIn) {
    return null;
  }

  return <>{children}</>;
}
