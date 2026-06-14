'use client';

import Link from 'next/link';

import { MegaMenu as MegaMenuType } from '@/config/menuConfig';
import { useLocaleContext } from '@/contexts/LocaleContext';

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
  const isSingleGroup = megaMenu.groups.length === 1;

  return (
    <div
      className="absolute left-0 top-full z-50 pt-4"
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div
        className={`rounded-xl border border-white/10 bg-[#05070a] p-5 shadow-2xl shadow-black/60 ${
          isSingleGroup ? 'w-[280px]' : 'w-[560px]'
        }`}
      >
        <div className={`grid gap-5 ${isSingleGroup ? 'grid-cols-1' : 'grid-cols-2'}`}>
          {megaMenu.groups.map((group) => (
            <section key={group.titleKey} className="min-w-0">
              <h3 className="mb-3 text-sm font-semibold text-white">
                {t(group.titleKey, 'common')}
              </h3>
              <div className="space-y-1">
                {group.items.map((item) => (
                  <Link
                    key={item.href}
                    href={item.href}
                    onClick={onItemClick}
                    className="block rounded-lg px-3 py-2.5 text-sm font-medium text-white/60 transition-colors hover:bg-white/[0.06] hover:text-[#f0b90b]"
                  >
                    {t(item.labelKey, 'common')}
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
