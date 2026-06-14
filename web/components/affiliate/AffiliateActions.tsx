"use client";

import Link from "next/link";

import { useLocaleContext } from "@/contexts/LocaleContext";
import { useAuth } from "@/lib/authContext";

const applyTarget = "/user/bd-team?apply";
const manageTarget = "/user/bd-team";

export default function AffiliateActions() {
  const { t } = useLocaleContext();
  const { isLoggedIn, authChecked } = useAuth();
  const isGuest = authChecked && !isLoggedIn;
  const applyHref = isGuest
    ? `/login?redirect=${encodeURIComponent(applyTarget)}`
    : applyTarget;
  const manageHref = isGuest
    ? `/login?redirect=${encodeURIComponent(manageTarget)}`
    : manageTarget;
  const applyText = isGuest ? t("affiliateActionLoginApply", "user") : t("affiliateActionApply", "user");

  return (
    <div className="mt-7 flex flex-wrap gap-3">
      <Link
        href={applyHref}
        className="rounded-2xl bg-[#f0b90b] px-5 py-3 text-sm font-bold text-black transition hover:bg-[#ffd55a]"
      >
        {applyText}
      </Link>
      <Link
        href={manageHref}
        className="rounded-2xl border border-white/12 bg-white/[0.04] px-5 py-3 text-sm font-semibold text-white transition hover:bg-white/[0.08]"
      >
        {t("affiliateActionManage", "user")}
      </Link>
    </div>
  );
}
