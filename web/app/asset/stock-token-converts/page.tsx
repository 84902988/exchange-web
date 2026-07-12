"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import AssetSidebar from "@/components/asset/AssetSidebar";
import { useLocaleContext } from "@/contexts/LocaleContext";
import {
  getStockTokenConverts,
  type StockTokenConvertRecord,
} from "@/lib/api/modules/stockToken";

type AssetTranslator = (key: string, namespace?: "asset") => string;

function formatDate(value: string | null) {
  if (!value) return "--";
  return value.replace("T", " ").slice(0, 19);
}

function formatDisplayAmount(value: string | number | null | undefined) {
  const text = String(value ?? "").trim();
  if (!text) return "0";
  const numeric = Number(text);
  if (!Number.isFinite(numeric)) return text;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 4,
    useGrouping: false,
  }).format(numeric);
}

function statusLabel(status: string, t: AssetTranslator) {
  const normalized = status.trim().toUpperCase();
  if (normalized === "SUCCESS") return t("stockTokenConvertStatusSuccess", "asset");
  if (normalized === "FAILED") return t("stockTokenConvertStatusFailed", "asset");
  if (normalized === "PENDING") return t("stockTokenConvertStatusPending", "asset");
  return status || "--";
}

function StatusBadge({ status, t }: { status: string; t: AssetTranslator }) {
  const normalized = status.trim().toUpperCase();
  const className =
    normalized === "SUCCESS"
      ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
      : normalized === "FAILED"
        ? "border-red-400/20 bg-red-400/10 text-red-300"
        : "border-amber-300/20 bg-amber-300/10 text-amber-200";
  return <span className={`rounded-full border px-2.5 py-1 text-xs ${className}`}>{statusLabel(status, t)}</span>;
}

export default function StockTokenConvertsPage() {
  const { t } = useLocaleContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [items, setItems] = useState<StockTokenConvertRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadData = useCallback(async (aliveRef?: { alive: boolean }) => {
    setLoading(true);
    setError("");
    try {
      const data = await getStockTokenConverts();
      if (aliveRef && !aliveRef.alive) return;
      setItems(data.items);
    } catch (err) {
      if (aliveRef && !aliveRef.alive) return;
      console.error("Failed to load stock token convert records:", err);
      setError(t("stockTokenConvertHistoryLoadFailed", "asset"));
    } finally {
      if (!aliveRef || aliveRef.alive) {
        setLoading(false);
      }
    }
  }, [t]);

  useEffect(() => {
    const aliveRef = { alive: true };
    loadData(aliveRef);
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
              <h1 className="mt-2 text-3xl font-bold">{t("stockTokenConvertHistory", "asset")}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/50">
                {t("stockTokenConvertHistoryDesc", "asset")}
              </p>
            </div>
            <Link
              href="/asset/stock-token-locks"
              className="rounded-full border border-white/10 bg-white/[0.03] px-4 py-2 text-sm text-white/70 hover:bg-white/[0.06]"
            >
              {t("stockTokenConvertBackToLocks", "asset")}
            </Link>
          </div>

          {loading ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-6 py-16 text-center text-white/60">
              {t("stockTokenConvertHistoryLoading", "asset")}
            </div>
          ) : error ? (
            <div className="rounded-xl border border-red-400/20 bg-red-400/10 px-6 py-12 text-center">
              <div className="text-base font-semibold text-red-200">{error}</div>
              <button
                type="button"
                onClick={() => loadData()}
                className="mt-4 rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/15"
              >
                {t("stockTokenConvertReload", "asset")}
              </button>
            </div>
          ) : items.length === 0 ? (
            <div className="rounded-xl border border-white/10 bg-white/[0.03] px-6 py-16 text-center">
              <div className="text-base font-medium">{t("stockTokenConvertHistoryEmpty", "asset")}</div>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-white/10">
              <table className="min-w-[1040px] divide-y divide-white/10">
                <thead className="bg-white/[0.03]">
                  <tr className="text-left text-[11px] text-white/45">
                    <th className="whitespace-nowrap px-5 py-3 font-medium">{t("stockTokenConvertRecordId", "asset")}</th>
                    <th className="whitespace-nowrap px-5 py-3 font-medium">{t("equityCertificate", "asset")}</th>
                    <th className="whitespace-nowrap px-5 py-3 font-medium">{t("stockTokenConvertArrivalToken", "asset")}</th>
                    <th className="whitespace-nowrap px-5 py-3 font-medium">{t("stockTokenConvertAmount", "asset")}</th>
                    <th className="whitespace-nowrap px-5 py-3 font-medium">{t("stockTokenConvertArrivalAmount", "asset")}</th>
                    <th className="whitespace-nowrap px-5 py-3 font-medium">{t("conversionRate", "asset")}</th>
                    <th className="whitespace-nowrap px-5 py-3 font-medium">{t("stockTokenConvertStatus", "asset")}</th>
                    <th className="whitespace-nowrap px-5 py-3 font-medium">{t("stockTokenConvertTime", "asset")}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/10 bg-black/10">
                  {items.map((item) => (
                    <tr key={item.id} className="text-[13px] text-white/75">
                      <td className="whitespace-nowrap px-5 py-3 font-medium tabular-nums">{item.id}</td>
                      <td className="whitespace-nowrap px-5 py-3 font-medium text-white">{item.from_symbol}</td>
                      <td className="whitespace-nowrap px-5 py-3">{item.to_symbol}</td>
                      <td className="whitespace-nowrap px-5 py-3 font-medium tabular-nums">
                        {formatDisplayAmount(item.from_amount)} {item.from_symbol}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 font-medium tabular-nums text-emerald-200">
                        {formatDisplayAmount(item.to_amount)} {item.to_symbol}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 font-medium tabular-nums text-white/70">
                        1 : {formatDisplayAmount(item.conversion_rate)}
                      </td>
                      <td className="whitespace-nowrap px-5 py-3">
                        <StatusBadge status={item.status} t={t} />
                      </td>
                      <td className="whitespace-nowrap px-5 py-3 font-medium tabular-nums text-white/55">
                        {formatDate(item.created_at)}
                      </td>
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
