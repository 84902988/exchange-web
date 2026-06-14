"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import UserSidebar from "@/components/user/UserSidebar";
import { useLocaleContext } from "@/contexts/LocaleContext";
import {
  getMyDividendRecords,
  getMyDividendSummary,
  type MyDividendRecord,
  type MyDividendSummary,
} from "@/lib/api/modules/dividend";

const PAGE_SIZE = 20;

function displayValue(value: string | null | undefined) {
  if (!value) return "--";
  return value;
}

type UserTranslator = (key: string, namespace?: "user" | "common") => string;

function statusText(status: string | null | undefined, t: UserTranslator) {
  const normalized = (status || "").toUpperCase();
  if (normalized === "PENDING") return t("dividendPending", "user");
  if (normalized === "PAID") return t("dividendPaid", "user");
  if (normalized === "FAILED") return t("dividendFailed", "user");
  if (normalized === "CALCULATED") return t("dividendPending", "user");
  return status || "--";
}

function statusClass(status: string | null | undefined) {
  const normalized = (status || "").toUpperCase();
  if (normalized === "PAID") {
    return "border-emerald-400/20 bg-emerald-400/10 text-emerald-300";
  }
  if (normalized === "FAILED") {
    return "border-red-400/20 bg-red-400/10 text-red-300";
  }
  return "border-amber-300/20 bg-amber-300/10 text-amber-200";
}

function SummaryCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-white/[0.03] p-5">
      <div className="text-sm text-white/50">{label}</div>
      <div className="mt-3 break-all text-2xl font-semibold tabular-nums text-white">
        {value}
      </div>
      {hint ? <div className="mt-2 text-xs text-white/40">{hint}</div> : null}
    </div>
  );
}

function RecordsTable({ records, t }: { records: MyDividendRecord[]; t: UserTranslator }) {
  if (records.length === 0) {
    return (
      <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-6 py-12 text-center">
        <div className="text-base font-medium text-white">{t("noDividendRecords", "user")}</div>
        <div className="mt-2 text-sm text-white/45">
          {t("noDividendRecordsDesc", "user")}
        </div>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-2xl border border-white/10">
      <table className="min-w-full divide-y divide-white/10">
        <thead className="bg-white/[0.03]">
          <tr className="text-left text-xs uppercase tracking-[0.14em] text-white/40">
            <th className="px-5 py-4 font-medium">{t("dividendDate", "user")}</th>
            <th className="px-5 py-4 font-medium">{t("svipLevel", "user")}</th>
            <th className="px-5 py-4 font-medium">{t("dividendAmountRcb", "user")}</th>
            <th className="px-5 py-4 font-medium">{t("convertedUsdt", "user")}</th>
            <th className="px-5 py-4 font-medium">{t("status", "user")}</th>
            <th className="px-5 py-4 font-medium">{t("paidAt", "user")}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-white/10 bg-black/10">
          {records.map((item) => (
            <tr key={item.id} className="text-sm text-white/75">
              <td className="whitespace-nowrap px-5 py-4 tabular-nums">
                {displayValue(item.dividend_date)}
              </td>
              <td className="whitespace-nowrap px-5 py-4 font-medium text-white">
                {displayValue(item.svip_level_code)}
              </td>
              <td className="whitespace-nowrap px-5 py-4 font-semibold tabular-nums text-amber-200">
                {displayValue(item.amount_rcb)}
              </td>
              <td className="whitespace-nowrap px-5 py-4 tabular-nums">
                {displayValue(item.amount_usdt)}
              </td>
              <td className="whitespace-nowrap px-5 py-4">
                <span className={`rounded-full border px-2.5 py-1 text-xs ${statusClass(item.status)}`}>
                  {statusText(item.status, t)}
                </span>
              </td>
              <td className="whitespace-nowrap px-5 py-4 tabular-nums text-white/55">
                {displayValue(item.paid_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function UserDividendsPage() {
  const { t } = useLocaleContext();
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [summary, setSummary] = useState<MyDividendSummary | null>(null);
  const [records, setRecords] = useState<MyDividendRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);

  const totalPages = useMemo(() => Math.max(Math.ceil(total / PAGE_SIZE), 1), [total]);

  const loadData = useCallback(async (aliveRef: { alive: boolean }) => {
    setLoading(true);
    setError("");
    try {
      const [summaryData, recordsData] = await Promise.all([
        getMyDividendSummary(),
        getMyDividendRecords(page, PAGE_SIZE),
      ]);
      if (!aliveRef.alive) return;
      setSummary(summaryData);
      setRecords(recordsData.items);
      setTotal(recordsData.total);
    } catch (err) {
      if (!aliveRef.alive) return;
      console.error("Failed to load dividend page:", err);
      setError(t("dividendLoadFailed", "user"));
    } finally {
      if (aliveRef.alive) {
        setLoading(false);
      }
    }
  }, [page, t]);

  useEffect(() => {
    const aliveRef = { alive: true };
    loadData(aliveRef);
    return () => {
      aliveRef.alive = false;
    };
  }, [loadData, reloadKey]);

  const toggleSidebar = () => setIsSidebarCollapsed((value) => !value);

  return (
    <main className="flex min-h-screen bg-[#0a0a0d] py-8">
      <UserSidebar isCollapsed={isSidebarCollapsed} onToggle={toggleSidebar} />

      <div className="w-full px-4 py-10 lg:w-4/5">
        <div className="mx-auto max-w-7xl">
          <div className="mb-8 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
            <div>
              <div className="text-sm font-medium text-amber-300">{t("svipDividend", "user")}</div>
              <h1 className="mt-2 text-3xl font-bold text-white">{t("myDividends", "user")}</h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-white/50">
                {t("myDividendsDesc", "user")}
              </p>
            </div>
            <div
              className={`rounded-full border px-4 py-2 text-sm ${
                summary?.eligible
                  ? "border-emerald-400/20 bg-emerald-400/10 text-emerald-300"
                  : "border-white/10 bg-white/[0.03] text-white/55"
              }`}
            >
              {t("dividendEligibility", "user")}：{summary?.eligible ? t("eligible", "user") : t("notQualifiedYet", "user")}
            </div>
          </div>

          {loading ? (
            <div className="rounded-2xl border border-white/10 bg-white/[0.03] px-6 py-16 text-center text-white/60">
              {t("loadingDividends", "user")}
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-red-400/20 bg-red-400/10 px-6 py-12 text-center">
              <div className="text-base font-semibold text-red-200">{error}</div>
              <button
                type="button"
                onClick={() => setReloadKey((value) => value + 1)}
                className="mt-4 rounded-lg bg-white/10 px-4 py-2 text-sm text-white hover:bg-white/15"
              >
                {t("reload", "asset")}
              </button>
            </div>
          ) : (
            <div className="space-y-6">
              <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                <SummaryCard
                  label={t("totalDividendRcb", "user")}
                  value={displayValue(summary?.total_rcb)}
                  hint={t("totalDividendRcbHint", "user")}
                />
                <SummaryCard
                  label={t("monthlyDividendRcb", "user")}
                  value={displayValue(summary?.month_rcb)}
                  hint={t("monthlyDividendRcbHint", "user")}
                />
                <SummaryCard
                  label={t("latestDividendAmount", "user")}
                  value={displayValue(summary?.latest_amount_rcb)}
                  hint={t("unitRcb", "user")}
                />
                <SummaryCard
                  label={t("latestDividendDate", "user")}
                  value={displayValue(summary?.latest_dividend_date)}
                />
                <SummaryCard
                  label={t("currentSvipLevel", "user")}
                  value={displayValue(summary?.current_svip_level)}
                />
                <SummaryCard
                  label={t("latestStatus", "user")}
                  value={statusText(summary?.latest_status, t)}
                  hint={t("dividendStatusHint", "user")}
                />
              </section>

              <section className="rounded-2xl border border-white/10 bg-[#0f1015] p-5">
                <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                  <div>
                    <h2 className="text-lg font-semibold text-white">{t("dividendRecords", "user")}</h2>
                    <p className="mt-1 text-sm text-white/45">
                      {t("dividendRecordsDesc", "user")}
                    </p>
                  </div>
                  <div className="text-sm text-white/45">
                    {t("totalRecordsPrefix", "asset")} <span className="text-white">{total}</span> {t("totalRecordsSuffix", "asset")}
                  </div>
                </div>

                <RecordsTable records={records} t={t} />

                {total > PAGE_SIZE ? (
                  <div className="mt-5 flex items-center justify-end gap-3">
                    <button
                      type="button"
                      disabled={page <= 1}
                      onClick={() => setPage((value) => Math.max(value - 1, 1))}
                      className="rounded-lg border border-white/10 px-4 py-2 text-sm text-white/70 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {t("prevPage", "asset")}
                    </button>
                    <div className="text-sm text-white/45">
                      {page} / {totalPages}
                    </div>
                    <button
                      type="button"
                      disabled={page >= totalPages}
                      onClick={() => setPage((value) => Math.min(value + 1, totalPages))}
                      className="rounded-lg border border-white/10 px-4 py-2 text-sm text-white/70 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {t("nextPage", "asset")}
                    </button>
                  </div>
                ) : null}
              </section>

              <section className="rounded-2xl border border-amber-300/15 bg-amber-300/[0.04] p-5">
                <h2 className="text-lg font-semibold text-amber-200">{t("rules", "user")}</h2>
                <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                  {[
                    t("dividendRuleSvipOnly", "user"),
                    t("dividendRuleHighestSvip", "user"),
                    t("dividendRuleFunding", "user"),
                    t("dividendRuleActual", "user"),
                  ].map((text) => (
                    <div
                      key={text}
                      className="rounded-xl border border-white/[0.06] bg-white/[0.03] px-4 py-3 text-sm text-white/65"
                    >
                      {text}
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
