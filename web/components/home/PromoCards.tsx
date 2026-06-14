"use client";

import Link from "next/link";

import { useLocaleContext } from "@/contexts/LocaleContext";

export type PromoCardItem = {
  id: string;
  title: string;
  subtitle?: string;
  imageSrc?: string;
  href?: string;
};

export type PromoCardsProps = {
  items?: PromoCardItem[];
  loading?: boolean;
};

export default function PromoCards({ items, loading = false }: PromoCardsProps) {
  const { t } = useLocaleContext();
  const defaultCards: PromoCardItem[] = [
    {
      id: "1",
      title: t("promoAdvancedTradingTitle", "home"),
      subtitle: t("promoAdvancedTradingDesc", "home"),
      imageSrc: "/advancetrading1.png",
      href: "/trade",
    },
    {
      id: "2",
      title: t("promoSecureWalletTitle", "home"),
      subtitle: t("promoSecureWalletDesc", "home"),
      imageSrc: "/securewallet1.png",
      href: "/asset",
    },
    {
      id: "3",
      title: t("promoSupportTitle", "home"),
      subtitle: t("promoSupportDesc", "home"),
      imageSrc: "/247sup1.png",
      href: "/support",
    },
  ];
  const displayCards = items && items.length > 0 ? items : defaultCards;

  return (
    <section className="px-4 py-6 sm:px-6 sm:py-10">
      <div className="mx-auto grid w-full max-w-[1440px] grid-cols-1 gap-6 sm:gap-8 md:grid-cols-2 md:gap-10 lg:grid-cols-3">
        {loading &&
          [1, 2, 3].map((i) => (
            <div key={i} className="h-auto min-h-[120px] animate-pulse rounded-xl border border-white/15 bg-white/5 sm:min-h-[140px]" />
          ))}

        {!loading &&
          displayCards.map((item) => {
            const content = (
              <div className="group flex h-auto min-h-[120px] flex-col items-start gap-4 rounded-xl border border-white/15 bg-black/40 px-6 py-6 transition-all duration-300 hover:border-white/30 hover:bg-black/50 sm:min-h-[140px] sm:flex-row sm:items-start sm:gap-5 sm:px-10 sm:py-8">
                {item.imageSrc ? (
                  <div className="relative flex h-14 w-14 shrink-0 items-center justify-center overflow-visible p-2">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.imageSrc}
                      alt={item.title}
                      className="h-10 w-10 shrink-0 object-contain transition-transform duration-300 group-hover:scale-[1.08]"
                    />
                  </div>
                ) : (
                  <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-visible rounded-md bg-white/10 p-2">
                    <div className="h-6 w-6 rounded-full bg-white/20" />
                  </div>
                )}

                <div className="flex min-w-0 flex-1 flex-col pt-1 text-left">
                  <span className="truncate text-base font-semibold text-white/90 transition-colors duration-300 group-hover:text-amber-400">
                    {item.title}
                  </span>
                  {item.subtitle && (
                    <span className="mt-1 line-clamp-2 text-sm text-white/60">{item.subtitle}</span>
                  )}
                </div>
              </div>
            );

            return item.href ? (
              <Link key={item.id} href={item.href} className="block no-underline">
                {content}
              </Link>
            ) : (
              <div key={item.id}>{content}</div>
            );
          })}
      </div>
    </section>
  );
}
