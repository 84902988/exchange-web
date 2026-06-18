'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { MegaMenu as MegaMenuType } from '@/config/menuConfig';
import { useLocaleContext } from '@/contexts/LocaleContext';
import enTranslations from '@/config/locales/en.json';

const DEFAULT_COMMON_TRANSLATIONS = (enTranslations as { common: Record<string, string> }).common;

interface MegaMenuProps {
  megaMenu: MegaMenuType;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
  onItemClick?: () => void;
}

export default function MegaMenu({
  megaMenu,
  onMouseEnter,
  onMouseLeave,
  onItemClick,
}: MegaMenuProps) {
  const { t } = useLocaleContext();
  const [mounted, setMounted] = useState(false);
  const isSingleGroup = megaMenu.groups.length === 1;
  const menuT = (key: string) => (mounted ? t(key, 'common') : DEFAULT_COMMON_TRANSLATIONS[key] || key);

  useEffect(() => {
    const timer = window.setTimeout(() => setMounted(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      className="absolute left-0 top-full z-50 pt-4"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div
        className={`rounded-xl border border-white/10 bg-[#05070a] p-4 shadow-2xl shadow-black/60 ${
          isSingleGroup ? 'w-[280px]' : 'w-[560px]'
        }`}
      >
        <div className={`grid gap-5 ${isSingleGroup ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {megaMenu.groups.map((group) => (
            <section key={group.titleKey} className="min-w-0">
              <h3 className="mb-2 px-3 text-xs font-medium leading-5 text-white/45">
                {menuT(group.titleKey)}
              </h3>
              <div className="space-y-1">
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onItemClick}
                    className="flex h-10 items-center rounded-lg px-3 text-sm font-medium leading-5 text-white/65 transition-colors hover:bg-white/[0.06] hover:text-[#f0b90b]"
                  >
                    {menuT(item.labelKey)}
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
