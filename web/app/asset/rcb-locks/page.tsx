"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import AssetSidebar from "@/components/asset/AssetSidebar";
import { useLocaleContext } from "@/contexts/LocaleContext";
import { getMyRcbLocks, type VipRcbLockRecord } from "@/lib/api/modules/vip";

function formatDate(value: string | null) {
  if (!value) return "--";
  return value.replace("T", " ").slice(0, 19);
}

function formatDisplayAmount(value: string | number | null | undefined) {
  if (value === null || value === undefined) return "--";
  const numeric = Number(String(value).trim());
  if (!Number.isFinite(numeric)) return "--";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
    useGrouping: false,
  }).format(numeric);
}

type RcbLockTranslator = (key: string, namespace?: "asset" | "common") => string;

function formatText(template: string, values: Record<string, string | number>) {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, String(value)), template);
}

function rcbLockStatusLabel(status: string | null | undefined, t: RcbLockTranslator) {
  const normalized = (status || "").toUpperCase();
  if (normalized === "LOCKED") return t("rcbLockStatusLocked", "asset");
  if (normalized === "NORMAL") return t("rcbLockStatusNormal", "asset");
  if (normalized === "ACTIVE") return t("rcbLockStatusActive", "asset");
  if (normalized === "EXPIRED") return t("rcbLockStatusExpired", "asset");
  if (normalized === "PENDING") return t("rcbLockStatusPending", "asset");
  return status || "--";
}

function rcbLockLevelLabel(level: string | null | undefined, t: RcbLockTranslator) {
  const normalized = (level || "").toUpperCase();
  if (!normalized) return "--";
  if (normalized === "NORMAL") return t("rcbLockLevelNormal", "asset");
  if (normalized === "VIP0") return t("rcbLockLevelVip0", "asset");
  return level || "--";
}

function StatusBadge({ status, t }: { status: string; t: RcbLockTranslator }) {
  const normalized = status.toUpperCase();
  const className =
    normalized === "LOCKED"
      ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
      : "border-white/10 bg-white/[0.04] text-white/60";
  return <span className={`rounded-full border px-2.5 py-1 text-xs ${className}`}>{rcbLockStatusLabel(status, t)}</span>;
}

export default function AssetRcbLocksPage() {
  const { t } = useLocaleContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [items, setItems] = useState<VipRcbLockRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadData = useCallback(async (aliveRef?: { alive: boolean }) => {
    setLoading(true);
    setError("");
    try {
      const data = await getMyRcbLocks();
      if (aliveRef && !aliveRef.alive) return;
      setItems(data.items);
    } catch (err) {
      if (aliveRef && !aliveRef.alive) return;
      console.error("Failed to load RCB locks:", err);
      setError(t("rcbLocksLoadFailed", "asset"));
    } finally {
      if (!aliveRef || aliveRef.alive) {
        setLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    const aliveRef = { alive: true };
    void loadData(aliveRef);
    return () => {
      aliveRef.alive = false;
    };
  }, [loadData]);

  return (
    <main className="flex min-h-screen bg-[#0a0a0d] py-8 text-white">
      <AssetSidebar
        isCollapsed={isSidebarCollapsed}
        onToggle={() => setIsSidebarCollapsed((value) => !value)}
      />

      <div className="w-full px-4 py-10 lg:w-4/5">
        <div className="mx-auto max-w-7xl space-y-6">
          <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="text-sm font-medium text-amber-300">{t("rcbLocksEyebrow", "asset")}</div>
              <h1 className="mt-2 text-3xl font-bold">{t("rcbLockRecords", "asset")}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/50">
                {t("rcbLocksDesc", "asset")}
              </p>
            </div>
            <Link
              href="/vip"
              className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-white/70 hover:bg-white/[0.06]"
            >
              {t("rcbLocksBackVip", "asset")}
            </Link>
          </div>

          {loading ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-6 py-16 text-center text-white/60">
              {t("rcbLocksLoading", "asset")}
            </div>
          ) : error ? (
            <div className="rounded-xl border border-red-400/20 bg-red-400/10 px-6 py-12 text-center">
              <div className="text-base font-semibold text-red-200">{error}</div>
              <button
                type="button"
                onClick={() => void loadData()}
                className="mt-4 rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15"
              >
                {t("reload", "common")}
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-6 py-16 text-center">
              <div className="text-base font-medium">{t("rcbLocksEmpty", "asset")}</div>
            </div>
          ) : (
            <div className="w-full overflow-x-auto rounded-xl border border-white/10">
              <table className="min-w-full w-full table-auto divide-y divide-white/10">
                <thead className="bg-white/[0.03]">
                  <tr className="text-left text-xs uppercase tracking-[0.12em] text-white/40">
                    <th className="whitespace-nowrap px-5 py-4 font-medium">{t("rcbLockAmount", "asset")}</th>
                    <th className="whitespace-nowrap px-5 py-4 font-medium">{t("lockPeriod", "asset")}</th>
                    <th className="whitespace-nowrap px-5 py-4 font-medium">{t("startTime", "asset")}</th>
                    <th className="whitespace-nowrap px-5 py-4 font-medium">{t("endTime", "asset")}</th>
                    <th className="whitespace-nowrap px-5 py-4 font-medium">{t("status", "asset")}</th>
                    <th className="w-auto px-5 py-4 font-medium">{t("rcbLockCurrentSvip", "asset")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10 bg-black/10">
                  {items.map((item) => (
                    <tr key={item.id} className="text-sm text-white/75">
                      <td className="whitespace-nowrap px-5 py-4 font-medium text-white">
                        {formatDisplayAmount(item.lock_amount)} {item.asset_symbol}
                      </td>
                      <td className="whitespace-nowrap px-5 py-4">
                        {formatText(t("rcbLockPeriodDays", "asset"), { days: item.lock_period_days })}
                      </td>
                      <td className="whitespace-nowrap px-5 py-4 text-white/55">{formatDate(item.start_time)}</td>
                      <td className="whitespace-nowrap px-5 py-4 text-white/55">{formatDate(item.end_time)}</td>
                      <td className="whitespace-nowrap px-5 py-4">
                        <StatusBadge status={item.status} t={t} />
                      </td>
                      <td className="px-5 py-4 text-amber-200">{rcbLockLevelLabel(item.current_svip, t)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
