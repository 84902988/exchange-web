'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';

import { menuConfig, Language } from '@/config/menuConfig';
import MegaMenu from './MegaMenu';
import { DEFAULT_LANGUAGE, getCurrentLanguage, setCurrentLanguage } from '@/utils/language';
import { useAuth } from '@/lib/authContext';
import UserDropdown from '@/components/layout/UserDropdown';
import { fallbackSiteConfig, getSiteConfig } from '@/lib/api/modules/site';
import { getAnnouncementUnreadCount } from '@/lib/api/modules/announcements';
import MobileMenu from './MobileMenu';
import { useLocaleContext } from '@/contexts/LocaleContext';
import enTranslations from '@/config/locales/en.json';

const FALLBACK_LOGO_URL = fallbackSiteConfig.logo_url || '/icons/logo-1.svg';
const FALLBACK_SITE_NAME = fallbackSiteConfig.site_name || 'Royal Exchange';
const FALLBACK_SITE_SLOGAN = fallbackSiteConfig.site_slogan || '';
const DEFAULT_COMMON_TRANSLATIONS = (enTranslations as { common: Record<string, string> }).common;


export default function Header() {
  const { isLoggedIn } = useAuth();
  const { t } = useLocaleContext();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchKey = searchParams.toString();

  const [mounted, setMounted] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const menuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [showModal, setShowModal] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showQR, setShowQR] = useState(false);

  const [currentLanguage, setCurrentLanguageState] = useState<Language>(DEFAULT_LANGUAGE);
  const [siteBrand, setSiteBrand] = useState({
    logoUrl: FALLBACK_LOGO_URL,
    siteName: FALLBACK_SITE_NAME,
    siteSlogan: '',
  });
  const [unreadAnnouncements, setUnreadAnnouncements] = useState(0);
  const stableIsLoggedIn = mounted && isLoggedIn;

  useEffect(() => {
    const timer = window.setTimeout(() => setMounted(true), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const syncTimer = window.setTimeout(() => {
      setCurrentLanguageState(getCurrentLanguage());
    }, 0);

    const handleLanguageChanged = (event: Event) => {
      setCurrentLanguageState((event as CustomEvent<Language>).detail);
    };

    window.addEventListener('languageChanged', handleLanguageChanged);
    return () => {
      window.clearTimeout(syncTimer);
      window.removeEventListener('languageChanged', handleLanguageChanged);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    getSiteConfig(currentLanguage)
      .then((config) => {
        if (cancelled) return;
        setSiteBrand({
          logoUrl: config.logo_url || FALLBACK_LOGO_URL,
          siteName: config.site_name || FALLBACK_SITE_NAME,
          siteSlogan: config.site_slogan ?? FALLBACK_SITE_SLOGAN,
        });
      })
      .catch(() => {
        if (cancelled) return;
        setSiteBrand({
          logoUrl: FALLBACK_LOGO_URL,
          siteName: FALLBACK_SITE_NAME,
          siteSlogan: FALLBACK_SITE_SLOGAN,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [currentLanguage]);

  useEffect(() => {
    let cancelled = false;

    async function loadUnreadAnnouncements() {
      if (!mounted || !isLoggedIn) {
        setUnreadAnnouncements(0);
        return;
      }
      try {
        const data = await getAnnouncementUnreadCount();
        if (!cancelled) {
          setUnreadAnnouncements(Math.max(Number(data.unread_count || 0), 0));
        }
      } catch {
        if (!cancelled) {
          setUnreadAnnouncements(0);
        }
      }
    }

    loadUnreadAnnouncements();
    window.addEventListener('announcement-reads:changed', loadUnreadAnnouncements);
    return () => {
      cancelled = true;
      window.removeEventListener('announcement-reads:changed', loadUnreadAnnouncements);
    };
  }, [mounted, isLoggedIn, pathname]);

  const updateLanguage = (language: Language) => {
    setCurrentLanguage(language);
    setCurrentLanguageState(language);
    window.dispatchEvent(new CustomEvent('languageChanged', { detail: language }));
  };

  const closeMegaMenu = () => {
    if (menuTimerRef.current) {
      clearTimeout(menuTimerRef.current);
      menuTimerRef.current = null;
    }
    setActiveMenu(null);
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      if (menuTimerRef.current) {
        clearTimeout(menuTimerRef.current);
        menuTimerRef.current = null;
      }
      setActiveMenu(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [pathname, searchKey]);

  const handleMenuHover = (label: string) => {
    if (menuTimerRef.current) {
      clearTimeout(menuTimerRef.current);
      menuTimerRef.current = null;
    }
    setActiveMenu(label);
  };

  const handleMenuLeave = () => {
    const timer = setTimeout(() => setActiveMenu(null), 350);
    menuTimerRef.current = timer;
  };

  const handleMegaMenuHover = () => {
    if (menuTimerRef.current) {
      clearTimeout(menuTimerRef.current);
      menuTimerRef.current = null;
    }
  };

  const handleMegaMenuLeave = () => {
    const timer = setTimeout(() => setActiveMenu(null), 350);
    menuTimerRef.current = timer;
  };

  const handleLanguageClick = () => setShowModal(true);
  const handleCloseModal = () => setShowModal(false);

  const handleChangeLanguage = (lang: Language) => {
    updateLanguage(lang);
    setShowModal(false);
  };

  const handleSearchClick = () => setShowSearch((v) => !v);

  const handleDownloadHover = () => setShowQR(true);
  const handleDownloadLeave = () => setShowQR(false);

  const [showMobileMenu, setShowMobileMenu] = useState(false);
  const headerT = (key: string) => (mounted ? t(key, 'common') : DEFAULT_COMMON_TRANSLATIONS[key] || key);

  return (
    <>
      <header className="relative flex h-14 items-center justify-between border-b border-white/10 bg-[#0a0a0d] px-3.5">
        {/* Left: Logo + Nav */}
        <div className="flex items-center gap-4">
          <Link href="/" className="flex items-center gap-2.5 hover:opacity-90 transition-opacity duration-200">
            {siteBrand.logoUrl && (
              <div className="h-9 w-9 overflow-hidden rounded-md">
                {siteBrand.logoUrl.startsWith('/') ? (
                  <Image
                    src={siteBrand.logoUrl}
                    alt={siteBrand.siteName}
                    width={72}
                    height={72}
                    className="h-full w-full object-contain"
                    priority
                    quality={100}
                    sizes="36px"
                  />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={siteBrand.logoUrl} alt={siteBrand.siteName} className="h-full w-full object-contain" />
                )}
              </div>
            )}
            <div className="flex min-w-0 flex-col justify-center leading-tight">
              <div className="truncate text-sm font-bold text-amber-400">{siteBrand.siteName}</div>
              {siteBrand.siteSlogan && (
                <div className="hidden max-w-48 truncate text-[10px] font-medium text-white/45 lg:block">
                  {siteBrand.siteSlogan}
                </div>
              )}
            </div>
          </Link>

          <nav className="hidden items-center gap-7 md:flex">
            {menuConfig.items.map((item) => {
              const hasMegaMenu = 'megaMenu' in item;
              const translatedLabel = headerT(item.labelKey);

              return (
                <div
                  key={item.labelKey}
                  className="relative"
                  onMouseEnter={() => {
                    if (hasMegaMenu) handleMenuHover(item.labelKey);
                  }}
                  onMouseLeave={() => {
                    if (hasMegaMenu) handleMenuLeave();
                  }}
                >
                  {hasMegaMenu ? (
                    <button
                      type="button"
                      onClick={() => handleMenuHover(item.labelKey)}
                      className="text-base font-semibold text-white/85 transition-colors duration-200 hover:text-white"
                    >
                      {translatedLabel}
                    </button>
                  ) : (
                    <Link
                      href={item.href}
                      className="text-base font-semibold text-white/85 transition-colors duration-200 hover:text-white"
                    >
                      {translatedLabel}
                    </Link>
                  )}

                  {item.megaMenu && activeMenu === item.labelKey && (
                    <MegaMenu
                      megaMenu={item.megaMenu}
                      onMouseEnter={handleMegaMenuHover}
                      onMouseLeave={handleMegaMenuLeave}
                      onItemClick={closeMegaMenu}
                    />
                  )}
                </div>
              );
            })}
          </nav>
        </div>

        <div className="flex items-center gap-3.5">
          {!mounted ? (
            <div
              className="hidden h-9 w-[148px] md:block"
              aria-hidden="true"
            />
          ) : !stableIsLoggedIn ? (
            <div className="hidden md:flex items-center gap-3.5">
              <Link href="/login" className="text-sm font-semibold text-white/80 hover:text-white transition-colors duration-200">
                {headerT('login')}
              </Link>

              <Link
                href="/register"
                className="ml-2 inline-flex h-9 items-center rounded-md bg-white px-4 text-sm font-semibold text-black hover:bg-white/90 transition-colors duration-200"
              >
                {headerT('register')}
              </Link>
            </div>
          ) : null}

          <div className="relative">
            <button
              onClick={handleSearchClick}
              className="grid h-9 w-9 place-items-center rounded-md border border-white/0 bg-transparent text-white/90 hover:bg-white/10 transition-colors duration-200"
              aria-label={headerT('search')}
            >
              <Image src="/icons/header-search-1.svg" alt={headerT('search')} width={11} height={11} className="object-contain" />
            </button>
          </div>

          <Link href="/notice" className="relative">
            <button
              className="grid h-9 w-9 place-items-center rounded-md border border-white/0 bg-transparent text-white/90 hover:bg-white/10 transition-colors duration-200"
              aria-label={headerT('notice')}
            >
              <Image src="/icons/header-notice-1.svg" alt={headerT('notice')} width={13} height={13} className="object-contain" />
            </button>
            {mounted && unreadAnnouncements > 0 && (
              <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-red-500 px-1.5 py-0.5 text-center text-[10px] font-bold leading-none text-white shadow-sm">
                {unreadAnnouncements > 99 ? '99+' : unreadAnnouncements}
              </span>
            )}
          </Link>

          {stableIsLoggedIn && (
            <>
              <div className="relative">
                <button
                  onMouseEnter={handleDownloadHover}
                  onMouseLeave={handleDownloadLeave}
                  className="grid h-9 w-9 place-items-center rounded-md border border-white/0 bg-transparent text-white/90 hover:bg-white/10 transition-colors duration-200"
                  aria-label={headerT('download')}
                >
                  <Image src="/icons/header-download-1.svg" alt={headerT('download')} width={13} height={13} className="object-contain" />
                </button>

                {showQR && (
                  <div
                    className="absolute right-0 mt-2 rounded-md border border-white/10 bg-black/80 backdrop-blur-sm p-4"
                    onMouseEnter={handleDownloadHover}
                    onMouseLeave={handleDownloadLeave}
                  >
                    <div className="flex h-32 w-32 items-center justify-center rounded bg-white/5">
                      <div className="text-sm text-white/70">{headerT('qrCode')}</div>
                    </div>
                  </div>
                )}
              </div>

              <Link href="/asset">
                <button
                  className="grid h-9 w-9 place-items-center rounded-md border border-white/0 bg-transparent text-white/90 hover:bg-white/10 transition-colors duration-200"
                  aria-label={headerT('asset')}
                >
                  <Image
                    src="/icons/header-money-1.svg"
                    alt={headerT('asset')}
                    width={13}
                    height={13}
                    className="object-contain transform translate-y-[15%]"
                  />
                </button>
              </Link>

              <UserDropdown />
            </>
          )}
          
          <button
            onClick={() => setShowMobileMenu(true)}
            className="md:hidden grid h-9 w-9 place-items-center rounded-md text-white/90 hover:bg-white/10"
            aria-label={headerT('menu')}
          >
            {'\u2630'}
          </button>

          <button
            onClick={handleLanguageClick}
            className="grid h-9 w-9 place-items-center rounded-md border border-white/0 bg-transparent text-white/90 hover:bg-white/10 transition-colors duration-200"
            aria-label={headerT('language')}
          >
            <Image src="/icons/header-language-1.svg" alt={headerT('language')} width={13} height={13} className="object-contain" />
          </button>
        </div>

        {showModal && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-[#02040a]/85 backdrop-blur-[2px]">
            <div className="relative z-10 w-80 rounded-lg border border-white/10 bg-[#0a0a0d] p-6">
              <div className="mb-4 flex items-center justify-between">
                <h3 className="text-white font-medium">{headerT('language')}</h3>
                <button
                  onClick={handleCloseModal}
                  className="text-white/50 hover:text-white transition-colors"
                  aria-label={headerT('close')}
                >
                  {'\u00d7'}
                </button>
              </div>

              <div className="space-y-2">
                <button
                  className={`w-full rounded px-3 py-2 text-left transition-colors ${
                    currentLanguage === 'zh'
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'hover:bg-white/10 text-white'
                  }`}
                  onClick={() => handleChangeLanguage('zh')}
                >
                  {'\u7b80\u4f53\u4e2d\u6587'}
                </button>

                <button
                  className={`w-full rounded px-3 py-2 text-left transition-colors ${
                    currentLanguage === 'zh-TW'
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'hover:bg-white/10 text-white'
                  }`}
                  onClick={() => handleChangeLanguage('zh-TW')}
                >
                  {'\u7e41\u9ad4\u4e2d\u6587'}
                </button>

                <button
                  className={`w-full rounded px-3 py-2 text-left transition-colors ${
                    currentLanguage === 'en'
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'hover:bg-white/10 text-white'
                  }`}
                  onClick={() => handleChangeLanguage('en')}
                >
                  English
                </button>

                <button
                  className={`w-full rounded px-3 py-2 text-left transition-colors ${
                    currentLanguage === 'ja'
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'hover:bg-white/10 text-white'
                  }`}
                  onClick={() => handleChangeLanguage('ja')}
                >
                  {'\u65e5\u672c\u8a9e'}
                </button>
              </div>
            </div>
          </div>
        )}
      </header>
      
      <MobileMenu
        open={showMobileMenu}
        onClose={() => setShowMobileMenu(false)}
        isLoggedIn={stableIsLoggedIn}
        menuItems={menuConfig.items}
      />

      {showSearch && (
        <div className="border-b border-white/10 bg-[#0a0a0d] px-3.5 py-3">
          <div className="mx-auto max-w-7xl">
            <div className="relative">
              <input
                type="text"
                placeholder={headerT('searchPlaceholder')}
                className="h-10 w-full rounded-md border border-white/15 bg-white/10 px-4 py-2 text-sm text-white placeholder-white/50 outline-none focus:border-amber-500 transition-colors duration-200"
                autoFocus
              />
              <button
                onClick={handleSearchClick}
                className="absolute right-3 top-1/2 grid h-6 w-6 -translate-y-1/2 place-items-center text-white/50 hover:text-white transition-colors duration-200"
                aria-label={headerT('closeSearch')}
              >
                {'\u00d7'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
