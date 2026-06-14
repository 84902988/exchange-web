"use client";

import React from "react";
import { useLocaleContext } from "@/contexts/LocaleContext";
import type { Language } from "@/utils/language";

export default function WithdrawTips({
  currentLanguage: _currentLanguage,
}: {
  currentLanguage: Language | undefined;
}) {
  void _currentLanguage;
  const { t } = useLocaleContext();

  return (
    <div className="rounded-2xl border border-white/10 bg-white/5 p-5">
      <div className="text-sm font-semibold">{t("withdrawCrossDeviceConfirmTitle", "asset")}</div>

      <div className="mt-2 text-xs text-white/60 leading-5">
        {t("withdrawCrossDeviceConfirmDesc", "asset")}
      </div>

      <div className="mt-5 text-sm font-semibold">{t("withdrawFaqTitle", "asset")}</div>

      <div className="mt-3 space-y-3 text-sm text-white/70">
        <div className="rounded-xl border border-white/10 bg-black/20 p-3 hover:bg-black/30 cursor-default">
          {t("withdrawFaqPendingTitle", "asset")}
        </div>

        <div className="rounded-xl border border-white/10 bg-black/20 p-3 hover:bg-black/30 cursor-default">
          {t("withdrawFaqWhitelistTitle", "asset")}
        </div>

        <div className="rounded-xl border border-white/10 bg-black/20 p-3 hover:bg-black/30 cursor-default">
          {t("withdrawFaqNetworkTitle", "asset")}
        </div>
      </div>
    </div>
  );
}
