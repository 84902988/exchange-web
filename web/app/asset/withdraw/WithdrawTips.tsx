"use client";

import { useState } from "react";
import { useLocaleContext } from "@/contexts/LocaleContext";
import type { Language } from "@/utils/language";

export default function WithdrawTips({
  currentLanguage: _currentLanguage,
}: {
  currentLanguage: Language | undefined;
}) {
  void _currentLanguage;
  const { t } = useLocaleContext();
  const [openFaqKey, setOpenFaqKey] = useState<string | null>(null);
  const faqItems = [
    {
      key: "pending",
      title: t("withdrawFaqPendingTitle", "asset"),
      answer: t("withdrawFaqPendingDesc", "asset"),
    },
    {
      key: "address",
      title: t("withdrawFaqAddressTitle", "asset"),
      answer: t("withdrawFaqAddressDesc", "asset"),
    },
    {
      key: "network",
      title: t("withdrawFaqNetworkTitle", "asset"),
      answer: t("withdrawFaqNetworkDesc", "asset"),
    },
  ];

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="text-sm font-semibold">{t("withdrawCrossDeviceConfirmTitle", "asset")}</div>

      <div className="mt-2 text-xs text-white/60 leading-5">
        {t("withdrawCrossDeviceConfirmDesc", "asset")}
      </div>

      <div className="mt-5 text-sm font-semibold">{t("withdrawFaqTitle", "asset")}</div>

      <div className="mt-3 space-y-3 text-sm text-white/70">
        {faqItems.map((item) => {
          const isOpen = openFaqKey === item.key;
          return (
            <div key={item.key} className="rounded-xl border border-white/10 bg-black/20">
              <button
                type="button"
                onClick={() => setOpenFaqKey(isOpen ? null : item.key)}
                className="flex w-full items-center justify-between gap-3 px-3 py-3 text-left text-white/80 transition-colors hover:text-white"
                aria-expanded={isOpen}
              >
                <span>{item.title}</span>
                <span className="text-lg leading-none text-white/45">{isOpen ? "-" : "+"}</span>
              </button>
              {isOpen ? (
                <div className="border-t border-white/10 px-3 pb-3 pt-2 text-xs leading-5 text-white/55">
                  {item.answer}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
