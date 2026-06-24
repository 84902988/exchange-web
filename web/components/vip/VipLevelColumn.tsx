import { useLocaleContext } from "@/contexts/LocaleContext";

import { VipLevelItem, VipSystemType } from "./vip.types";
import {
  formatAssetAmount,
  formatDiscountRate,
  formatFeeRate,
  formatLockPeriod,
  formatNumberLike,
  formatVolume,
  isCurrentLevel,
} from "./vip.utils";

interface VipLevelColumnProps {
  type: VipSystemType;
  level: VipLevelItem | null;
  currentLevelCode: string | null;
  className?: string;
}

type VipTranslator = (key: string, namespace?: "user" | "common") => string;

const VIP_LEVEL_NAME_KEYS: Record<string, string> = {
  NORMAL: "vipLevelNameNormal",
  VIP0: "vipLevelNameVIP0",
  VIP1: "vipLevelNameVIP1",
  VIP2: "vipLevelNameVIP2",
  VIP3: "vipLevelNameVIP3",
  VIP4: "vipLevelNameVIP4",
  VIP5: "vipLevelNameVIP5",
  VIP6: "vipLevelNameVIP6",
  VIP7: "vipLevelNameVIP7",
  VIP8: "vipLevelNameVIP8",
  VIP9: "vipLevelNameVIP9",
  SVIP0: "vipLevelNameSVIP0",
  SVIP1: "vipLevelNameSVIP1",
  SVIP2: "vipLevelNameSVIP2",
  SVIP3: "vipLevelNameSVIP3",
  SVIP4: "vipLevelNameSVIP4",
  SVIP5: "vipLevelNameSVIP5",
  SVIP6: "vipLevelNameSVIP6",
  SVIP7: "vipLevelNameSVIP7",
  SVIP8: "vipLevelNameSVIP8",
  SVIP9: "vipLevelNameSVIP9",
};

function getVipLevelDisplayName(
  t: VipTranslator,
  levelCode: string | null | undefined,
  fallbackName: string | null | undefined,
) {
  const normalizedCode = String(levelCode ?? "").trim().toUpperCase();
  if (!normalizedCode) {
    return fallbackName?.trim() || "--";
  }

  const translationKey = VIP_LEVEL_NAME_KEYS[normalizedCode];
  if (translationKey) {
    return t(translationKey, "user");
  }

  if (/^(VIP|SVIP)\d+$/.test(normalizedCode)) {
    return normalizedCode;
  }

  return fallbackName?.trim() || normalizedCode;
}

function renderField(label: string, value: string) {
  return (
    <div className="flex h-full min-h-[64px] min-w-0 flex-col rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3">
      <div className="text-[11px] uppercase tracking-[0.22em] text-slate-500">{label}</div>
      <div className="mt-2 text-sm font-medium text-slate-100">{value}</div>
    </div>
  );
}

function renderEmptyField() {
  return <div aria-hidden="true" className="h-full min-h-[64px] rounded-xl bg-white/[0.015]" />;
}

export default function VipLevelColumn({
  type,
  level,
  currentLevelCode,
  className,
}: VipLevelColumnProps) {
  const { t } = useLocaleContext();
  const isVip = type === "VIP";
  const highlighted = level ? isCurrentLevel(level.level_code, currentLevelCode) : false;
  const displayLevelName = level ? getVipLevelDisplayName(t, level.level_code, level.level_name) : "";

  return (
    <article
      className={`flex h-full w-full min-w-0 min-h-[284px] flex-col rounded-[24px] border p-5 transition-colors sm:p-6 ${
        highlighted
          ? "border-amber-400/35 bg-[linear-gradient(135deg,rgba(120,53,15,0.16),rgba(20,20,28,0.96))] shadow-[0_18px_50px_rgba(245,158,11,0.1)]"
          : "border-slate-700/60 bg-[linear-gradient(180deg,rgba(255,255,255,0.045),rgba(255,255,255,0.02))]"
      } ${className ?? ""}`}
    >
      {level === null ? (
        <div className="flex min-h-[244px] items-center justify-center rounded-xl bg-white/[0.02] px-5 text-center text-sm text-slate-500">
          {t("vipNoLevelConfig", "user")}
        </div>
      ) : (
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-[64px] flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <div className="text-xs uppercase tracking-[0.24em] text-slate-500">{level.level_code}</div>
              <h3 className="mt-2 text-xl font-semibold text-white">{displayLevelName}</h3>
            </div>
            {highlighted ? (
              <div className="inline-flex w-fit rounded-full border border-amber-300/25 bg-amber-400/10 px-3 py-1 text-xs font-medium text-amber-200">
                {t("currentMatchedLevel", "user")}
              </div>
            ) : null}
          </div>

          <div className="mt-4 grid min-w-0 flex-1 auto-rows-fr grid-cols-1 gap-4 sm:grid-cols-2">
            {isVip ? (
              <>
                {renderField(t("volume30d", "user"), formatVolume(level.condition.min_30d_volume))}
                {renderField(t("rcbUnlockedHold", "user"), formatAssetAmount(level.condition.min_rcb_hold))}
                {renderField(t("spotMaker", "user"), formatFeeRate(level.spot_maker_fee))}
                {renderField(t("spotTaker", "user"), formatFeeRate(level.spot_taker_fee))}
                {renderField(t("rcbDiscount", "user"), formatDiscountRate(level.rcb_discount_rate))}
                {renderEmptyField()}
              </>
            ) : (
              <>
                {renderField(t("rcbLockedAmount", "user"), formatAssetAmount(level.condition.min_lock_amount))}
                {renderField(
                  t("lockPeriod", "user"),
                  formatLockPeriod(
                    level.condition.lock_period_days,
                    t("vipLockPeriodNone", "user"),
                    t("vipLockPeriodDays", "user"),
                  ),
                )}
                {renderField(
                  t("userLimit", "user"),
                  level.condition.user_limit === null ? "--" : formatNumberLike(String(level.condition.user_limit)),
                )}
                {renderField(
                  t("dividendRate", "user"),
                  level.condition.dividend_rate === null
                    ? "--"
                    : formatDiscountRate(level.condition.dividend_rate).replace("-", ""),
                )}
                {renderField(t("spotMaker", "user"), formatFeeRate(level.spot_maker_fee))}
                {renderField(t("spotTaker", "user"), formatFeeRate(level.spot_taker_fee))}
              </>
            )}
          </div>
        </div>
      )}
    </article>
  );
}
