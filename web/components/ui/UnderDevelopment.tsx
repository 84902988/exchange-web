'use client';

import Link from 'next/link';
import useLocale from '@/hooks/useLocale';

export default function UnderDevelopment() {
  const { t } = useLocale();

  return (
    <div className="min-h-screen bg-[#0a0a0d] flex flex-col items-center justify-center p-4">
      <div className="max-w-3xl w-full bg-white/5 border border-white/10 rounded-lg p-8 text-center">
        <div className="text-6xl mb-6">🚧</div>
        <h1 className="text-2xl md:text-3xl font-bold text-white mb-4">
          {t('underDevelopment', 'common')}
        </h1>
        <p className="text-white/70 mb-8">
          {t('underDevelopmentDesc', 'common')}
        </p>
        <div className="flex flex-col md:flex-row justify-center gap-4">
          <Link
            href="/"
            className="px-6 py-3 bg-amber-500 hover:bg-amber-600 text-white font-medium rounded-md transition-colors duration-200"
          >
            {t('returnHome', 'common')}
          </Link>
        </div>
      </div>
    </div>
  );
}
