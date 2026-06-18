'use client';

// import Link from 'next/link';
import { useState, useEffect } from 'react';
import { fallbackSiteConfig, getSiteConfig } from '@/lib/api/modules/site';
import { useLocaleContext } from '@/contexts/LocaleContext';
import enTranslations from '@/config/locales/en.json';

const FALLBACK_SITE_NAME = fallbackSiteConfig.site_name || 'Royal Exchange';
const FALLBACK_SUPPORT_EMAIL = fallbackSiteConfig.support_email || '';
const FALLBACK_RISK_DISCLAIMER = fallbackSiteConfig.risk_disclaimer || '';
const FALLBACK_FOOTER_DISCLAIMER = fallbackSiteConfig.footer_disclaimer || '';
const DEFAULT_COMMON_TRANSLATIONS = (enTranslations as { common: Record<string, string> }).common;

export default function Footer() {
  const { locale, t } = useLocaleContext();
  const [mounted, setMounted] = useState(false);
  const [siteFooter, setSiteFooter] = useState({
    siteName: FALLBACK_SITE_NAME,
    supportEmail: '',
    riskDisclaimer: '',
    footerDisclaimer: '',
    showRiskLink: fallbackSiteConfig.show_risk_link ?? true,
    riskLinkUrl: fallbackSiteConfig.risk_link_url || '',
    showTermsLink: fallbackSiteConfig.show_terms_link ?? true,
    termsLinkUrl: fallbackSiteConfig.terms_link_url || '',
    showPrivacyLink: fallbackSiteConfig.show_privacy_link ?? true,
    privacyLinkUrl: fallbackSiteConfig.privacy_link_url || '',
  });

  useEffect(() => {
    const timer = window.setTimeout(() => setMounted(true), 0);
    return () => window.clearTimeout(timer);
  }, []);
  
  useEffect(() => {
    let cancelled = false;

    getSiteConfig(locale)
      .then((config) => {
        if (cancelled) return;
        setSiteFooter({
          siteName: config.site_name || FALLBACK_SITE_NAME,
          supportEmail: config.support_email ?? FALLBACK_SUPPORT_EMAIL,
          riskDisclaimer: config.risk_disclaimer ?? FALLBACK_RISK_DISCLAIMER,
          footerDisclaimer: config.footer_disclaimer ?? FALLBACK_FOOTER_DISCLAIMER,
          showRiskLink: config.show_risk_link ?? fallbackSiteConfig.show_risk_link ?? true,
          riskLinkUrl: config.risk_link_url ?? fallbackSiteConfig.risk_link_url ?? '',
          showTermsLink: config.show_terms_link ?? fallbackSiteConfig.show_terms_link ?? true,
          termsLinkUrl: config.terms_link_url ?? fallbackSiteConfig.terms_link_url ?? '',
          showPrivacyLink: config.show_privacy_link ?? fallbackSiteConfig.show_privacy_link ?? true,
          privacyLinkUrl: config.privacy_link_url ?? fallbackSiteConfig.privacy_link_url ?? '',
        });
      })
      .catch(() => {
        if (cancelled) return;
        setSiteFooter({
          siteName: FALLBACK_SITE_NAME,
          supportEmail: FALLBACK_SUPPORT_EMAIL,
          riskDisclaimer: FALLBACK_RISK_DISCLAIMER,
          footerDisclaimer: FALLBACK_FOOTER_DISCLAIMER,
          showRiskLink: fallbackSiteConfig.show_risk_link ?? true,
          riskLinkUrl: fallbackSiteConfig.risk_link_url || '',
          showTermsLink: fallbackSiteConfig.show_terms_link ?? true,
          termsLinkUrl: fallbackSiteConfig.terms_link_url || '',
          showPrivacyLink: fallbackSiteConfig.show_privacy_link ?? true,
          privacyLinkUrl: fallbackSiteConfig.privacy_link_url || '',
        });
      });

    return () => {
      cancelled = true;
    };
  }, [locale]);

  const footerLinks = [
    {
      visible: siteFooter.showRiskLink,
      label: mounted ? t('riskWarning', 'common') : DEFAULT_COMMON_TRANSLATIONS.riskWarning,
      href: siteFooter.riskLinkUrl,
    },
    {
      visible: siteFooter.showTermsLink,
      label: mounted ? t('termsOfService', 'common') : DEFAULT_COMMON_TRANSLATIONS.termsOfService,
      href: siteFooter.termsLinkUrl,
    },
    {
      visible: siteFooter.showPrivacyLink,
      label: mounted ? t('privacyPolicy', 'common') : DEFAULT_COMMON_TRANSLATIONS.privacyPolicy,
      href: siteFooter.privacyLinkUrl,
    },
  ].filter((item) => item.visible);
  const footerLinkKey = (item: (typeof footerLinks)[number] & { id?: string; key?: string }, index: number) =>
    item.id || item.key || `${item.href || 'plain'}-${index}`;

  return (
    <footer className="bg-[#0b0b0f] border-t border-white/10 py-6">
      <div className="max-w-[1440px] mx-auto px-6">
        <div className="flex flex-col items-center gap-4">
          <div className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-sm">
            <div className="text-white/50">
              @2026 {siteFooter.siteName}
            </div>
            {siteFooter.supportEmail && (
              <>
                <span className="text-white/30">|</span>
                <div className="text-white/50">
                  {mounted ? t('support', 'common') : DEFAULT_COMMON_TRANSLATIONS.support}: {siteFooter.supportEmail}
                </div>
              </>
            )}
          </div>

          {footerLinks.length > 0 && (
            <div className="flex flex-wrap justify-center gap-x-6 gap-y-2 text-sm">
              {footerLinks.map((item, index) => {
                const key = footerLinkKey(item, index);
                return item.href ? (
                  <a key={key} href={item.href} className="text-white/70 transition-colors hover:text-white">
                    {item.label}
                  </a>
                ) : (
                  <span key={key} className="text-white/70">
                    {item.label}
                  </span>
                );
              })}
            </div>
          )}

          {(siteFooter.footerDisclaimer || siteFooter.riskDisclaimer) && (
            <div className="flex max-w-3xl flex-col gap-2 text-center text-xs leading-relaxed text-white/40">
              {siteFooter.footerDisclaimer && (
                <div className="whitespace-pre-line">
                  {siteFooter.footerDisclaimer}
                </div>
              )}
              {siteFooter.riskDisclaimer && (
                <div className="whitespace-pre-line border-t border-white/10 pt-2">
                  {siteFooter.riskDisclaimer}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </footer>
  );
}
