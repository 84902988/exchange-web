'use client';

import { useLocaleContext } from '@/contexts/LocaleContext';

export default function LoginLoadingFallback() {
  const { t } = useLocaleContext();

  return <div className="min-h-screen flex items-center justify-center text-white/70">{t('loading', 'common')}</div>;
}
