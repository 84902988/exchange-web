'use client';

import { useEffect, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import LoginForm from '@/components/auth/LoginForm';
import { useAuth } from '@/lib/authContext';
import { useLocaleContext } from '@/contexts/LocaleContext';

const DEFAULT_AFTER_LOGIN_REDIRECT = '/user';

export default function LoginClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { isLoggedIn, authChecked, loading } = useAuth();
  const { t } = useLocaleContext();

  const redirectTarget = useMemo(() => {
    const next = (searchParams?.get('next') || '').trim();
    const redirect = (searchParams?.get('redirect') || '').trim();
    const candidate = next || redirect;
    if (candidate && candidate.startsWith('/')) return candidate;
    return DEFAULT_AFTER_LOGIN_REDIRECT;
  }, [searchParams]);

  useEffect(() => {
    if (!authChecked || loading) return;
    if (isLoggedIn) router.replace(redirectTarget);
  }, [authChecked, loading, isLoggedIn, router, redirectTarget]);

  if (!authChecked || loading) {
    return (
      <main className="flex min-h-screen items-center justify-center py-8">
        <div className="container mx-auto px-4">
          <div className="mx-auto max-w-md rounded-lg border border-white/10 bg-[#0f1319] p-8">
            <div className="h-8" />
            <div className="mt-6 h-40" />
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center py-8">
      <div className="container mx-auto px-4">
        <div className="mx-auto max-w-md rounded-lg border border-white/10 bg-[#0f1319] p-8">
          <h1 className="mb-6 text-center text-2xl font-bold text-white">{t('loginTitle', 'auth')}</h1>
          <LoginForm />
        </div>
      </div>
    </main>
  );
}
