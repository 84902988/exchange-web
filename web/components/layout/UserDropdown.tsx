'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/authContext';
import { useLocaleContext } from '@/contexts/LocaleContext';
import UserAvatar from '@/components/user/UserAvatar';
import { getUserDisplayName } from '@/lib/userAvatar';
import enTranslations from '@/config/locales/en.json';

const DEFAULT_COMMON_TRANSLATIONS = (enTranslations as { common: Record<string, string> }).common;

export default function UserDropdown() {
  const router = useRouter();
  const { user, logout } = useAuth();
  const { t } = useLocaleContext();

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setMounted(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  const displayName = getUserDisplayName(user) || `UID: ${user?.id ?? '-'}`;
  const emailText = (user?.email || '').trim();
  const secondaryText = emailText && emailText !== displayName ? emailText : user?.id ? `UID: ${user.id}` : '';
  const menuT = (key: string) => (mounted ? t(key, 'common') : DEFAULT_COMMON_TRANSLATIONS[key] || key);

  const handleLogout = async () => {
    try {
      await logout();
    } finally {
      setOpen(false);
      router.replace('/');
    }
  };

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="grid h-9 w-9 place-items-center rounded-full border border-white/0 bg-transparent text-white/90 hover:bg-white/10 transition-colors duration-200"
        aria-label={menuT('userMenu')}
      >
        <UserAvatar user={user} className="h-8 w-8" fallbackClassName="text-sm" />
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-72 rounded-xl border border-white/10 bg-[#0a0a0d]/95 backdrop-blur-sm shadow-xl overflow-hidden z-50">
          <div className="px-4 py-4 border-b border-white/10">
            <div className="flex items-center gap-3">
              <UserAvatar user={user} className="h-10 w-10" fallbackClassName="text-base" />
              <div className="min-w-0">
                <div className="text-white font-semibold truncate">
                  {displayName || menuT('user')}
                </div>
                {secondaryText ? <div className="text-white/50 text-xs truncate">{secondaryText}</div> : null}
              </div>
            </div>
          </div>

          <div className="py-2">
            <Link
              href="/user"
              onClick={() => setOpen(false)}
              className="flex items-center justify-between px-4 py-2 text-sm text-white/85 hover:bg-white/10 transition-colors"
            >
              {menuT('personalCenter')}
              <span className="text-white/40">{'>'}</span>
            </Link>

            <Link
              href="/asset"
              onClick={() => setOpen(false)}
              className="flex items-center justify-between px-4 py-2 text-sm text-white/85 hover:bg-white/10 transition-colors"
            >
              {menuT('assets')}
              <span className="text-white/40">{'>'}</span>
            </Link>

            <Link
              href="/notice"
              onClick={() => setOpen(false)}
              className="flex items-center justify-between px-4 py-2 text-sm text-white/85 hover:bg-white/10 transition-colors"
            >
              {menuT('notifications')}
              <span className="text-white/40">{'>'}</span>
            </Link>
          </div>

          <div className="p-3 border-t border-white/10">
            <button
              type="button"
              onClick={handleLogout}
              className="w-full h-10 rounded-lg bg-white/10 hover:bg-white/15 text-white font-semibold transition-colors"
            >
              {menuT('logout')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
