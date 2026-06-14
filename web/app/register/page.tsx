'use client';

import { Suspense } from 'react';
import RegisterForm from '@/components/auth/RegisterForm';
import { useLocaleContext } from '@/contexts/LocaleContext';

export default function RegisterPage() {
  const { t } = useLocaleContext();

  return (
    <main className="flex min-h-screen items-center justify-center py-8">
      <div className="container mx-auto px-4">
        <div className="mx-auto max-w-md rounded-lg border border-white/10 bg-[#0f1319] p-8">
          <h1 className="mb-6 text-center text-2xl font-bold text-white">{t('registerTitle', 'auth')}</h1>
          <Suspense fallback={<div className="text-white/70">{t('loading', 'common')}</div>}>
            <RegisterForm />
          </Suspense>
        </div>
      </div>
    </main>
  );
}
