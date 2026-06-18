'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/authContext';
import { MenuItem } from '@/config/menuConfig';
import { canShowMenu } from '@/utils/menuAuth';
import { useLocaleContext } from '@/contexts/LocaleContext';
import enTranslations from '@/config/locales/en.json';

const DEFAULT_COMMON_TRANSLATIONS = (enTranslations as { common: Record<string, string> }).common;

interface MobileMenuProps {
  open: boolean;
  onClose: () => void;
  isLoggedIn: boolean;
  menuItems: MenuItem[];
}

export default function MobileMenu({
  open,
  onClose,
  isLoggedIn,
  menuItems,
}: MobileMenuProps) {
  const { logout } = useAuth();
  const router = useRouter();
  const { t } = useLocaleContext();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    document.body.style.overflow = open ? 'hidden' : '';
    return () => {
      document.body.style.overflow = '';
    };
  }, [open]);

  useEffect(() => {
    const timer = window.setTimeout(() => setMounted(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  const visibleMenuItems = menuItems.filter((item) => canShowMenu(item, isLoggedIn));
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  const normalizeGroup = (item: MenuItem) => item.group ?? 'main';
  const menuT = (key: string) => (mounted ? t(key, 'common') : DEFAULT_COMMON_TRANSLATIONS[key] || key);

  const groupedMenu = {
    main: visibleMenuItems.filter((i) => normalizeGroup(i) === 'main'),
    trade: visibleMenuItems.filter((i) => normalizeGroup(i) === 'trade'),
    asset: visibleMenuItems.filter((i) => normalizeGroup(i) === 'asset'),
    user: visibleMenuItems.filter((i) => normalizeGroup(i) === 'user'),
    extra: visibleMenuItems.filter((i) => normalizeGroup(i) === 'extra'),
  };

  return (
    <div
      className={`fixed inset-0 z-50 md:hidden transition-all duration-300 ${
        open ? 'pointer-events-auto' : 'pointer-events-none'
      }`}
    >
      <div
        className={`absolute inset-0 bg-black/60 transition-opacity duration-300 ${
          open ? 'opacity-100' : 'opacity-0'
        }`}
        onClick={onClose}
      />

      <div
        className={`absolute left-0 top-0 h-full w-4/5 max-w-xs bg-[#0a0a0d]
        border-r border-white/10 p-4 overflow-y-auto
        transform transition-transform duration-300
        ${open ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div className="flex items-center justify-between mb-6">
          <span className="text-sm font-semibold text-amber-400">{menuT('menu')}</span>
          <button
            onClick={onClose}
            className="text-white/60 hover:text-white"
            aria-label={menuT('close')}
          >
            {'\u00d7'}
          </button>
        </div>

        <nav className="space-y-6">
          {groupedMenu.main.map((item) => {
            const hasMegaMenu = !!item.megaMenu;
            const isOpen = openGroup === item.labelKey;

            return (
              <div key={item.labelKey} className="space-y-1">
                {hasMegaMenu ? (
                  <button
                    onClick={() => setOpenGroup(isOpen ? null : item.labelKey)}
                    className="w-full text-left text-sm font-medium text-white/85 hover:text-white transition-colors"
                  >
                    {menuT(item.labelKey)}
                  </button>
                ) : (
                  <Link
                    href={item.href}
                    onClick={onClose}
                    className="block text-sm font-medium text-white/85 hover:text-white transition-colors"
                  >
                    {menuT(item.labelKey)}
                  </Link>
                )}

                {hasMegaMenu && isOpen && (
                  <div className="pl-4 mt-1 space-y-2 border-l border-white/10">
                    {item.megaMenu?.groups.map((group) => (
                      <div key={group.titleKey} className="space-y-1">
                        <div className="text-xs text-white/40 uppercase tracking-wide">
                          {menuT(group.titleKey)}
                        </div>
                        {group.items.map((subItem) => (
                          <Link
                            key={subItem.href}
                            href={subItem.href}
                            onClick={onClose}
                            className="block text-sm text-white/85 hover:text-white pl-2"
                          >
                            {menuT(subItem.labelKey)}
                          </Link>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="my-6 h-px bg-white/10" />

        {!isLoggedIn && (
          <div className="space-y-3">
            <Link
              href="/login"
              onClick={onClose}
              className="block text-sm font-semibold text-amber-400"
            >
              {menuT('login')}
            </Link>

            <Link
              href="/register"
              onClick={onClose}
              className="block text-sm font-semibold text-amber-400"
            >
              {menuT('register')}
            </Link>
          </div>
        )}

        {isLoggedIn && (
          <div className="space-y-4">
            <div className="text-xs text-white/50">
              {menuT('account')}
            </div>

            <Link
              href="/user"
              onClick={onClose}
              className="block text-sm font-medium text-white/85 hover:text-white"
            >
              {menuT('personalCenter')}
            </Link>

            <button
              onClick={() => {
                logout();
                onClose();
                router.push('/');
              }}
              className="block w-full text-left text-sm font-medium text-red-400 hover:text-red-300"
              type="button"
            >
              {menuT('logout')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
